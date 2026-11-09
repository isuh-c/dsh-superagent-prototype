/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli', 'gitlab-mr']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GITLAB_TOKEN: undefined, GL_TOKEN: undefined, CI_JOB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'gitlab' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, github, gitlab, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  const script = async (name: string, text: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, text, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  await shim('gh', github ? run(github.cli) : fail('gh is unavailable: this installation has no GitHub Source.'))
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  if (gitlab) {
    await script('gitlab-mr', gitlabMrScript(gitlab))
    await script('gitlab-credential', gitlabCredentialScript(gitlab))
  }
  const fallback = github ? `use gh, which acts as ${github.login}` : gitlab ? `use gitlab-mr, which acts as ${gitlab.login}` : 'this installation has no remote Source'
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; ${fallback}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  const config = [MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =']
  if (github) config.push('[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/')
  if (gitlab) {
    const { host } = new URL(gitlab.baseUrl)
    config.push(`[credential "${gitlab.baseUrl}"]`, `\thelper = ${gitQuote(gitlabHelper(dir))}`,
      `[url "${gitlab.baseUrl}/"]`, `\tinsteadOf = git@${host}:`, `\tinsteadOf = ssh://git@${host}/`)
  }
  config.push(
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true')
  await own(workerGitConfig(stateDir), config.join('\n') + '\n')
}

/** The worker git credential helper command that reads the GitLab token file for the configured host. */
const gitlabHelper = (dir: string): string => '!' + shellQuote(join(dir, 'gitlab-credential'))
/** The worker helper that creates, views, or merges a merge request through the GitLab REST API. */
function gitlabMrScript(gitlab: NonNullable<Deployment['gitlab']>): string {
  return `#!/usr/bin/env python3
${MARKER}
"""Create, view, or merge a merge request of the configured GitLab project."""
import argparse, json, sys, urllib.error, urllib.parse, urllib.request
BASE = ${JSON.stringify(gitlab.baseUrl)}
PROJECT = ${JSON.stringify(String(gitlab.projectId))}
TOKEN_FILE = ${JSON.stringify(gitlab.tokenFile)}

def call(method, path, body=None):
    url = BASE + '/api/v4/projects/' + urllib.parse.quote(PROJECT, safe='') + path
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method,
        headers={'PRIVATE-TOKEN': open(TOKEN_FILE).read().strip(), 'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        print('gitlab-mr: HTTP %s: %s' % (error.code, error.read().decode('utf-8', 'replace')[:300]), file=sys.stderr)
        sys.exit(1)
    except OSError as error:
        print('gitlab-mr: %s' % error, file=sys.stderr)
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(prog='gitlab-mr')
    sub = parser.add_subparsers(dest='command', required=True)
    create = sub.add_parser('create')
    create.add_argument('--source-branch', required=True)
    create.add_argument('--target-branch')
    create.add_argument('--title', required=True)
    create.add_argument('--description', default='')
    create.add_argument('--remove-source-branch', action='store_true')
    issue = sub.add_parser('issue')
    issue.add_argument('iid', type=int)
    view = sub.add_parser('view')
    view.add_argument('iid', type=int)
    merge = sub.add_parser('merge')
    merge.add_argument('iid', type=int)
    merge.add_argument('--squash', action='store_true')
    merge.add_argument('--sha')
    args = parser.parse_args()
    if args.command == 'issue':
        issue = call('GET', '/issues/%d' % args.iid)
        print(json.dumps({'iid': issue.get('iid'), 'title': issue.get('title'), 'description': issue.get('description'),
            'state': issue.get('state'), 'author': (issue.get('author') or {}).get('username'),
            'labels': issue.get('labels'), 'web_url': issue.get('web_url'),
            'created_at': issue.get('created_at'), 'updated_at': issue.get('updated_at')}))
        return
    elif args.command == 'create':
        body = {'source_branch': args.source_branch, 'title': args.title, 'description': args.description,
                'remove_source_branch': args.remove_source_branch}
        if args.target_branch:
            body['target_branch'] = args.target_branch
        merge_request = call('POST', '/merge_requests', body)
    elif args.command == 'view':
        merge_request = call('GET', '/merge_requests/%d' % args.iid)
    else:
        body = {'squash': args.squash}
        if args.sha:
            body['sha'] = args.sha
        merge_request = call('PUT', '/merge_requests/%d/merge' % args.iid, body)
    print(json.dumps({'iid': merge_request.get('iid'), 'state': merge_request.get('state'),
        'web_url': merge_request.get('web_url'), 'detailed_merge_status': merge_request.get('detailed_merge_status')}))

main()
`
}
/** The worker git credential helper that answers the GitLab host with the Project Access Token. */
function gitlabCredentialScript(gitlab: NonNullable<Deployment['gitlab']>): string {
  return `#!/usr/bin/env python3
${MARKER}
"""Answer git's credential request for the configured GitLab host with the Project Access Token."""
import sys
HOST = ${JSON.stringify(new URL(gitlab.baseUrl).host)}
TOKEN_FILE = ${JSON.stringify(gitlab.tokenFile)}

def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'get'
    if action != 'get':
        return
    fields = {}
    for line in sys.stdin:
        line = line.rstrip('\\n')
        if not line:
            break
        name, _, value = line.partition('=')
        fields[name] = value
    if fields.get('host') != HOST:
        return
    with open(TOKEN_FILE) as token:
        sys.stdout.write('username=oauth2\\npassword=%s\\n' % token.read().strip())

main()
`
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's credential helper for each configured Source. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'gitlab' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, gitlab, stateDir } = deployment
  const read = async (url: string): Promise<string> => (await runAsWorker(subprocess,
    ['git', 'config', '-z', '--show-origin', '--get-all', `credential.${url}.helper`], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0').join('\0')
  if (github && await read('https://github.com') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
  if (gitlab && await read(gitlab.baseUrl) !== [`file:${workerGitConfig(stateDir)}`, gitlabHelper(workerBin(stateDir)), ''].join('\0')) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
