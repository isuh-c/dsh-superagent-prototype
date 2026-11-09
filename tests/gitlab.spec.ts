import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Commands } from '../src/infra/commands.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { GitlabClient, GitlabError } from '../src/sources/gitlab-api.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { claimMerge, mergeEndNotices } from '../src/sources/gitlab-pull.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { isHumanUser, itemTrigger, mentions, noteTrigger, SOURCE } from '../src/sources/gitlab-trigger.ts'

const account = { baseUrl: 'http://git.example', projectId: 95, tokenFile: '/token', login: 'project_95_bot', email: 'bot@example', projectPath: 'ai-apps/comfyuiNexus', defaultBranch: 'master' }
const token = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-token-'))
  const file = join(dir, 'token')
  writeFileSync(file, 'secret\n')
  return file
}
const issue = (overrides: Record<string, unknown> = {}) => ({ iid: 7, title: 'Fix the widget', description: 'Hello @project_95_bot, please fix', state: 'opened',
  author: { username: 'alice', name: 'Alice' }, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
  web_url: 'http://git.example/ai-apps/comfyuiNexus/-/issues/7', ...overrides })
const note = (overrides: Record<string, unknown> = {}) => ({ id: 11, body: '@project_95_bot please look', author: { username: 'alice', name: 'Alice' },
  created_at: '2026-09-09T00:01:00Z', ...overrides })

afterEach(() => vi.unstubAllGlobals())

describe('GitLab triggers', () => {
  it('maps an Issue to a gitlab Thread trigger and records a mention in its description', () => {
    const trigger = itemTrigger(issue() as never, 'issue', 'project_95_bot')
    expect(trigger).toMatchObject({ source: SOURCE, threads: [{ source: SOURCE, id: '7' }], addressed: 'mention',
      actor: { source: SOURCE, id: 'alice' }, human: true, meta: { iid: 7, isMr: false, kind: 'issue' } })
    expect(trigger.channel).toMatchObject({ thread: 'gitlab:7', address: { iid: '7', kind: 'issue' } })
  })
  it('skips system notes and keeps a code discussion position', () => {
    expect(noteTrigger(issue() as never, 'issue', note({ system: true }) as never, 'project_95_bot')).toBeUndefined()
    const inline = noteTrigger(issue() as never, 'merge', note({ position: { new_path: 'src/a.ts', new_line: 12 } }) as never, 'project_95_bot', 'disc-1')
    expect(inline).toMatchObject({ meta: { kind: 'inline', path: 'src/a.ts', line: 12, discussion: 'disc-1' }, addressed: 'mention' })
    expect(inline?.channel?.address).toMatchObject({ kind: 'merge', discussion: 'disc-1' })
  })
  it('marks project access token accounts as bots and matches mentions on a boundary', () => {
    expect(isHumanUser({ username: 'project_95_bot_abc', bot: true })).toBe(false)
    expect(isHumanUser({ username: 'alice' })).toBe(true)
    expect(mentions('hi @agent, more', 'agent')).toBe(true)
    expect(mentions('hi @agentx', 'agent')).toBe(false)
  })
  it('scopes receiving by kind flags and exposes the same rows in the Policy table', () => {
    expect(gitlabKind.scope!({ meta: { kind: 'issue' } }, { observeIssues: false } as never)).toEqual({ listened: true, observed: false, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { kind: 'merge' } }, { observeMerges: true } as never)).toEqual({ listened: true, observed: true, row: 'merges' })
    const rows = gitlabKind.policy!.rows!({ observeComments: true })
    expect(rows.map(row => row.id)).toEqual(['issues', 'merges', 'comments', 'ci'])
    expect(rows.find(row => row.id === 'comments')!.note).toEqual({ zh: '全部', en: 'All' })
  })
})

