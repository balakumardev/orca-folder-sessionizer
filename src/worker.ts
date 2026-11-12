// Folder Sessionizer: Orca plugin worker.
//
// Ctrl+Shift+F (or the "Projects" status bar item) scans the configured roots, shows the native
// picker and opens the chosen folder in Orca as a terminal tab, a Claude/Codex agent, a plain
// workspace switch, or a new Git worktree.
//
// The picker is compiled from swift/Picker.swift on first use and cached under
// ~/Library/Caches/orca-folder-sessionizer, so the repository ships no executable.
//
// Everything that touches the OS goes through `deps`, so tests inject fakes and `activate` itself
// never scans or spawns anything.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'

// ---------------------------------------------------------------------------------------------
// Types and constants

export const ACTIONS = ['terminal', 'claude', 'codex', 'worktree', 'open'] as const
export type Action = (typeof ACTIONS)[number]

export const DEFAULT_ROOTS = '~/workspace, ~/personal'
export const MRU_KEY = 'mruPaths'
export const MRU_LIMIT = 50
export const ORCA_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

export interface Config {
  roots: string[]
  maxDepth: number
  defaultEnterAction: Action
}

export interface PickerItem {
  path: string
  open: boolean
  recent?: number
}
export interface PickerRequest {
  defaultAction: Action
  items: PickerItem[]
}
export interface PickerPick {
  path: string
  action: Action
}
export interface PickerHandle {
  focus(): void
  kill(): void
}

export interface CliReply {
  ok: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

export interface Deps {
  cli(args: string[]): Promise<CliReply>
  git(args: string[]): Promise<string | null>
  findFd(): Promise<string | null>
  runFd(fd: string, roots: string[], maxDepth: number): Promise<string[]>
  subdirs(dir: string): Promise<string[]>
  realpath(p: string): Promise<string | null>
  isDir(p: string): Promise<boolean>
  /** The compiled picker if it is already built; never builds. */
  pickerPath(): Promise<string | null>
  /** Compiles the picker if it is not cached yet and returns its path. Rejects with a plain reason. */
  buildPicker(): Promise<string>
  runPicker(
    bin: string,
    request: PickerRequest,
    onStart: (handle: PickerHandle) => void
  ): Promise<PickerPick | null>
  selfTestPicker(): Promise<{ ok: boolean; output: string }>
  now(): Date
  sleep(ms: number): Promise<void>
  home(): string
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function isAction(v: unknown): v is Action {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v)
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

export function parseRoots(value: unknown, home: string): string[] {
  const raw = typeof value === 'string' && value.trim() ? value : DEFAULT_ROOTS
  const out: string[] = []
  for (const part of raw.split(/[,\n]/)) {
    const t = part.trim()
    if (t) out.push(expandHome(t, home))
  }
  return Array.from(new Set(out))
}

export function clampDepth(value: unknown): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN
  if (!Number.isFinite(n)) return 3
  return Math.min(6, Math.max(1, n))
}

export function normalizeAction(value: unknown): Action {
  return isAction(value) ? value : 'terminal'
}

export function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** Tab title, as herdr-sessionizer.sh labels it: the folder name with dots turned to underscores. */
export function labelFor(p: string): string {
  return basename(stripTrailingSlash(p)).replace(/\./g, '_') || 'project'
}

export function hhmmss(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds())
}

