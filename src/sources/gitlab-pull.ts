/** MR（GitLab 合并请求）绑定、生命周期观察与结束通知。 */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GitlabClient } from './gitlab-api.ts'
import { gitlabPage, ItemSchema, SOURCE, type GitlabItem } from './gitlab-trigger.ts'
import type { SourceContext } from './host.ts'

const PipelineSchema = z.looseObject({ id: z.number(), status: z.string(), sha: z.string().nullish(), web_url: z.string().nullish() })
const MergeSchema = ItemSchema.extend({ head_pipeline: PipelineSchema.nullish(), merge_when_pipeline_succeeds: z.boolean().nullish() })
export type Merge = z.infer<typeof MergeSchema>
const threadOf = (iid: number): string => `${SOURCE}:${iid}`
const iidOf = (thread: string): number | undefined => thread.startsWith(`${SOURCE}:`) ? Number(thread.slice(SOURCE.length + 1)) || undefined : undefined

export async function readMerge(ctx: SourceContext, iid: number): Promise<Merge> {
  const account = ctx.deployment.gitlab
  if (!account) throw new Error('The GitLab Source is not configured')
  return new GitlabClient(account).get(MergeSchema, `merge_requests/${iid}`)
}
/** 工单跟随的 MR iid；`open` 只返回仍开启的。 */
export const mrsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => iidOf(item.thread) ?? [])
export const mergeOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1)
/** 分支最后一段等于工单短名时，视为该工单的分支（例如 agent/<name>）。 */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const agentMerge = (merge: { author: { username: string } }, ctx: SourceContext): boolean =>
  !!ctx.deployment.gitlab && sameName(merge.author.username, ctx.deployment.gitlab.login)

/**
 * 当一个开启的 MR 是工单的来源 MR，或由智能体从工单分支创建时，把它绑定到工单；
 * 同一 MR 只能属于一个开启的工单。返回拒绝原因，或在已绑定/无需绑定时返回 undefined。
 */
export function claimMerge(ctx: SourceContext, ticketId: string, merge: Merge): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  const started = origin?.source === SOURCE && origin.meta.isMr === true && origin.meta.iid === merge.iid
  const opened = agentMerge(merge, ctx) && ticketBranch(ticket, merge.source_branch ?? '')
  if (!started && !opened) {
    const login = ctx.deployment.gitlab?.login ?? 'the agent account'
    return `MR does not belong to this ticket: use the source MR or an MR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mrsOf(item, true).includes(merge.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === threadOf(merge.iid))
  if (merge.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, merge, opened)
  return undefined
}
/** 观察已绑定 MR 的开启/合并/关闭状态；结束时让核心结束工单。 */
export async function observeMerge(ctx: SourceContext, merge: Merge): Promise<boolean> {
  const ended = merge.state === 'merged' || merge.state === 'closed' || !!merge.merged_at
  if (ended) closeMerge(ctx, merge)
  else {
    const candidates = agentMerge(merge, ctx) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, merge.source_branch ?? '')) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const reopened = ticket?.follows?.some(item => item.thread === threadOf(merge.iid) && item.closed)
    if (ticket && (reopened || mrsOf(ticket, true).every(iid => iid === merge.iid))) claimMerge(ctx, ticket.id, merge)
  }
  ctx.threads.describe(threadOf(merge.iid), { facts: {} })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, merge: Merge, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: String(merge.iid) }, own)
    ctx.threads.patch(threadOf(merge.iid), { iid: merge.iid, isMr: true, url: merge.web_url, author: merge.author.username })
  })
}
function closeMerge(ctx: SourceContext, merge: Merge): void {
  if (!ctx.tickets.open().some(ticket => mrsOf(ticket, true).includes(merge.iid))) return
  const at = merge.merged_at ?? merge.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: String(merge.iid) }, merge.state === 'merged' ? 'merged' : 'closed', at)
}
/** 工单随 MR 结束时，为其他 IM 渠道生成一次性通知；GitLab 自身的讨论已显示合并/关闭，因此跳过。 */
export function mergeEndNotices(ticket: Ticket, request: string, baseUrl: string, project: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && iidOf(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = iidOf(follow.thread)!
  const url = gitlabPage(baseUrl, project, iid, 'merge')
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('gitlab-mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome!), channel, text, kind: 'notice', ticketId: ticket.id }))
}
