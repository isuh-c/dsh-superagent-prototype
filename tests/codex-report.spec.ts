import { describe, expect, it } from 'vitest'
import { CodexReportSchema, parseCodexReport } from '../src/executor/codex-report.ts'
import { codexArguments } from '../src/executor/codex-exec.ts'

const report = {
  status: 'completed', summary: 'Implemented the requested change.', files_changed: ['src/index.ts'],
  checks: [{ command: 'pnpm test', outcome: 'passed' }], needs_human_input: false, question: null, limitations: [],
}

describe('CodexReportSchema', () => {
  it('accepts a completed structured report', () => {
    expect(CodexReportSchema.parse(report)).toEqual(report)
  })

  it('requires a concrete question only for human-input reports', () => {
    expect(CodexReportSchema.safeParse({ ...report, status: 'needs_human_input', needs_human_input: true, question: null }).success).toBe(false)
    expect(CodexReportSchema.safeParse({ ...report, needs_human_input: false, question: 'Choose a database.' }).success).toBe(false)
  })

  it('rejects extra fields', () => {
    expect(CodexReportSchema.safeParse({ ...report, provider_error: 'secret response' }).success).toBe(false)
  })
})

describe('parseCodexReport', () => {
  it('accepts a bare JSON report and one wrapped in a code fence with prose', () => {
    expect(parseCodexReport(JSON.stringify(report))).toEqual(report)
    expect(parseCodexReport('Here is the report:\n```json\n' + JSON.stringify(report) + '\n```')).toEqual(report)
  })
  it('still rejects a report that violates the schema', () => {
    expect(() => parseCodexReport('{"status":"completed","summary":"x"}')).toThrow()
  })
})

describe('codexArguments', () => {
  it('uses the cached login without requiring a profile', () => {
    const args = codexArguments({ codexAuthMode: 'login', codexProfile: 'ignored' }, '/work', '/schema', '/report')
    expect(args).not.toContain('--profile')
    expect(args).toContain('workspace-write')
    // 网关对结构化输出约束会让模型跳过工具循环，所以不能传 --output-schema。
    expect(args).not.toContain('--output-schema')
  })

  it('pins the company profile for initial and resumed provider turns', () => {
    const machine = { codexAuthMode: 'provider' as const, codexProfile: 'company-superagent' }
    for (const args of [codexArguments(machine, '/work', '/schema', '/report'),
      codexArguments(machine, '/work', '/schema', '/report', 'session-1')]) {
      expect(args.slice(args.indexOf('--profile'), args.indexOf('--profile') + 2)).toEqual(['--profile', 'company-superagent'])
    }
  })
})
