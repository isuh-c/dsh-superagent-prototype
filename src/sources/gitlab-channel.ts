/** GitLab 出站适配器：向 Issue/MR 讨论或代码讨论回帖，并用 HTML 标记保证重试幂等。 */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GitlabClient, GitlabError } from './gitlab-api.ts'
import { NoteSchema, SOURCE } from './gitlab-trigger.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** 目标已删除（404）或对话锁定（403 且带 locked）时视为永久不可达，其余错误可重试。 */
const gone = (error: unknown): boolean => error instanceof GitlabError
  && (error.status === 404 || error.status === 410 || (error.status === 403 && /locked/i.test(error.message)))
const base = (kind: string, iid: number): string => `${kind === 'merge' ? 'merge_requests' : 'issues'}/${iid}`
function notesPath(kind: string, iid: number, discussion?: string): string {
  return discussion ? `${base(kind, iid)}/discussions/${discussion}/notes` : `${base(kind, iid)}/notes`
}
/** 在 Issue/MR 下发表评论；同一 `message.id` 已存在时不再重复发送。 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const account = host.commands.deployment.gitlab
  if (!account) throw new Error('The GitLab Source is not configured')
  const client = new GitlabClient(account)
  const iid = Number(message.channel.address.iid)
  const kind = message.channel.address.kind === 'merge' ? 'merge' : 'issue'
  const discussion = message.channel.address.discussion
  if (!iid) throw new Error('Missing GitLab reply target')
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const notes = await client.pages(NoteSchema, notesPath(kind, iid, discussion))
    if (notes.some(note => sameName(note.author.username, account.login) && note.body.includes(marker))) return 'sent'
    await client.post(z.unknown(), notesPath(kind, iid, discussion), { body: `${message.text}\n\n${marker}` })
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const iid = address.iid ?? ''
  const discussion = address.discussion
  return { url: address.url ?? '', label: discussion ? { zh: `GitLab !${iid} 的代码讨论`, en: `Code discussion on GitLab !${iid}` }
    : { zh: `GitLab !${iid}`, en: `GitLab !${iid}` } }
}
export { SOURCE }