describe('GitLab API and channel', () => {
  it('restricts paths to the configured project and paginates with x-next-page', async () => {
    const client = new GitlabClient({ ...account, tokenFile: token() })
    expect(() => (client as unknown as { path(path: string): string }).path('../users')).toThrow('restricted')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: URL) => {
      calls.push(String(url))
      const page = url.searchParams.get('page')
      return new Response(JSON.stringify(page === '1' ? [{ iid: 1 }] : [{ iid: 2 }]), { status: 200, headers: { 'x-next-page': page === '1' ? '2' : '' } })
    })
    const items = await client.pages(z.object({ iid: z.number() }), 'issues')
    expect(items.map(item => item.iid)).toEqual([1, 2])
    expect(calls[0]).toContain('/api/v4/projects/95/issues')
  })
  it('reports the HTTP status without echoing the token', async () => {
    const file = token()
    const client = new GitlabClient({ ...account, tokenFile: file })
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
    await expect(client.get(z.unknown(), 'issues/1')).rejects.toMatchObject({ status: 404 })
    await expect(client.get(z.unknown(), 'issues/1')).rejects.not.toThrow('secret')
  })
  it('reconciles a retried reply with its stable marker and posts only once otherwise', async () => {
    const commands = { deployment: { gitlab: { ...account, tokenFile: token() } } } as unknown as Commands
    const requests: { method?: string; body?: string }[] = []
    vi.stubGlobal('fetch', async (_url: URL, init?: RequestInit) => {
      requests.push({ method: init?.method, body: init?.body as string | undefined })
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([{ id: 1, body: '<!-- dsh-superagent:r1 -->', author: { username: 'project_95_bot' }, created_at: '2026-09-09T00:00:00Z' }]), { status: 200 })
      return new Response('{}', { status: 201 })
    })
    const message = { id: 'r1', channel: { source: SOURCE, thread: 'gitlab:7', address: { iid: '7', kind: 'issue' } }, text: 'Done', kind: 'reply' as const }
    expect(await sendGitlab({ commands }, message)).toBe('sent')
    expect(requests.some(request => request.method === 'POST')).toBe(false)
    requests.length = 0
    vi.stubGlobal('fetch', async (_url: URL, init?: RequestInit) => {
      requests.push({ method: init?.method, body: init?.body as string | undefined })
      return (init?.method ?? 'GET') === 'GET' ? new Response('[]', { status: 200 }) : new Response('{}', { status: 201 })
    })
    expect(await sendGitlab({ commands }, message)).toBe('sent')
    expect(requests.find(request => request.method === 'POST')?.body).toContain('<!-- dsh-superagent:r1 -->')
  })
})

describe('GitLab merge request binding', () => {
  const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't1', title: 'Fix', decisionId: 'd1', channels: [], inputs: [], undelivered: [], mandate: { strength: 'explicit',
    policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: SOURCE, id: 'alice' }, scope: 'x' }, assignments: [],
    createdAt: '', updatedAt: '', origin: { triggerId: 'trigger-1', triggerIds: [] }, execution: { name: 't1', directory: '/w', assignment: '' },
    ...overrides })
  const merge = (overrides: Record<string, unknown> = {}) => ({ iid: 7, title: 'Fix', description: '', state: 'opened', author: { username: 'project_95_bot' },
    created_at: '', updated_at: '', web_url: 'http://git.example/mr/7', source_branch: 'agent/t1', target_branch: 'master', ...overrides })
  const context = (store: Ticket) => {
    const bound: unknown[] = []
    return { bound, ctx: { deployment: { gitlab: account, repository: 'ai-apps/comfyuiNexus' }, tickets: { get: () => store, open: () => [store], bindThread: (...args: unknown[]) => bound.push(args) },
      triggers: { get: () => undefined }, threads: { patch: () => {} }, atomic: (work: () => void) => work() } as unknown as SourceContext }
  }
  it('binds an open merge request from the ticket branch and rejects one from another branch', () => {
    const store = ticket()
    const { ctx, bound } = context(store)
    expect(claimMerge(ctx, 't1', merge() as never)).toBeUndefined()
    expect(bound).toEqual([['t1', { source: SOURCE, id: '7' }, true]])
    expect(claimMerge(ctx, 't1', merge({ source_branch: 'feature/other' }) as never)).toContain('MR does not belong to this ticket')
  })
  it('formats the terminal notice for other channels only', () => {
    const ended = ticket({ ended: { at: '', by: 'executor', outcome: 'merged' }, follows: [{ thread: 'gitlab:7', own: true, closed: { at: '2026-09-09T00:00:00Z', outcome: 'merged' } }],
      channels: [{ source: 'feishu', thread: 'feishu:oc:1', address: { chat: 'oc' } }, { source: SOURCE, thread: 'gitlab:7', address: { iid: '7', kind: 'merge' } }] })
    const notices = mergeEndNotices(ended, '合并这个 MR', account.baseUrl, account.projectPath)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toContain('已合并')
  })
})

describe('GitLab API errors', () => {
  it('carries the status for callers to distinguish gone from retryable', () => {
    expect(new GitlabError('x', 404).status).toBe(404)
  })
})
