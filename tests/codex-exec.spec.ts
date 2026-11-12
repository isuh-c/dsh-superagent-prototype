import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Assignment, Ticket, Trigger } from '../src/core/index.ts'
import { CodexExecExecutor, prepared, type CodexExecutorHost, type CodexMachine, type CodexSourceRoot } from '../src/executor/codex-exec.ts'
import type { CodexReport } from '../src/executor/codex-report.ts'
import { testMachine } from './fixtures/deployment.ts'

const roots: string[] = []
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codex-exec-'))
  roots.push(directory)
  return directory
}
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('prepared', () => {
  // 回归：每个 assignment 都重跑 prepare 会重建 worktree，把上一轮未提交的改动删掉。
  it('treats an existing ticket directory as already prepared', async () => {
    const directory = join(root(), 'ticket')
    mkdirSync(directory)
    expect(await prepared(directory)).toBe(true)
  })

  it('prepares a ticket directory that does not exist yet', async () => {
    expect(await prepared(join(root(), 'ticket'))).toBe(false)
  })
})

describe('turn', () => {
  // 回归：复用已存在的工单目录时不再跑 prepare，但每次 turn 仍要校验仓库本地 git 配置。
  it('verifies a reused ticket directory before spawning Codex', async () => {
    const stateDir = root()
    const directory = join(stateDir, 'ticket')
    mkdirSync(directory)
    execFileSync('git', ['init', '-q'], { cwd: directory })
    execFileSync('git', ['config', 'http.https://git.example/.extraheader', 'Authorization: basic x'], { cwd: directory })

    const globalConfig = join(root(), 'gitconfig')
    writeFileSync(globalConfig, '')
    const subprocess = {
      spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' } })
        const output = { stdout: '', stderr: '' }
        child.stdout.on('data', chunk => { output.stdout += String(chunk) })
        child.stderr.on('data', chunk => { output.stderr += String(chunk) })
        const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
        const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
        return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
      },
    } as unknown as SubprocessRuntime

    const machine = { ...testMachine({ stateDir }), executorBackend: 'codex-exec', codexAuthMode: 'login', codexCommand: '/bin/true',
      codexHome: join(stateDir, 'codex-home'), codexProfile: 'unused', codexApiKeyEnv: 'UNUSED_KEY', codexTimeoutMs: 5000 } as CodexMachine
    const host = { machine, context: { subprocess }, effects: { handle: vi.fn(), enqueue: vi.fn() },
      store: { get: vi.fn(), set: vi.fn(), settings: vi.fn() }, engine: { assignmentStarted: vi.fn(), report: vi.fn() },
      sessions: { relay: vi.fn() }, lifetime: new AbortController().signal, closing: () => false, paused: () => false,
      environment: () => [], sourceRoot: vi.fn(async () => undefined) } as unknown as CodexExecutorHost
    const executor = new CodexExecExecutor(host)
    const ticket = { id: 'ticket-1', execution: { directory } } as unknown as Ticket
    const assignment = { id: 'assignment-1' } as unknown as Assignment
    const turn = (executor as unknown as { turn: (ticket: Ticket, assignment: Assignment, prompt: string, inputIds: string[]) => Promise<void> }).turn
      .bind(executor)
    await expect(turn(ticket, assignment, 'prompt', [])).rejects.toThrow('sets http.https://git.example/.extraheader')
  })
})

