import { describe, expect, it } from 'vitest'
import { CodexReportSchema } from '../src/executor/codex-report.ts'
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

describe('codexArguments', () => {
  it('uses the cached login without requiring a profile', () => {
    const args = codexArguments({ codexAuthMode: 'login', codexProfile: 'ignored' }, '/work', '/schema', '/report')
    expect(args).not.toContain('--profile')
    expect(args).toContain('workspace-write')
  })

  it('pins the company profile for initial and resumed provider turns', () => {
    const machine = { codexAuthMode: 'provider' as const, codexProfile: 'company-superagent' }
    for (const args of [codexArguments(machine, '/work', '/schema', '/report'),
      codexArguments(machine, '/work', '/schema', '/report', 'session-1')]) {
      expect(args.slice(args.indexOf('--profile'), args.indexOf('--profile') + 2)).toEqual(['--profile', 'company-superagent'])
    }
  })
})
