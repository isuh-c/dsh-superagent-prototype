import { z } from 'zod'

/** One acceptance criterion of the request, which a completed report must satisfy. */
const AcceptanceSchema = z.object({
  item: z.string().trim().min(1),
  done: z.boolean(),
  evidence: z.string().trim(),
}).strict()

export const CodexReportSchema = z.object({
  status: z.enum(['completed', 'needs_human_input', 'blocked', 'failed']),
  summary: z.string().trim().min(1),
  files_changed: z.array(z.string()),
  checks: z.array(z.object({ command: z.string(), outcome: z.enum(['passed', 'failed', 'not_run']) })),
  acceptance: z.array(AcceptanceSchema),
  remaining: z.array(z.string().trim().min(1)),
  needs_human_input: z.boolean(),
  question: z.string().trim().min(1).nullable(),
  limitations: z.array(z.string()),
}).strict().superRefine((value, context) => {
  const asks = value.status === 'needs_human_input'
  if (asks !== value.needs_human_input || asks !== (value.question !== null)) {
    context.addIssue({ code: 'custom', message: 'needs_human_input status, flag, and question must agree' })
  }
  // 部分完成不能报 completed：避免把"只做了一小块"当成交付。
  if (value.status === 'completed') {
    if (value.remaining.length) context.addIssue({ code: 'custom', message: 'completed requires remaining to be empty' })
    if (value.acceptance.length === 0) context.addIssue({ code: 'custom', message: 'completed requires at least one acceptance item' })
    if (value.acceptance.some(item => !item.done)) context.addIssue({ code: 'custom', message: 'completed requires every acceptance item done' })
  }
})
export type CodexReport = z.infer<typeof CodexReportSchema>

/** JSON Schema passed to codex; Zod remains the host-side authority. */
export const CODEX_REPORT_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'files_changed', 'checks', 'acceptance', 'remaining', 'needs_human_input', 'question', 'limitations'],
  properties: {
    status: { type: 'string', enum: ['completed', 'needs_human_input', 'blocked', 'failed'] },
    summary: { type: 'string', minLength: 1 },
    files_changed: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['command', 'outcome'],
      properties: { command: { type: 'string' }, outcome: { type: 'string', enum: ['passed', 'failed', 'not_run'] } } } },
    acceptance: { type: 'array', description: 'every acceptance criterion from the request and source context; required and all done for completed',
      items: { type: 'object', additionalProperties: false, required: ['item', 'done', 'evidence'],
        properties: { item: { type: 'string', minLength: 1 }, done: { type: 'boolean' }, evidence: { type: 'string' } } } },
    remaining: { type: 'array', description: 'unfinished work; must be empty for completed', items: { type: 'string', minLength: 1 } },
    needs_human_input: { type: 'boolean', description: 'must be true exactly when status is needs_human_input and question is set' },
    question: { type: ['string', 'null'], description: 'the one concrete question for a person; null otherwise' },
    limitations: { type: 'array', items: { type: 'string' } },
  },
} as const

/** 读取并解析 Codex 最终报告；模型可能把 JSON 包在代码围栏或少量前后文字里，这里容错提取后再严格校验。 */
export function parseCodexReport(text: string): CodexReport {
  const trimmed = text.trim()
  const direct = tryParseJson(trimmed)
  if (direct) return CodexReportSchema.parse(direct)
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const candidate = tryParseJson(trimmed.slice(start, end + 1))
    if (candidate) return CodexReportSchema.parse(candidate)
  }
  throw new Error('The final message is not a valid structured report')
}
function tryParseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' ? value : undefined
  } catch { return undefined }
}