describe('initialPrompt', () => {
  // 回归：触发工单的评论不等于完整需求，prompt 必须带上线程根消息和源 CLI 说明。
  it('includes the thread root, source identifiers and acceptance instructions for a comment trigger', async () => {
    const stateDir = root()
    const trigger = { id: 'trigger-1', source: 'gitlab', threads: [{ source: 'gitlab', id: '33' }],
      actor: { source: 'gitlab', id: 'heqi' }, human: true, at: '2026-11-10T00:00:00Z', text: '参考其他 219 平台调用案例', url: 'http://gitlab/issues/33#note_1',
      meta: { iid: 33, kind: 'conversation' } } as unknown as Trigger
    const sourceRoot = vi.fn(async (): Promise<CodexSourceRoot> => ({ source: 'gitlab', id: '33', from: 'heqi', at: '2026-11-09T00:00:00Z',
      text: 'TTS / Agent 媒体链路迁移\n\n## 验收\n- tts_synthesize 走 219' }))
    const machine = { ...testMachine({ stateDir }), executorBackend: 'codex-exec', codexAuthMode: 'login', codexCommand: '/bin/true',
      codexHome: join(stateDir, 'codex-home'), codexProfile: 'unused', codexApiKeyEnv: 'UNUSED_KEY', codexTimeoutMs: 5000 } as CodexMachine
    const host = { machine, context: { subprocess: {} as SubprocessRuntime }, effects: { handle: vi.fn(), enqueue: vi.fn() },
      store: { get: vi.fn(), set: vi.fn(), settings: vi.fn(), triggers: { get: (id: string) => id === trigger.id ? trigger : undefined } },
      engine: { assignmentStarted: vi.fn(), report: vi.fn() }, sessions: { relay: vi.fn() },
      lifetime: new AbortController().signal, closing: () => false, paused: () => false, environment: () => [], sourceRoot } as unknown as CodexExecutorHost
    const executor = new CodexExecExecutor(host)
    const ticket = { id: 'ticket-1', title: 'TTS 迁移', origin: { triggerId: trigger.id }, mandate: {}, execution: { assignment: '迁移' } } as unknown as Ticket
    const assignment = { id: 'assignment-1' } as unknown as Assignment
    const initialPrompt = (executor as unknown as { initialPrompt: (ticket: Ticket, assignment: Assignment) => Promise<string> }).initialPrompt
      .bind(executor)
    const prompt = JSON.parse(await initialPrompt(ticket, assignment)) as { source: { name: string; thread: string }; source_context: { text: string }; instructions: string[] }
    expect(prompt.source).toMatchObject({ name: 'gitlab', thread: '33' })
    expect(prompt.source_context.text).toContain('tts_synthesize')
    const instructions = prompt.instructions.join('\n')
    expect(instructions).toContain('gitlab-mr issue')
    expect(instructions).toContain('remaining')
    // 无 attention 时不注入"问题未答"提示，避免把 launch 提示错装到正常启动上。
    expect(instructions).not.toContain('has no answer yet')
  })

  // 回归：retry 唤起的 resume 带着没人回答的老问题时，codex 会立即再报一次提问、空转一个 turn；
  // prompt 必须明确告知老问题未答、不要重复提问。
  it('warns codex not to repeat an unanswered question when the ticket has attention', async () => {
    const stateDir = root()
    const trigger = { id: 'trigger-1', source: 'gitlab', threads: [{ source: 'gitlab', id: '33' }],
      actor: { source: 'gitlab', id: 'heqi' }, human: true, at: '2026-11-10T00:00:00Z', text: '继续',
      meta: { iid: 33, kind: 'conversation' } } as unknown as Trigger
    const machine = { ...testMachine({ stateDir }), executorBackend: 'codex-exec', codexAuthMode: 'login', codexCommand: '/bin/true',
      codexHome: join(stateDir, 'codex-home'), codexProfile: 'unused', codexApiKeyEnv: 'UNUSED_KEY', codexTimeoutMs: 5000 } as CodexMachine
    const host = { machine, context: { subprocess: {} as SubprocessRuntime }, effects: { handle: vi.fn(), enqueue: vi.fn() },
      store: { get: vi.fn(), set: vi.fn(), settings: vi.fn(), triggers: { get: (id: string) => id === trigger.id ? trigger : undefined } },
      engine: { assignmentStarted: vi.fn(), report: vi.fn() }, sessions: { relay: vi.fn() },
      lifetime: new AbortController().signal, closing: () => false, paused: () => false, environment: () => [], sourceRoot: vi.fn(async () => undefined) } as unknown as CodexExecutorHost
    const executor = new CodexExecExecutor(host)
    const ticket = { id: 'ticket-1', title: 'T', origin: { triggerId: trigger.id }, mandate: {}, execution: { assignment: '继续' },
      attention: { id: 'attention-1', question: '用哪个模型网关？' } } as unknown as Ticket
    const assignment = { id: 'assignment-2' } as unknown as Assignment
    const initialPrompt = (executor as unknown as { initialPrompt: (ticket: Ticket, assignment: Assignment) => Promise<string> }).initialPrompt
      .bind(executor)
    const prompt = JSON.parse(await initialPrompt(ticket, assignment)) as { instructions: string[] }
    const instructions = prompt.instructions.join('\n')
    expect(instructions).toContain('has no answer yet')
    expect(instructions).toContain('用哪个模型网关？')
  })
})

