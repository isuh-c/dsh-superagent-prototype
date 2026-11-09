import type { AssessmentOutcome, Executor, Ticket } from '../core/index.ts'

/** Runtime lifecycle shared by the built-in DSH and Codex executors. */
export interface ManagedExecutor extends Executor {
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket
  install(): void
  resume(): void
  shutdown(): Promise<void>
  dispose(): void
  activeCount(): number
}
