/** 读取 GitLab Issue/MR 的讨论、代码讨论和 CI 状态，供评估与执行器使用。 */
import { z } from 'zod'
import type { GitlabAccount } from '../deployment.ts'
import { GitlabClient } from './gitlab-api.ts'
import { isHumanUser, ItemSchema, NoteSchema, type GitlabItem, type GitlabNote, type ItemKind } from './gitlab-trigger.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'

const pipelinePath = (kind: ItemKind, iid: number): string => `${kind === 'merge' ? 'merge_requests' : 'issues'}/${iid}`
const itemKind = (trigger: { meta: Record<string, unknown> }): ItemKind => trigger.meta.isMr === true ? 'merge' : 'issue'
const account = (deployment: { gitlab?: GitlabAccount }): GitlabAccount => {
  if (!deployment.gitlab) throw new Error('The GitLab Source is not configured')
  return deployment.gitlab
}
const message = (note: GitlabNote, id: string, replyTo?: string): ContextMessage => ({
  id, from: note.author.username, at: note.created_at, text: note.body,
  ...!isHumanUser(note.author) ? { bot: true as const } : {}, ...note.web_url ? { url: note.web_url } : {},
  ...note.position ? { path: note.position.new_path ?? note.position.old_path ?? '', line: note.position.new_line ?? note.position.old_line ?? undefined } : {},
  ...replyTo ? { reply_to: replyTo } : {},
})
const description = (item: GitlabItem, kind: ItemKind): ContextMessage => ({
  id: String(item.iid), from: item.author.username, at: item.created_at, text: `${item.title}\n\n${item.description ?? ''}`,
  ...!isHumanUser(item.author) ? { bot: true as const } : {}, url: item.web_url,
})
async function readItem(client: GitlabClient, kind: ItemKind, iid: number): Promise<GitlabItem> {
  return client.get(ItemSchema, `${pipelinePath(kind, iid)}`)
}
async function readNotes(client: GitlabClient, kind: ItemKind, iid: number, page: number): Promise<{ notes: GitlabNote[]; more: boolean }> {
  const listed = await client.get(z.array(z.unknown()), `${pipelinePath(kind, iid)}/notes`, { page, per_page: 100, sort: 'asc', order_by: 'created_at' })
  const notes = listed.flatMap(value => { const parsed = NoteSchema.safeParse(value); return parsed.success ? [parsed.data] : [] })
  return { notes, more: listed.length === 100 }
}
async function readDiscussions(client: GitlabClient, kind: ItemKind, iid: number): Promise<{ id: string; notes: GitlabNote[] }[]> {
  const listed = await client.pages(z.looseObject({ id: z.string(), notes: z.array(z.unknown()) }), `${pipelinePath(kind, iid)}/discussions`)
  return listed.map(discussion => ({ id: discussion.id, notes: discussion.notes.flatMap(value => {
    const parsed = NoteSchema.safeParse(value); return parsed.success ? [parsed.data] : [] }) }))
}
/** 一页讨论：第一页包含标题与描述，之后是评论分页。 */
export async function conversationPage(client: GitlabClient, kind: ItemKind, iid: number, page: number): Promise<{ messages: ContextMessage[]; more: boolean }> {
  const item = page === 1 ? await readItem(client, kind, iid) : undefined
  const { notes, more } = await readNotes(client, kind, iid, page)
  return { messages: [...item ? [description(item, kind)] : [], ...notes.map(note => message(note, String(note.id)))], more }
}
/** 评估用的 GitLab 线程读取器：代码讨论读所在 discussion，其余读 Issue/MR 对话。 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? trigger.id,
  read: async (commands, trigger, part, cursor) => {
    const deployment = commands.deployment
    const client = new GitlabClient(account(deployment))
    if (typeof trigger.meta.branch === 'string') {
      const body: ContextMessage = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true }
      return { messages: [body], body: { status: 'branch_ci', messages: [body] }, status: 'branch_ci' }
    }
    const kind = itemKind(trigger)
    const iid = Number(trigger.meta.iid)
    if (trigger.meta.kind === 'inline' && typeof trigger.meta.noteId === 'number') {
      const discussions = await readDiscussions(client, kind, iid)
      const found = discussions.find(discussion => discussion.notes.some(note => note.id === trigger.meta.noteId))
      const notes = found?.notes ?? []
      const root = notes[0] ? String(notes[0].id) : undefined
      const messages = notes.map(note => message(note, String(note.id), note.id === notes[0]?.id ? undefined : root))
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'review_thread', messages: read }, status: 'review_thread' }
    }
    const page = Number(cursor ?? '1')
    const body = await conversationPage(client, kind, iid, page)
    return { messages: body.messages, next: body.more ? String(page + 1) : undefined, body }
  },
}
/**
 * 执行器与主会话可读的 GitLab 资源（`gitlab/issues/<iid>`、`gitlab/merge_requests/<iid>`，可追加 `/notes/<page>` 或 `/discussions`）。
 */
export async function readGitlab(deployment: { gitlab?: GitlabAccount }, resource: string, signal?: AbortSignal): Promise<unknown> {
  const client = new GitlabClient(account(deployment), signal)
  const match = /^gitlab\/(issues|merge_requests|merges)\/([1-9]\d*)(?:\/(notes|discussions)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/issues/<iid> or gitlab/merge_requests/<iid>, optionally with /notes/<page> or /discussions')
  const kind: ItemKind = match[1] === 'issues' ? 'issue' : 'merge'
  const iid = Number(match[2])
  if (!match[3]) {
    const item = await readItem(client, kind, iid)
    return { iid: item.iid, title: item.title, state: item.state, ...item.source_branch ? { source_branch: item.source_branch } : {},
      ...item.target_branch ? { target_branch: item.target_branch } : {}, ...item.merged_at ? { merged: true } : {},
      ...description(item, kind) }
  }
  if (match[3] === 'discussions') {
    const discussions = await readDiscussions(client, kind, iid)
    return { discussions: discussions.map(discussion => ({ id: discussion.id, messages: discussion.notes.map(note => message(note, String(note.id))) })) }
  }
  const page = Number(match[4] ?? '1')
  const body = await conversationPage(client, kind, iid, page)
  return { messages: body.messages, ...body.more ? { next_resource: `gitlab/${match[1]}/${iid}/notes/${page + 1}` } : {} }
}
export type { ContextPart }