describe('record', () => {
  const reportOf = (status: CodexReport['status']): CodexReport => ({ status, summary: '进度', files_changed: [], checks: [],
    acceptance: [], remaining: [], needs_human_input: status === 'needs_human_input',
    question: status === 'needs_human_input' ? '用哪个模型网关？' : null, limitations: [] })
  const executorFor = () => {
    const stateDir = root()
    const machine = { ...testMachine({ stateDir }), executorBackend: 'codex-exec', codexAuthMode: 'login', codexCommand: '/bin/true',
      codexHome: join(stateDir, 'codex-home'), codexProfile: 'unused', codexApiKeyEnv: 'UNUSED_KEY', codexTimeoutMs: 5000 } as CodexMachine
    const relayed: string[] = []
    const ticket = { id: 'ticket-1', title: 'T', updatedAt: '2026-11-11T00:00:00Z', origin: { triggerId: 'trigger-1' },
      mandate: { strength: 'explicit' }, undelivered: [],
      attention: { id: 'attention-1', question: '用哪个模型网关？' }, channels: [], inputs: [], assignments: [] } as unknown as Ticket
    const host = { machine, context: { subprocess: {} as SubprocessRuntime }, effects: { handle: vi.fn(), enqueue: vi.fn() },
      store: { get: vi.fn(), set: vi.fn(), settings: vi.fn(), tickets: { get: vi.fn() } },
      engine: { assignmentStarted: vi.fn(), report: vi.fn(() => ticket) },
      sessions: { relay: vi.fn((id: string) => { relayed.push(id) }) },
      lifetime: new AbortController().signal, closing: () => false, paused: () => false, environment: () => [], sourceRoot: vi.fn() } as unknown as CodexExecutorHost
    const executor = new CodexExecExecutor(host)
    const record = (executor as unknown as { record: (ticketId: string, value: CodexReport) => void }).record.bind(executor)
    return { record, host, relayed }
  }

  // 回归：codex 的正常提问必须映射为 waiting + question，让引擎建立 attention（Awaiting answer）、
  // 不触发 blocked 分支清除自动输入（note 被吞的根源）；主 session 收到 worker_attention 而非失败报告。
  it('maps needs_human_input to waiting with the question', () => {
    const { record, host, relayed } = executorFor()
    record('ticket-1', reportOf('needs_human_input'))
    expect(host.engine.report).toHaveBeenCalledWith('ticket-1',
      expect.objectContaining({ state: 'waiting', question: '用哪个模型网关？' }))
    expect(relayed.join('\n')).toContain('attention:ticket-1')
  })

  // 守护不变项：completed→ready；真 blocked（权限/资源）保持 blocked，且不带 question 字段（沿用原实现）。
  it('maps completed to ready and blocked to blocked', () => {
    const { record, host } = executorFor()
    record('ticket-1', reportOf('completed'))
    expect(host.engine.report).toHaveBeenCalledWith('ticket-1', expect.objectContaining({ state: 'ready', question: null }))
    record('ticket-1', reportOf('blocked'))
    expect(host.engine.report).toHaveBeenCalledWith('ticket-1', expect.objectContaining({ state: 'blocked' }))
    expect(host.engine.report).toHaveBeenLastCalledWith('ticket-1', expect.not.objectContaining({ question: expect.anything() }))
  })
})