/** `<label>-<hhmmss>`, safe as a worktree name and the branch name derived from it. */
export function worktreeName(label: string, d: Date): string {
  const safe = label
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${safe || 'project'}-${hhmmss(d)}`
}

export function mergeMru(mru: readonly string[], path: string, limit = MRU_LIMIT): string[] {
  return [path, ...mru.filter((p) => p !== path)].slice(0, limit)
}

export function parsePick(stdout: string): PickerPick | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    const v = JSON.parse(text) as { path?: unknown; action?: unknown }
    if (typeof v.path === 'string' && v.path.startsWith('/') && isAction(v.action)) {
      return { path: v.path, action: v.action }
    }
  } catch {
    // fall through
  }
  return null
}

export function buildItems(
  paths: readonly string[],
  openPaths: ReadonlySet<string>,
  mru: readonly string[]
): PickerItem[] {
  const rank = new Map<string, number>()
  mru.forEach((p, i) => {
    if (!rank.has(p)) rank.set(p, i)
  })
  return paths.map((path) => {
    const item: PickerItem = { path, open: openPaths.has(path) }
    const r = rank.get(path)
    if (r !== undefined) item.recent = r
    return item
  })
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/** `repo.id` from `orca repo add --json`. */
export function repoIdFrom(reply: CliReply): string | null {
  return str(obj(obj(reply.result)?.repo)?.id)
}

// ---------------------------------------------------------------------------------------------
// Folder scanning

export async function scanFolders(
  roots: readonly string[],
  maxDepth: number,
  deps: Deps,
  log: (m: string) => void = () => {}
): Promise<string[]> {
  const canon: string[] = []
  for (const r of roots) {
    if (!(await deps.isDir(r))) continue
    const real = await deps.realpath(r)
    if (real) canon.push(stripTrailingSlash(real))
  }
  const rootList = Array.from(new Set(canon))
  if (rootList.length === 0) return []

  const found = new Set<string>()
  const fd = await deps.findFd()
  let usedFd = false
  if (fd) {
    try {
      for (const line of await deps.runFd(fd, rootList, maxDepth)) {
        const p = stripTrailingSlash(line.trim())
        if (p.startsWith('/')) found.add(p)
      }
      usedFd = true
    } catch (e) {
      log(`fd failed (${errMsg(e)}); falling back to readdir`)
    }
  }
  if (!usedFd) {
    // Same listing as fd without --hidden: no dot folders, no node_modules, symlinks not followed.
    let frontier = rootList
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: string[] = []
      for (let i = 0; i < frontier.length; i += 32) {
        const batch = frontier.slice(i, i + 32)
        const lists = await Promise.all(
          batch.map(async (dir) => (await deps.subdirs(dir)).map((n) => join(dir, n)))
        )
        for (const children of lists) {
          for (const c of children) {
            found.add(c)
            next.push(c)
          }
        }
      }
      frontier = next
    }
  }
  return Array.from(found).sort()
}

// ---------------------------------------------------------------------------------------------
// Real dependencies

function scrubbedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  // Variables that name a caller or a target would send the CLI to the wrong workspace.
  const drop = new Set([
    'ORCA_WORKTREE_ID',
    'ORCA_TERMINAL_HANDLE',
    'ORCA_PANE_KEY',
    'ORCA_TAB_ID',
    'ORCA_ENVIRONMENT',
    'ORCA_PAIRING_CODE',
    'NODE_OPTIONS'
  ])
  for (const k of Object.keys(env)) {
    if (drop.has(k) || k.startsWith('ORCA_AGENT_')) delete env[k]
  }
  const have = (env.PATH ?? '').split(':').filter(Boolean)
  const extra = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin']
  env.PATH = Array.from(new Set([...have, ...extra])).join(':')
  return env
}

async function exists(p: string, mode = 0): Promise<boolean> {
  try {
    await fsp.access(p, mode)
    return true
  } catch {
    return false
  }
}

function run(
  file: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number | string | null }> {
  return new Promise((res) => {
    execFile(
      file,
      args,
      {
        env: scrubbedEnv(),
        timeout: opts.timeout ?? 90_000,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => res({ stdout, stderr, code: err ? (err.code ?? 1) : 0 })
    )
  })
}

/** Runs `fn` one at a time: callers that arrive while it runs share its result, later ones run it again. */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null
  return () => {
    if (!running) {
      const p = fn()
      running = p
      const clear = () => {
        if (running === p) running = null
      }
      p.then(clear, clear)
    }
    return running
  }
}

/** The last few lines of command output, short enough for a log line. */
export function tail(text: string, lines = 6, max = 500): string {
  const out = text.trim().split('\n').slice(-lines).join('\n')
  return out.length > max ? out.slice(-max) : out
}

/** The picker's Swift source, in the installed plugin next to src/. */
function pickerSource(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'swift', 'Picker.swift')
}

export function realDeps(): Deps {
  const home = homedir()

  /**
   * Orca checks the plugin folder against a hash, so the compiled picker goes in the user's cache
   * instead. The key is the source's hash: an update that changes Picker.swift rebuilds by itself.
   */
  async function cachedPicker(): Promise<string> {
    const source = await fsp.readFile(pickerSource(), 'utf8')
    const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
    return join(home, 'Library', 'Caches', 'orca-folder-sessionizer', key, 'orca-folder-picker')
  }

  async function pickerPath(): Promise<string | null> {
    try {
      const bin = await cachedPicker()
      return (await exists(bin, fsConstants.X_OK)) ? bin : null
    } catch {
      return null
    }
  }

  async function compilePicker(): Promise<string> {
    let bin: string
    try {
      bin = await cachedPicker()
    } catch (e) {
      throw new Error(`cannot read swift/Picker.swift in the plugin folder: ${errMsg(e)}`)
    }
    if (await exists(bin, fsConstants.X_OK)) return bin
    // With no developer tools, `xcrun` would open macOS's install dialog. Say what is missing instead.
    if ((await run('/usr/bin/xcode-select', ['-p'], { timeout: 10_000 })).code !== 0) {
      throw new Error('the picker is built on first use and needs Xcode or its Command Line Tools: run `xcode-select --install` in a terminal')
    }
    await fsp.mkdir(dirname(bin), { recursive: true })
    // Build beside the target, then rename, so a half-written file is never run.
    const tmp = `${bin}.building-${Date.now()}`
    try {
      const build = await run('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', pickerSource(), '-o', tmp], { timeout: 5 * 60_000 })
      if (build.code !== 0) throw new Error(`swiftc exited ${build.code}: ${tail(build.stderr)}`)
      const check = await run(tmp, ['--selftest'], { timeout: 15_000 })
      if (check.code !== 0) throw new Error(`the built picker failed its self-test: ${tail(check.stdout + check.stderr)}`)
      await fsp.rename(tmp, bin)
      return bin
    } finally {
      await fsp.rm(tmp, { force: true })
    }
  }

  // One build at a time: a second press while the first is compiling waits for it.
  const buildPicker = singleFlight(compilePicker)

  return {
    async cli(args) {
      const bin = (await exists(ORCA_CLI, fsConstants.X_OK)) ? ORCA_CLI : 'orca'
      const { stdout, stderr, code } = await run(bin, args)
      try {
        const parsed = JSON.parse(stdout.trim()) as CliReply
        if (parsed && typeof parsed.ok === 'boolean') return parsed
      } catch {
        // not JSON
      }
      throw new Error(`orca ${args.slice(0, 2).join(' ')} failed (${code}): ${(stderr || stdout).trim().slice(0, 300)}`)
    },

    async git(args) {
      const bin = (await exists('/usr/bin/git')) ? '/usr/bin/git' : 'git'
      const { stdout, code } = await run(bin, args, { timeout: 15_000 })
      return code === 0 ? stdout.trim() : null
    },

    async findFd() {
      const cands = ['/opt/homebrew/bin/fd', '/usr/local/bin/fd', join(home, '.cargo/bin/fd'), join(home, '.local/bin/fd')]
      for (const c of cands) if (await exists(c, fsConstants.X_OK)) return c
      for (const name of ['fd', 'fdfind']) {
        if ((await run(name, ['--version'], { timeout: 5_000 })).code === 0) return name
      }
      return null
    },

    async runFd(fd, roots, maxDepth) {
      const args = ['.', ...roots, '--type', 'd', '--max-depth', String(maxDepth), '--exclude', '.git', '--exclude', 'node_modules', '--color', 'never']
      const { stdout, code } = await run(fd, args, { timeout: 60_000, maxBuffer: 256 * 1024 * 1024 })
      // fd exits non-zero when one root is unreadable but still prints the rest.
      if (code !== 0 && !stdout.trim()) throw new Error(`fd exited ${code}`)
      return stdout.split('\n')
    },

    async subdirs(dir) {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true })
        return entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .map((e) => e.name)
      } catch {
        return []
      }
    },

    async realpath(p) {
      try {
        return await fsp.realpath(p)
      } catch {
        return null
      }
    },

    async isDir(p) {
      try {
        return (await fsp.stat(p)).isDirectory()
      } catch {
        return false
      }
    },

    pickerPath,
    buildPicker,

    async runPicker(bin, request, onStart) {
      return new Promise<PickerPick | null>((res, rej) => {
        const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: scrubbedEnv() })
        let out = ''
        let err = ''
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', (c) => (out += String(c)))
        child.stderr?.on('data', (c) => (err += String(c)))
        child.on('error', (e) => rej(e))
        child.on('close', (code, signal) => {
          if (code === 0) {
            const pick = parsePick(out)
            if (pick) res(pick)
            else rej(new Error(`picker returned unreadable output: ${out.slice(0, 200)}`))
          } else if (code === 1 || signal) {
            res(null)
          } else {
            rej(new Error(`picker exited ${code}: ${err.trim().slice(0, 300)}`))
          }
        })
        child.stdin?.on('error', () => {})
        child.stdin?.end(JSON.stringify(request))
        onStart({ focus: () => child.kill('SIGUSR1'), kill: () => child.kill('SIGTERM') })
      })
    },

    async selfTestPicker() {
      try {
        const bin = await buildPicker()
        const r = await run(bin, ['--selftest'], { timeout: 15_000 })
        return { ok: r.code === 0, output: (r.stdout + r.stderr).trim().slice(0, 300) }
      } catch (e) {
        return { ok: false, output: errMsg(e) }
      }
    },

    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    home: () => home
  }
}

// Test seam. `orca/testing` loads the worker as its own module instance, so the overrides live on
// `globalThis`, which the test file and that instance share. Production never sets them.
type Overrides = { __folderSessionizerDeps?: Partial<Deps> }
const realImpl = realDeps()
const deps: Deps = new Proxy(realImpl, {
  get(target, key) {
    const over = (globalThis as Overrides).__folderSessionizerDeps as Record<PropertyKey, unknown> | undefined
    return over?.[key] ?? (target as unknown as Record<PropertyKey, unknown>)[key]
  }
})

/** Test seam: replace some or all dependencies. */
export function setDeps(partial: Partial<Deps>): void {
  const g = globalThis as Overrides
  g.__folderSessionizerDeps = { ...g.__folderSessionizerDeps, ...partial }
}
export function resetDeps(): void {
  delete (globalThis as Overrides).__folderSessionizerDeps
}

// ---------------------------------------------------------------------------------------------
// Selection: turn {path, action} into Orca state

interface Known {
  id: string
  kind: 'worktree' | 'folder'
}
interface Target {
  /** CLI `--worktree` selector. */
  selector: string
  /** The id `workspace.open` takes, looked up only when something needs it. */
  workspaceId(): Promise<string | null>
}
interface PsRow {
  repoId: string | null
  selector: string | null
}

function createController(orca: OrcaWorkerApi) {
  const log = (m: string) => orca.log(m)
  let phase: 'idle' | 'scanning' | 'open' = 'idle'
  let picker: PickerHandle | null = null
  /** Why the last attempt to build the picker failed; cleared by the next success. */
  let pickerProblem: string | null = null

  async function ensurePicker(): Promise<string> {
    try {
      const bin = await deps.buildPicker()
      pickerProblem = null
      return bin
    } catch (e) {
      pickerProblem = errMsg(e)
      throw e
    }
  }

  /** Builds the picker at startup, so the first press finds it ready. Never throws. */
  async function warmPicker(): Promise<void> {
    try {
      const had = await deps.pickerPath()
      if (!had) log('building the picker from swift/Picker.swift (first run, a few seconds)')
      const t0 = deps.now().getTime()
      const bin = await ensurePicker()
      if (!had) log(`picker built in ${((deps.now().getTime() - t0) / 1000).toFixed(1)}s: ${bin}`)
    } catch (e) {
      log(`picker unavailable: ${errMsg(e)}`)
    }
  }

  /** Shown as a toast when the command is pressed after a failed build; the press retries the build. */
  function pickerNote(): string | undefined {
    return pickerProblem ? `Folder Sessionizer could not build its picker: ${pickerProblem}. Trying again now.` : undefined
  }

  async function readConfig(): Promise<Config> {
    let s: Record<string, unknown> = {}
    try {
      s = (await orca.settings.get()) as Record<string, unknown>
    } catch (e) {
      log(`settings unavailable, using defaults: ${errMsg(e)}`)
    }
    return {
      roots: parseRoots(s.searchRoots, deps.home()),
      maxDepth: clampDepth(s.maxDepth),
      defaultEnterAction: normalizeAction(s.defaultEnterAction)
    }
  }

  async function readMru(): Promise<string[]> {
    try {
      const v = await orca.storage.get(MRU_KEY)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch (e) {
      log(`mru unavailable: ${errMsg(e)}`)
      return []
    }
  }

  async function recordMru(path: string): Promise<void> {
    try {
      await orca.storage.set(MRU_KEY, mergeMru(await readMru(), path))
    } catch (e) {
      log(`could not save mru: ${errMsg(e)}`)
    }
  }

  async function canonical(p: string): Promise<string> {
    return stripTrailingSlash((await deps.realpath(p)) ?? p)
  }

  /** Workspaces Orca already has, keyed by canonical folder path. */
  async function listWorkspaces(): Promise<Map<string, Known>> {
    const map = new Map<string, Known>()
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      await Promise.all(
        workspaces.map(async (w) => {
          const p = await canonical(w.path)
          // Several workspaces can share a path (a repo root and its main checkout): keep the first.
          if (!map.has(p)) map.set(p, { id: w.id, kind: w.kind })
        })
      )
    } catch (e) {
      log(`workspace.list failed: ${errMsg(e)}`)
    }
    return map
  }

  async function buildRequest(cfg: Config): Promise<{ request: PickerRequest; total: number }> {
    const [paths, open, mru] = await Promise.all([
      scanFolders(cfg.roots, cfg.maxDepth, deps, log),
      listWorkspaces(),
      readMru()
    ])
    const items = buildItems(paths, new Set(open.keys()), mru)
    return { request: { defaultAction: cfg.defaultEnterAction, items }, total: items.length }
  }

  async function cliOk(args: string[], retries = 0): Promise<CliReply> {
    let last = ''
    for (let i = 0; i <= retries; i++) {
      try {
        const reply = await deps.cli(args)
        if (reply.ok) return reply
        last = `${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'unknown'}`
      } catch (e) {
        last = errMsg(e)
      }
      if (i < retries) await deps.sleep(300)
    }
    throw new Error(`orca ${args.slice(0, 2).join(' ')}: ${last}`)
  }

  async function openWorkspace(workspaceId: string): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      try {
        await orca.host.call('workspace.open', { workspaceId })
        return true
      } catch (e) {
        if (i === 2) log(`workspace.open ${workspaceId} failed: ${errMsg(e)}`)
        else await deps.sleep(250)
      }
    }
    return false
  }

  /**
   * `terminal create --focus` and `agent launch --focus` already switch to the workspace and add
   * exactly one tab (measured on Orca 1.4.257). Calling `workspace.open` first would make Orca add
   * its own default shell to a workspace with no terminals, giving two tabs on the first open. So
   * it is only the fallback, for a workspace the CLI cannot reach yet (just added).
   */
  async function createFocused(target: Target, args: string[]): Promise<void> {
    try {
      await cliOk(args, 1)
    } catch (e) {
      const id = await target.workspaceId()
      if (!id) throw e
      log(`${errMsg(e)}; opening the workspace and retrying`)
      if (!(await openWorkspace(id))) throw e
      await cliOk(args, 2)
    }
  }

  /**
   * What `orca worktree ps` knows about a folder: its repo id and the exact selector Orca prints for
   * it. Workspace ids from `workspace.list` are opaque, so neither is parsed out of them.
   */
  async function psRow(path: string): Promise<PsRow | null> {
    try {
      const reply = await deps.cli(['worktree', 'ps', '--limit', '1000', '--json'])
      const rows = obj(reply.result)?.worktrees
      if (!Array.isArray(rows)) return null
      for (const row of rows) {
        const r = obj(row)
        if (!r || str(r.path) !== path) continue
        const worktreeId = str(r.worktreeId)
        return {
          repoId: str(r.repoId),
          selector: str(obj(r.address)?.worktree) ?? (worktreeId ? `id:${worktreeId}` : null)
        }
      }
    } catch (e) {
      log(`worktree ps failed: ${errMsg(e)}`)
    }
    return null
  }

  async function isGitRoot(path: string): Promise<boolean> {
    const top = await deps.git(['-C', path, 'rev-parse', '--show-toplevel'])
    return top !== null && top !== '' && (await canonical(top)) === path
  }

  async function createWorktree(repoId: string, label: string): Promise<void> {
    const name = worktreeName(label, deps.now())
    await cliOk([
      'worktree', 'create', '--repo', `id:${repoId}`, '--name', name, '--no-parent', '--activate', '--agent', 'claude', '--json'
    ])
    log(`created worktree ${name} in repo ${repoId}`)
  }

  async function waitForWorkspace(path: string): Promise<Known | null> {
    for (let i = 0; i < 6; i++) {
      const found = (await listWorkspaces()).get(path)
      if (found) return found
      await deps.sleep(250)
    }
    return null
  }

  async function performSelection(pick: PickerPick): Promise<void> {
    // A relative path would resolve against this worker's cwd, not anything the person chose.
    if (!pick.path.startsWith('/')) throw new Error(`not an absolute path: ${pick.path}`)
    const selected = await canonical(pick.path)
    if (!(await deps.isDir(selected))) throw new Error(`not a folder: ${selected}`)
    await recordMru(selected)
    const label = labelFor(selected)
    let action = pick.action

    let repoId: string | null = null
    let target: Target
    let kind: 'git' | 'folder'

    const known = (await listWorkspaces()).get(selected) ?? null
    if (known) {
      // Orca already shows this folder: reuse it, never re-add a worktree path as a second project.
      kind = known.kind === 'worktree' ? 'git' : 'folder'
      const row = await psRow(selected)
      repoId = row?.repoId ?? null
      target = { selector: row?.selector ?? `path:${selected}`, workspaceId: async () => known.id }
    } else if (await isGitRoot(selected)) {
      kind = 'git'
      repoId = repoIdFrom(await cliOk(['repo', 'add', '--path', selected, '--json']))
      if (!repoId) throw new Error('repo add returned no repo id')
      if (action !== 'worktree') {
        // 1.4.x hides a repo's main checkout until visibility is "show": without this the
        // exact-folder workspace does not exist.
        await cliOk(['repo', 'set', '--repo', `id:${repoId}`, '--external-worktree-visibility', 'show', '--json'])
      }
      const rid = repoId
      target = {
        selector: `id:${rid}::${selected}`,
        workspaceId: async () => (await waitForWorkspace(selected))?.id ?? `${rid}::${selected}`
      }
    } else {
      kind = 'folder'
      await cliOk(['repo', 'add', '--path', selected, '--kind', 'folder', '--json'])
      const row = await psRow(selected)
      target = {
        selector: row?.selector ?? `path:${selected}`,
        workspaceId: async () => (await waitForWorkspace(selected))?.id ?? null
      }
    }

    if (action === 'worktree') {
      if (kind === 'git' && repoId) {
        await createWorktree(repoId, label)
        return
      }
      // No notifications:show capability is granted, so say it in the log and carry on.
      log(`${selected} is not a Git repository root: opening it as a folder terminal instead of a worktree`)
      action = 'terminal'
    }

    log(`${action} ${selected} (${kind}, selector ${target.selector})`)
    switch (action) {
      case 'open': {
        const id = await target.workspaceId()
        const opened = id ? await openWorkspace(id) : false
        if (!opened) {
          // `worktree activate` is refused for folder: workspaces, so only Git targets may fall back.
          if (kind === 'git') await cliOk(['worktree', 'activate', '--worktree', target.selector, '--json'], 2)
          else throw new Error(`could not switch to ${selected}`)
        }
        return
      }
      case 'terminal':
        await createFocused(target, ['terminal', 'create', '--worktree', target.selector, '--title', label, '--focus', '--json'])
        return
      case 'claude':
      case 'codex':
        await createFocused(target, ['agent', 'launch', '--worktree', target.selector, '--agent', action, '--focus', '--json'])
        return
    }
  }

  /** Runs on the command's behalf; the command itself returns immediately. */
  async function trigger(): Promise<void> {
    if (phase === 'open' && picker) {
      picker.focus()
      return
    }
    if (phase !== 'idle') return
    phase = 'scanning'
    try {
      // First, so a missing toolchain fails before any scanning and a first-run build is waited for.
      const bin = await ensurePicker()
      const cfg = await readConfig()
      const { request, total } = await buildRequest(cfg)
      log(`picker: ${total} folders from ${cfg.roots.join(', ')} (depth ${cfg.maxDepth})`)
      phase = 'open'
      const pick = await deps.runPicker(bin, request, (h) => {
        picker = h
      })
      picker = null
      phase = 'idle'
      if (pick) await performSelection(pick)
    } catch (e) {
      log(`folder-sessionizer error: ${errMsg(e)}`)
    } finally {
      picker = null
      phase = 'idle'
    }
  }

  function stop(): void {
    picker?.kill()
    picker = null
  }

  /** First few raw `workspace.list` rows, for `candidates` diagnostics. */
  async function workspaceSample(): Promise<{ id: string; kind: string; path: string }[]> {
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      return workspaces.slice(0, 5).map((w) => ({ id: w.id, kind: w.kind, path: w.path }))
    } catch {
      return []
    }
  }

  return { trigger, stop, performSelection, buildRequest, readConfig, workspaceSample, warmPicker, pickerNote }
}

type Controller = ReturnType<typeof createController>
let current: Controller | null = null

// ---------------------------------------------------------------------------------------------
// Entry points

export default function activate(orca: OrcaWorkerApi): void {
  const c = createController(orca)
  current = c

  // Return at once: a returned string becomes a toast, and waiting for the person would time out.
  // The only thing worth a toast is a picker that could not be built, since nothing else would show.
  orca.commands.register('folder-sessionizer.open', () => {
    const note = c.pickerNote()
    void c.trigger()
    return note
  })

  // Same selection logic without the picker, so the plugin can be verified end to end
  // with `orca plugin dev request . act --data '{"path":"/abs/dir","action":"terminal"}'`.
  orca.panels.handle('act', async (input) => {
    const v = obj(input)
    const path = str(v?.path)
    const action = v?.action
    if (!path || !isAction(action)) throw new Error('act needs {"path": "/abs/dir", "action": terminal|claude|codex|worktree|open}')
    await c.performSelection({ path, action })
    return { ok: true }
  })

  orca.panels.handle('candidates', async () => {
    const cfg = await c.readConfig()
    const { request, total } = await c.buildRequest(cfg)
    return {
      roots: cfg.roots,
      maxDepth: cfg.maxDepth,
      defaultEnterAction: cfg.defaultEnterAction,
      total,
      open: request.items.filter((i) => i.open).length,
      sample: request.items.slice(0, 5).map((i) => i.path),
      workspaces: await c.workspaceSample()
    }
  })

  orca.panels.handle('selfcheck', async () => {
    // The self-test builds the picker if needed, so read its path afterwards.
    const st = await deps.selfTestPicker()
    const [picker, fd] = await Promise.all([deps.pickerPath(), deps.findFd()])
    return { picker, fd, pickerSelfTest: st.ok ? 'ok' : st.output, orcaEnvKeys: Object.keys(process.env).filter((k) => k.startsWith('ORCA')) }
  })

  // Read-only startup report (no spawning): lands in `orca plugin logs`.
  void (async () => {
    try {
      const [picker, fd] = await Promise.all([deps.pickerPath(), deps.findFd()])
      const envKeys = Object.keys(process.env).filter((k) => k.startsWith('ORCA'))
      orca.log(`ready: picker=${picker ?? 'not built yet'} fd=${fd ?? 'none (readdir fallback)'} orcaEnv=[${envKeys.join(',')}]`)
    } catch (e) {
      orca.log(`startup check failed: ${errMsg(e)}`)
    }
    await c.warmPicker()
  })()
}

export function deactivate(): void {
  current?.stop()
  current = null
}
