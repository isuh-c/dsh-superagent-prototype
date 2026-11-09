/** GitLab Source：轮询 Issue/MR/评论/pipeline，归一化成 Trigger，并观察 MR 生命周期。 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitlabAccountsSchema, type GitlabAccount } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { GitlabClient } from './gitlab-api.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { mrsOf, observeMerge, readMerge, type Merge } from './gitlab-pull.ts'
import { branchCiTrigger, isHumanUser, ItemSchema, itemTrigger, mentions, mergeCiTrigger, NoteSchema, noteTrigger, SOURCE,
  type GitlabItem, type GitlabNote, type ItemKind } from './gitlab-trigger.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, POLL_HORIZON_MS } from './poll.ts'

const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observeMerges: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', merges: 'observeMerges', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'merge') return 'merges'
  return meta.kind === 'conversation' || meta.kind === 'inline' ? 'comments' : undefined
}
const itemPath = (kind: ItemKind, iid: number): string => `${kind === 'merge' ? 'merge_requests' : 'issues'}/${iid}`
const accountOf = (deployment: SourceContext['deployment']): GitlabAccount => {
  const account = deployment.gitlab
  if (!account) throw new Error('The GitLab Source is not configured')
  return account
}
const pollFailure = (failures: number, threshold: number, error: unknown): Health | undefined =>
  failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined

const fields: SourceKind<GitlabConfig>['fields'] = [
  { key: 'baseUrl', type: 'text', label: { zh: 'GitLab 地址', en: 'GitLab base URL' },
    hint: { zh: '例如 http://10.10.250.218。保存时校验令牌与项目权限，然后重启 dsh-superagent。', en: 'For example http://10.10.250.218. Saving checks the token and project access, then restarts dsh-superagent.' } },
  { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的项目', en: 'Project' },
    hint: { zh: '写作 group/project，例如 ai-apps/comfyuiNexus。', en: 'Written group/project, such as ai-apps/comfyuiNexus.' } },
  { key: 'tokenFile', type: 'text', label: { zh: '项目访问令牌文件', en: 'Project access token file' },
    hint: { zh: '存放 Project Access Token 的绝对路径（权限 600）。令牌只从文件读取，不写入配置或仓库。', en: 'Absolute path of the Project Access Token file (mode 600). The token is read from the file and never stored in configuration or the repository.' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
  { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' } },
  { key: 'observeMerges', type: 'switch', label: { zh: '接收项目里的新 MR', en: 'Receive new merge requests in the project' } },
  { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' } },
  { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 pipeline', en: 'Receive the default branch pipeline' } },
]

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 项目访问令牌；接收项目里发给它的 Issue、MR、评论和 pipeline 状态。',
    en: 'The agent\'s GitLab project access token; receives Issues, merge requests, comments and pipeline changes addressed to it.' },
  schema: GitlabConfigSchema,
  fields,
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const number = (/^#?(\d+)$/.exec(query.trim()) ?? /\/(?:issues|merge_requests)\/(\d+)\b/.exec(query))?.[1]
    return { threads: number ? [`${SOURCE}:${number}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined): Localized => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('merges', { zh: '新 MR', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        { id: 'ci', label: { zh: '默认分支 pipeline', en: 'Default branch pipeline' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_BASE_URL', description: { zh: 'GitLab 地址，例如 http://10.10.250.218', en: 'GitLab base URL, such as http://10.10.250.218' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目 group/project；智能体在这里开的 MR，源分支最后一段是 DSH_SUPERAGENT_NAME 时会关联到工单', en: 'The project this Source watches, group/project. An MR opened from a branch whose last path segment is DSH_SUPERAGENT_NAME binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；git push 用凭据助手，创建/查看 MR 用 gitlab-mr，不用其他账号', en: 'The agent\'s GitLab account. Push with the credential helper and use gitlab-mr for merge requests; never another account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NUMBER', description: { zh: '接下工单的 Issue 或 MR 编号；不是从 GitLab 来的时为空', en: 'IID of the Issue or MR that started the ticket; empty when it did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的 MR 的源引用 refs/merge-requests/<编号>/head；不是 MR 时为空', en: 'Source ref refs/merge-requests/<iid>/head of the MR that started the ticket; empty when it was not an MR' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitlab = deployment.gitlab
      const iid = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.iid) || 0 : 0
      return { DSH_SUPERAGENT_GITLAB_BASE_URL: gitlab?.baseUrl ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: gitlab?.projectPath ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.email ?? '',
        DSH_SUPERAGENT_GITLAB_NUMBER: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: iid && trigger?.meta.isMr === true ? `refs/merge-requests/${iid}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    tokenFile: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, config, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

/** 拉取自游标以来更新的 Issue/MR 与其评论，再观察已绑定 MR 和 pipeline；返回本轮使用的间隔。 */
async function pollRound(ctx: SourceContext, config: GitlabConfig, signal: AbortSignal): Promise<number> {
  const account = accountOf(ctx.deployment)
  const client = new GitlabClient(account, signal)
  const now = new Date().toISOString()
  const horizon = Math.floor((Date.parse(now) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const stored = ctx.state.get(KV.gitlab.since)
  const since = new Date(Math.max(Date.parse(stored?.since ?? now), horizon)).toISOString()
  const started = { issues: stored?.started.issues ?? now, merges: stored?.started.merges ?? now }
  const login = account.login
  let newest = Date.parse(since)
  const read = async (kind: ItemKind, item: GitlabItem): Promise<void> => {
    const fresh = Date.parse(item.created_at) >= Date.parse(kind === 'issue' ? started.issues : started.merges)
    const subscribed = (ctx.threads.get(`${SOURCE}:${item.iid}`)?.subscriptions.length ?? 0) > 0
    const observed = kind === 'issue' ? config.observeIssues : config.observeMerges
    const addressed = mentions(`${item.title}\n\n${item.description ?? ''}`, login)
    if (fresh && !sameName(item.author.username, login) && isHumanUser(item.author) && (observed || addressed)) await ctx.receive(itemTrigger(item, kind, login))
    for (const { note, discussion } of await notesOf(client, kind, item.iid, since)) {
      if (note.system || sameName(note.author.username, login)) continue
      const trigger = noteTrigger(item, kind, note, login, discussion)
      if (!trigger || (!trigger.addressed && !config.observeComments && !subscribed)) continue
      await ctx.receive(trigger)
      newest = Math.max(newest, Date.parse(note.created_at))
    }
  }
  const issues = await client.pages(ItemSchema, 'issues', { state: 'all', updated_after: since, order_by: 'updated_at', sort: 'asc' })
  for (const item of issues) { if (signal.aborted) return config.pollSeconds; await read('issue', item); newest = Math.max(newest, Date.parse(item.updated_at)) }
  const merges = await client.pages(ItemSchema, 'merge_requests', { state: 'all', updated_after: since, order_by: 'updated_at', sort: 'asc' })
  for (const item of merges) { if (signal.aborted) return config.pollSeconds; await read('merge', item); newest = Math.max(newest, Date.parse(item.updated_at)) }
  for (const iid of new Set(ctx.tickets.open().flatMap(ticket => mrsOf(ticket, true)))) await observeMerge(ctx, await readMerge(ctx, iid))
  if (config.observeCi) await pollCi(ctx, client, config)
  const moved = cursorAt(new Date(newest).toISOString())
  ctx.state.set(KV.gitlab.since, { since: Date.parse(moved) > Date.parse(since) ? moved : since, started })
  ctx.report('gitlab', { state: 'ready', detail: `${issues.length} Issues and ${merges.length} MRs updated; next poll ≥ ${config.pollSeconds}s`, at: now })
  return config.pollSeconds
}

/** 读取 Issue 评论或 MR 的各 discussion 评论，保留 discussion id 以定位代码讨论。 */
async function notesOf(client: GitlabClient, kind: ItemKind, iid: number, since: string): Promise<{ note: GitlabNote; discussion?: string }[]> {
  if (kind === 'issue') {
    return (await client.pages(NoteSchema, `${itemPath(kind, iid)}/notes`, { created_after: since, sort: 'asc', order_by: 'created_at' }))
      .map(note => ({ note }))
  }
  const discussions = await client.pages(z.looseObject({ id: z.string(), notes: z.array(z.unknown()) }), `${itemPath(kind, iid)}/discussions`)
  return discussions.flatMap(discussion => discussion.notes.flatMap(value => {
    const parsed = NoteSchema.safeParse(value)
    return parsed.success ? [{ note: parsed.data, discussion: discussion.id }] : []
  })).filter(({ note }) => Date.parse(note.created_at) >= Date.parse(since))
}

/** 默认分支与已绑定 MR 的 pipeline 状态变化。 */
async function pollCi(ctx: SourceContext, client: GitlabClient, config: GitlabConfig): Promise<void> {
  const project = await client.get(z.looseObject({ default_branch: z.string().nullish() }), '')
  const branch = project.default_branch ?? ctx.deployment.gitlab?.defaultBranch ?? 'main'
  const pipelines = await client.get(z.array(z.looseObject({ id: z.number(), status: z.string(), sha: z.string().nullish(), web_url: z.string().nullish() })),
    'pipelines', { ref: branch, per_page: 1 })
  const pipeline = pipelines[0]
  if (pipeline) {
    const failed = ['failed', 'canceled'].includes(pipeline.status)
    const previous = ctx.state.get(KV.gitlab.branchCi)
    if (previous?.branch === branch && previous.failed !== failed) {
      const revision = previous.revision + 1
      const summary = `Pipeline ${failed ? 'failed' : 'recovered'} on ${branch} at ${(pipeline.sha ?? '').slice(0, 7)} (${pipeline.status})`
      await ctx.receive(branchCiTrigger(branch, pipeline.sha ?? '', revision, summary, pipeline.web_url ?? ''))
      ctx.state.set(KV.gitlab.branchCi, { branch, failed, revision })
    } else if (previous?.branch !== branch) ctx.state.set(KV.gitlab.branchCi, { branch, failed, revision: previous?.revision ?? 0 })
  }
  for (const iid of new Set(ctx.tickets.open().flatMap(ticket => mrsOf(ticket, true)))) {
    const merge: Merge = await readMerge(ctx, iid)
    const status = merge.head_pipeline?.status
    const previous = ctx.state.get(KV.gitlab.ci(iid))
    if (!status) continue
    const terminal = ['failed', 'canceled', 'success'].includes(status)
    if (previous?.status && previous.status !== status && terminal) {
      const revision = previous.revision + 1
      const summary = `Pipeline ${status} on MR !${iid} at ${(merge.head_pipeline?.sha ?? '').slice(0, 7)}`
      await ctx.receive(mergeCiTrigger(merge, revision, summary))
      ctx.state.set(KV.gitlab.ci(iid), { status, revision })
    } else if (!previous) ctx.state.set(KV.gitlab.ci(iid), { status, revision: 0 })
  }
  void config
}
