/** GitLab REST v4 客户端：只访问配置的项目，令牌从文件读取，兼容分页与错误语义。 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { GitlabAccount } from '../deployment.ts'

/** GitLab 请求失败；`status` 为 HTTP 状态，便于区分删除与临时故障。 */
export class GitlabError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

export type Query = Record<string, string | number | boolean | undefined>
export type GitlabTarget = Pick<GitlabAccount, 'baseUrl' | 'projectId' | 'tokenFile'>

/** 读取令牌文件；文件缺失或为空时给出不含令牌内容的错误。 */
export function readGitlabToken(file: string): string {
  try {
    const token = readFileSync(file, 'utf8').trim()
    if (token) return token
  } catch { /* 下方统一报错。 */ }
  throw new Error(`The GitLab token file ${file} cannot be read`)
}

/** 只读/写配置项目的 REST 客户端，负责令牌读取、分页和状态错误。 */
export class GitlabClient {
  constructor(private readonly account: GitlabTarget, private readonly signal?: AbortSignal) {}

  private path(path: string): string {
    if (/^\//.test(path) || /:\/\//.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) throw new Error('GitLab calls are restricted to the configured project')
    return path ? `projects/${this.account.projectId}/${path}` : `projects/${this.account.projectId}`
  }

  private async request(path: string, init: { method?: string; query?: Query; body?: unknown } = {}): Promise<Response> {
    const url = new URL(`${this.account.baseUrl}/api/v4/${this.path(path)}`)
    for (const [name, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value))
    const timeout = AbortSignal.timeout(90_000)
    try {
      return await fetch(url, {
        method: init.method ?? 'GET',
        headers: { 'PRIVATE-TOKEN': readGitlabToken(this.account.tokenFile), 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      })
    } catch (error) {
      throw new GitlabError(`GitLab request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async body(response: Response, path: string, method: string): Promise<unknown> {
    if (!response.ok) throw new GitlabError(`GitLab ${method} ${path} returned ${response.status}`, response.status)
    try { return await response.json() } catch { throw new GitlabError(`GitLab ${method} ${path} returned invalid JSON`, response.status) }
  }

  async get<T>(schema: z.ZodType<T>, path: string, query?: Query): Promise<T> {
    return schema.parse(await this.body(await this.request(path, { query }), path, 'GET'))
  }

  async post<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T> {
    return schema.parse(await this.body(await this.request(path, { method: 'POST', body }), path, 'POST'))
  }

  async put<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T> {
    return schema.parse(await this.body(await this.request(path, { method: 'PUT', body }), path, 'PUT'))
  }

  /** 读取全部页（最多 50 页），跳过不符合 schema 的条目。 */
  async pages<T>(schema: z.ZodType<T>, path: string, query: Query = {}): Promise<T[]> {
    const items: T[] = []
    for (let page = 1; page <= 50; page++) {
      const response = await this.request(path, { query: { ...query, per_page: 100, page } })
      const listed = z.array(z.unknown()).parse(await this.body(response, path, 'GET'))
      for (const item of listed) {
        const parsed = schema.safeParse(item)
        if (parsed.success) items.push(parsed.data)
      }
      const next = response.headers.get('x-next-page')
      if (!next || listed.length === 0) break
    }
    return items
  }
}
