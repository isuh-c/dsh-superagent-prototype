/** 把 GitLab 的 Issue、MR 和评论归一化成领域 Trigger。 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
export type ItemKind = 'issue' | 'merge'

/** GitLab 回复地址：Issue/MR 讨论，或 MR 的某条代码讨论。 */
export const gitlabChannel = (iid: number, kind: ItemKind, discussion?: string, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `gitlab:${iid}`, address: { iid: String(iid), kind, ...(discussion ? { discussion } : {}), ...(url ? { url } : {}) } })
export const gitlabPage = (baseUrl: string, project: string, iid: number, kind: ItemKind): string =>
  `${baseUrl}/${project}/-/${kind === 'merge' ? 'merge_requests' : 'issues'}/${iid}`

/** GitLab 用户；`bot` 标记项目访问令牌等非人类账号。 */
export const UserSchema = z.looseObject({ id: z.number().optional(), username: z.string(), name: z.string().nullish(), bot: z.boolean().nullish() })
export type GitlabUser = z.infer<typeof UserSchema>
export const PositionSchema = z.looseObject({ new_path: z.string().nullish(), old_path: z.string().nullish(), new_line: z.number().nullish(), old_line: z.number().nullish() })
/** Issue 或 MR 的公共字段。 */
export const ItemSchema = z.looseObject({
  iid: z.number().int().positive(), title: z.string(), description: z.string().nullish(), state: z.string(),
  author: UserSchema, created_at: z.string(), updated_at: z.string(), web_url: z.string(),
  source_branch: z.string().nullish(), target_branch: z.string().nullish(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  detailed_merge_status: z.string().nullish(), sha: z.string().nullish(),
})
export type GitlabItem = z.infer<typeof ItemSchema>
/** 评论；`system` 标记 GitLab 自动生成的系统消息，`position` 标记代码讨论。 */
export const NoteSchema = z.looseObject({
  id: z.number().int().positive(), body: z.string(), author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(),
  system: z.boolean().optional(), noteable_type: z.string().nullish(), position: PositionSchema.nullish(),
  resolvable: z.boolean().optional(), resolved: z.boolean().optional(), web_url: z.string().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>

/** 项目访问令牌生成的账号用户名形如 `project_95_bot_xxx`。 */
export const isHumanUser = (user: Pick<GitlabUser, 'username' | 'bot'>): boolean =>
  user.bot !== true && !/_bot(_|$)/i.test(user.username)
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9_.@-])@${escapeRegExp(username)}(?![A-Za-z0-9_.-])`, 'i').test(text)
const author = (user: GitlabUser, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanUser(user) && !sameName(user.username, agent) })

/** 新 Issue/MR 的标题与描述；编号在项目内唯一，Thread 直接用 iid。 */
export function itemTrigger(item: GitlabItem, kind: ItemKind, agent: string): Trigger {
  const text = `${item.title}\n\n${item.description ?? ''}`
  return { id: key(`gitlab-${kind}`, String(item.iid)), source: SOURCE, threads: [{ source: SOURCE, id: String(item.iid) }],
    ...author(item.author, agent), at: item.created_at, text,
    ...(mentions(text, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(item.iid, kind, undefined, item.web_url), url: item.web_url,
    meta: { iid: item.iid, isMr: kind === 'merge', kind, author: item.author.username } }
}

/** 一条评论；系统消息不产生 Trigger，代码讨论带文件与行号。 */
export function noteTrigger(item: GitlabItem, kind: ItemKind, note: GitlabNote, agent: string, discussion?: string): Trigger | undefined {
  if (note.system) return undefined
  const place = note.position ? { path: note.position.new_path ?? note.position.old_path ?? undefined, line: note.position.new_line ?? note.position.old_line ?? undefined } : {}
  return { id: key('gitlab-note', String(item.iid), String(note.id), note.updated_at ?? note.created_at), source: SOURCE,
    threads: [{ source: SOURCE, id: String(item.iid) }], ...author(note.author, agent), at: note.updated_at ?? note.created_at, text: note.body,
    ...(mentions(note.body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(item.iid, kind, discussion, note.web_url ?? item.web_url), url: note.web_url ?? item.web_url,
    meta: { iid: item.iid, isMr: kind === 'merge', kind: discussion || note.position ? 'inline' : 'conversation', noteId: note.id,
      ...place.path ? { path: place.path, line: place.line ?? null } : {}, ...discussion ? { discussion } : {} } }
}

/** 默认分支 pipeline 的状态变化；没有可回复的人，因此没有 channel。 */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-ci', `branch:${branch}`, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: `ci:${branch}` }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary, url, meta: { ci: true, branch, sha, revision } }
}
export function mergeCiTrigger(item: GitlabItem, revision: number, summary: string): Trigger {
  return { id: key('gitlab-ci', String(item.iid), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: String(item.iid) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary, channel: gitlabChannel(item.iid, 'merge', undefined, item.web_url),
    url: item.web_url, meta: { iid: item.iid, isMr: true, ci: true, revision } }
}
