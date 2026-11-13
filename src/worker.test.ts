import { afterEach, assert, hostError, mockHost, mountWorker, test as baseTest, type TestWorker } from 'orca/testing'
import * as main from './worker'
import type { CliReply, Deps, PickerHandle, PickerPick, PickerRequest, PickerTheme, ThemeIo, ThemeTokens } from './worker'

// A hung test fails by name after 10 s instead of freezing the whole run.
function test(name: string, fn: () => unknown): Promise<void> {
  return baseTest(name, () =>
    Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`test "${name}" timed out after 10s`)), 10_000))
    ])
  )
}

const CAPS = ['workspace:read', 'workspace:write', 'terminal:send', 'agent:launch', 'settings:own', 'storage:own']
const FIXED_NOW = new Date(2026, 10, 12, 16, 5, 9)

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
  main.resetDeps()
})

const ok = (result: unknown = {}): CliReply => ({ ok: true, result })

interface Rig {
  cli: string[][]
  git: string[][]
  host: ReturnType<typeof mockHost>
}

/** Fake the OS: every dependency is replaced, so no test spawns, scans or sleeps for real. */
function rig(opts: {
  gitRoots?: string[]
  cli?: (args: string[], host: Rig['host']) => CliReply | undefined
  workspaces?: { id: string; kind: 'worktree' | 'folder'; path: string }[]
  storage?: Record<string, unknown>
  settings?: Record<string, unknown>
  deps?: Partial<Deps>
}): Rig {
  const host = mockHost({
    capabilities: CAPS,
    results: {
      'workspace.list': {
        workspaces: (opts.workspaces ?? []).map((w) => ({ name: w.path, branch: null, hostId: null, ...w })),
        truncated: false
      },
      'workspace.open': { opened: true }
    },
    storage: opts.storage as never,
    settings: opts.settings as never
  })
  const r: Rig = { cli: [], git: [], host }
  main.setDeps({
    cli: async (args) => {
      r.cli.push(args)
      return opts.cli?.(args, host) ?? ok({})
    },
    git: async (args) => {
      r.git.push(args)
      const dir = args[1]
      return opts.gitRoots?.includes(dir) ? dir : null
    },
    realpath: async (p) => p,
    isDir: async () => true,
    findFd: async () => null,
    runFd: async () => [],
    subdirs: async () => [],
    pickerPath: async () => '/fake/orca-folder-picker',
    buildPicker: async () => '/fake/orca-folder-picker',
    selfTestPicker: async () => ({ ok: true, output: '' }),
    // Without this the real reader would open Orca's live settings database in every test.
    readTheme: async () => undefined,
    runPicker: async () => {
      throw new Error('runPicker must not run in this test')
    },
    sleep: async () => {},
    now: () => FIXED_NOW,
    home: () => '/home/t',
    ...opts.deps
  })
  return r
}

/** Parameters of every workspace.open the worker made. */
const opens = (r: Rig): unknown[] => [...r.host.callsOf('workspace.open')]

async function start(r: Rig): Promise<TestWorker> {
  worker = await mountWorker(main, { host: r.host })
  return worker
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await new Promise((res) => setTimeout(res, 5))
  }
  assert.fail(`timed out waiting for ${what}`)
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

test('roots: split, expand ~, dedupe, default when empty', () => {
  assert.deepEqual(main.parseRoots('~/workspace, ~/personal ,/abs/x,~/workspace', '/h'), [
    '/h/workspace',
    '/h/personal',
    '/abs/x'
  ])
  assert.deepEqual(main.parseRoots('', '/h'), ['/h/workspace', '/h/personal'])
  assert.deepEqual(main.parseRoots(undefined, '/h'), ['/h/workspace', '/h/personal'])
  assert.deepEqual(main.parseRoots('~/a\n~/b', '/h'), ['/h/a', '/h/b'])
})

test('depth is clamped to 1..6 and defaults to 3', () => {
  assert.equal(main.clampDepth(0), 1)
  assert.equal(main.clampDepth(99), 6)
  assert.equal(main.clampDepth(4.9), 4)
  assert.equal(main.clampDepth('x'), 3)
  assert.equal(main.clampDepth(undefined), 3)
})

test('labels and worktree names', () => {
  assert.equal(main.labelFor('/w/my.app/'), 'my_app')
  assert.equal(main.worktreeName('my_app', FIXED_NOW), 'my_app-160509')
  assert.equal(main.worktreeName('we ird/na..me!', FIXED_NOW), 'we-ird-na-me-160509')
  assert.equal(main.worktreeName('!!!', FIXED_NOW), 'project-160509')
})

test('mru moves a path to the front once and caps its length', () => {
  assert.deepEqual(main.mergeMru(['a', 'b', 'c'], 'b'), ['b', 'a', 'c'])
  assert.deepEqual(main.mergeMru(['a'], 'z'), ['z', 'a'])
  assert.equal(main.mergeMru(Array.from({ length: 80 }, (_, i) => `p${i}`), 'new').length, main.MRU_LIMIT)
})

test('picker output is validated', () => {
  assert.deepEqual(main.parsePick('{"path":"/a/b","action":"codex"}\n'), { path: '/a/b', action: 'codex' })
  assert.equal(main.parsePick(''), null)
  assert.equal(main.parsePick('not json'), null)
  assert.equal(main.parsePick('{"path":"rel","action":"codex"}'), null)
  assert.equal(main.parsePick('{"path":"/a","action":"rm -rf"}'), null)
})

test('picker output may name an existing worktree or a new one, never both', () => {
  assert.deepEqual(main.parsePick('{"path":"/a","action":"codex","worktreePath":"/w/a-x"}'), {
    path: '/a',
    action: 'codex',
    worktreePath: '/w/a-x'
  })
  assert.deepEqual(main.parsePick('{"path":"/a","action":"claude","newWorktree":"fix login"}'), {
    path: '/a',
    action: 'claude',
    newWorktree: 'fix login'
  })
  // An empty name is a real value: it asks for an automatic name.
  assert.deepEqual(main.parsePick('{"path":"/a","action":"claude","newWorktree":""}'), { path: '/a', action: 'claude', newWorktree: '' })
  // Neither field: a plain folder pick, with no extra keys at all.
  assert.deepEqual(main.parsePick('{"path":"/a","action":"open"}'), { path: '/a', action: 'open' })
  for (const bad of [
    '{"path":"/a","action":"open","worktreePath":"/w","newWorktree":"x"}',
    '{"path":"/a","action":"open","worktreePath":""}',
    '{"path":"/a","action":"open","worktreePath":"rel/path"}',
    '{"path":"/a","action":"open","worktreePath":null}',
    '{"path":"/a","action":"open","worktreePath":7}',
    '{"path":"/a","action":"open","newWorktree":5}',
    '[]'
  ]) {
    assert.equal(main.parsePick(bad), null, bad)
  }
})

test('slugify: lowercase, runs of other characters become one dash, no dashes at the ends', () => {
  assert.equal(main.slugify('Fix the Login Bug!'), 'fix-the-login-bug')
  assert.equal(main.slugify('  --feat/Add_OAuth2--  '), 'feat-add-oauth2')
  assert.equal(main.slugify('a'), 'a')
  assert.equal(main.slugify('!!!'), '')
  assert.equal(main.slugify(''), '')
})

test('worktree rows: archived, folder and other-host rows are dropped; refs/heads is stripped', () => {
  const rows = [
    { workspaceKind: 'git', repoId: 'R', path: '/a', branch: 'refs/heads/feat/x', isMainWorktree: true, hostId: 'local' },
    { workspaceKind: 'git', repoId: 'R', path: '/b', branch: '', isArchived: true },
    { workspaceKind: 'folder', repoId: 'F', path: '/c' },
    { workspaceKind: 'git', repoId: 'R', path: '/d', hostId: 'ssh:box' },
    { repoId: 'R', path: 'relative' },
    { repoId: 'R' },
    null,
    { repoId: 'R', path: '/e', branch: 'refs/heads/main' }
  ]
  assert.deepEqual(main.psWorktrees(rows), [
    { repoId: 'R', path: '/a', branch: 'feat/x', main: true },
    { repoId: 'R', path: '/e', branch: 'main', main: false }
  ])
})

test('worktree groups key on the main checkout, list it first and keep one row per path', () => {
  const groups = main.groupWorktrees([
    { repoId: 'R1', path: '/w/x', branch: 'x', main: false },
    { repoId: 'R1', path: '/p/a', branch: '', main: false },
    { repoId: 'R1', path: '/p/a', branch: 'main', main: true },
    { repoId: 'R1', path: '/w/x', branch: 'x', main: false },
    { repoId: 'R2', path: '/w/orphan', branch: 'y', main: false }
  ])
  assert.deepEqual([...groups.keys()], ['/p/a'])
  assert.deepEqual(groups.get('/p/a'), [
    { path: '/p/a', branch: 'main', main: true },
    { path: '/w/x', branch: 'x', main: false }
  ])
})

test('items carry open and recent rank', () => {
  const items = main.buildItems(['/a', '/b', '/c'], new Set(['/b']), ['/c', '/a'])
  assert.deepEqual(items, [
    { path: '/a', open: false, recent: 1 },
    { path: '/b', open: true },
    { path: '/c', open: false, recent: 0 }
  ])
})

// ---------------------------------------------------------------------------------------------
// Scanning

function scanDeps(over: Partial<Deps>): Deps {
  return {
    realpath: async (p) => p,
    isDir: async () => true,
    findFd: async () => null,
    runFd: async () => [],
    subdirs: async () => [],
    ...over
  } as Deps
}

test('scan with fd: trailing slashes stripped, duplicates removed, sorted', async () => {
  let seen: { roots: string[]; depth: number } | null = null
  const deps = scanDeps({
    findFd: async () => '/fake/fd',
    runFd: async (_fd, roots, depth) => {
      seen = { roots, depth }
      return ['/r/b/', '/r/a/', '/r/a/x/', '/r/a/', '', 'relative/ignored']
    }
  })
  assert.deepEqual(await main.scanFolders(['/r', '/missing'], 3, { ...deps, isDir: async (p) => p === '/r' }), [
    '/r/a',
    '/r/a/x',
    '/r/b'
  ])
  assert.deepEqual(seen, { roots: ['/r'], depth: 3 })
})

test('scan canonicalizes roots and collapses two names for one root', async () => {
  let roots: string[] = []
  const deps = scanDeps({
    realpath: async (p) => (p === '/link' ? '/real' : p),
    findFd: async () => 'fd',
    runFd: async (_fd, r) => {
      roots = r
      return []
    }
  })
  await main.scanFolders(['/link', '/real/'], 2, deps)
  assert.deepEqual(roots, ['/real'])
})

test('scan falls back to readdir, honouring depth', async () => {
  const tree: Record<string, string[]> = { '/r': ['a', 'b'], '/r/a': ['x'], '/r/a/x': ['deep'], '/r/b': [] }
  const deps = scanDeps({ subdirs: async (d) => tree[d] ?? [] })
  assert.deepEqual(await main.scanFolders(['/r'], 2, deps), ['/r/a', '/r/a/x', '/r/b'])
  assert.deepEqual(await main.scanFolders(['/r'], 3, deps), ['/r/a', '/r/a/x', '/r/a/x/deep', '/r/b'])
})

test('scan falls back to readdir when fd fails, and says so', async () => {
  const logs: string[] = []
  const deps = scanDeps({
    findFd: async () => 'fd',
    runFd: async () => {
      throw new Error('boom')
    },
    subdirs: async (d) => (d === '/r' ? ['only'] : [])
  })
  assert.deepEqual(await main.scanFolders(['/r'], 3, deps, (m) => logs.push(m)), ['/r/only'])
  assert.ok(logs.some((l) => l.includes('boom')))
})

test('scan with no existing roots is empty', async () => {
  const deps = scanDeps({ isDir: async () => false })
  assert.deepEqual(await main.scanFolders(['/nope'], 3, deps), [])
})

// ---------------------------------------------------------------------------------------------
// Command contract and single instance

test('activate registers the command, spawns nothing, and the command returns undefined at once', async () => {
  const r = rig({})
  const w = await start(r)
  assert.equal(await w.command('folder-sessionizer.open'), undefined)
  assert.deepEqual(w.refusals, [])
  await waitFor(() => w.logs.some((l) => l.startsWith('ready:')), 'startup log')
  assert.ok(w.logs.some((l) => l.includes('picker=/fake/orca-folder-picker')))
})

test('a second trigger while the picker is open focuses it instead of spawning another', async () => {
  const r = rig({ workspaces: [{ id: 'identity:wt2:local:u1', kind: 'worktree', path: '/p/a' }], settings: { searchRoots: '/p', defaultEnterAction: 'claude' } })
  let spawned = 0
  let focused = 0
  let killed = 0
  let release: (p: PickerPick | null) => void = () => {}
  let seenRequest: PickerRequest | null = null
  main.setDeps({
    subdirs: async (d) => (d === '/p' ? ['a', 'b'] : []),
    runPicker: (_bin, request, onStart) => {
      spawned++
      seenRequest = request
      const handle: PickerHandle = { focus: () => focused++, kill: () => killed++ }
      onStart(handle)
      return new Promise((res) => (release = res))
    }
  })
  const w = await start(r)
  assert.equal(await w.command('folder-sessionizer.open'), undefined)
  await waitFor(() => spawned === 1, 'picker start')
  await w.command('folder-sessionizer.open')
  await w.command('folder-sessionizer.open')
  assert.equal(spawned, 1)
  assert.equal(focused, 2)
  const req = seenRequest as unknown as PickerRequest
  assert.equal(req.defaultAction, 'claude')
  assert.deepEqual(req.items, [
    { path: '/p/a', open: true },
    { path: '/p/b', open: false }
  ])
  release(null) // cancelled: nothing may be opened or remembered
  await waitFor(() => true, 'settle')
  await new Promise((res) => setTimeout(res, 20))
  // the request build reads `worktree ps` (read-only); a cancel must run nothing else
  assert.deepEqual(r.cli.filter((a) => !(a[0] === 'worktree' && a[1] === 'ps')), [])
  assert.equal(killed, 0)
  // and the lock is released: the next trigger spawns again
  await w.command('folder-sessionizer.open')
  await waitFor(() => spawned === 2, 'second picker')
  release(null)
})

test('a picked folder flows through to Orca, and the MRU records it', async () => {
  const r = rig({ gitRoots: ['/p/a'], settings: { searchRoots: '/p' }, cli: (a) => (a[0] === 'repo' && a[1] === 'add' ? ok({ repo: { id: 'R1' } }) : undefined) })
  main.setDeps({
    subdirs: async (d) => (d === '/p' ? ['a'] : []),
    runPicker: async () => ({ path: '/p/a', action: 'terminal' })
  })
  const w = await start(r)
  await w.command('folder-sessionizer.open')
  await waitFor(() => r.cli.some((a) => a[0] === 'terminal'), 'terminal create')
  assert.deepEqual(r.host.data().storage.mruPaths, ['/p/a'])
})

test('errors are logged, never thrown into Orca', async () => {
  const r = rig({ settings: { searchRoots: '/p' }, deps: { subdirs: async () => ['a'] } })
  main.setDeps({
    runPicker: async () => {
      throw new Error('picker exploded')
    }
  })
  const w = await start(r)
  assert.equal(await w.command('folder-sessionizer.open'), undefined)
  await waitFor(() => w.logs.some((l) => l.includes('picker exploded')), 'error log')
})

// ---------------------------------------------------------------------------------------------
// The picker is compiled on the user's machine

test('a first run builds the picker at startup and says so in the log', async () => {
  let built = 0
  const r = rig({
    deps: {
      pickerPath: async () => null,
      buildPicker: async () => {
        built++
        return '/cache/k/orca-folder-picker'
      }
    }
  })
  const w = await start(r)
  await waitFor(() => w.logs.some((l) => l.includes('picker built in')), 'build log')
  assert.equal(built, 1)
  assert.ok(w.logs.some((l) => l.startsWith('ready:') && l.includes('picker=not built yet')))
  assert.ok(w.logs.some((l) => l.includes('building the picker from swift/Picker.swift')))
  assert.ok(w.logs.some((l) => l.includes('/cache/k/orca-folder-picker')))
})

test('an already built picker is not announced or rebuilt noisily', async () => {
  const r = rig({})
  const w = await start(r)
  await waitFor(() => w.logs.some((l) => l.startsWith('ready:')), 'startup log')
  await new Promise((res) => setTimeout(res, 20))
  assert.ok(!w.logs.some((l) => l.includes('building the picker')))
  assert.ok(!w.logs.some((l) => l.includes('picker unavailable')))
})

test('the picker is started from the path the build returned', async () => {
  const r = rig({ settings: { searchRoots: '/p' }, deps: { subdirs: async () => ['a'], buildPicker: async () => '/cache/k/orca-folder-picker' } })
  let usedBin = ''
  main.setDeps({
    runPicker: async (bin) => {
      usedBin = bin
      return null
    }
  })
  const w = await start(r)
  await w.command('folder-sessionizer.open')
  await waitFor(() => usedBin !== '', 'picker start')
  assert.equal(usedBin, '/cache/k/orca-folder-picker')
})

test('a failed build is logged, shown on the next press, and retried', async () => {
  let attempts = 0
  let started = 0
  const r = rig({
    settings: { searchRoots: '/p' },
    deps: {
      subdirs: async () => ['a'],
      pickerPath: async () => null,
      buildPicker: async () => {
        attempts++
        if (attempts < 3) throw new Error('needs the Command Line Tools: run `xcode-select --install`')
        return '/cache/k/orca-folder-picker'
      },
      runPicker: async () => {
        started++
        return null
      }
    }
  })
  const w = await start(r)
  await waitFor(() => w.logs.some((l) => l.includes('picker unavailable: needs the Command Line Tools')), 'startup failure log')
  assert.equal(attempts, 1)

  // First press: the person is told why, and the press tries again (still failing).
  const toast = await w.command('folder-sessionizer.open')
  assert.equal(typeof toast, 'string')
  assert.ok(String(toast).includes('xcode-select --install'))
  await waitFor(() => attempts === 2, 'retry')
  await waitFor(() => w.logs.some((l) => l.includes('folder-sessionizer error: needs the Command Line Tools')), 'error log')
  assert.equal(started, 0, 'no picker may start without a build')

  // Second press: told again, and this retry succeeds, so the picker opens.
  assert.equal(typeof (await w.command('folder-sessionizer.open')), 'string')
  await waitFor(() => started === 1, 'picker start after a good build')

  // From then on the command is silent again.
  assert.equal(await w.command('folder-sessionizer.open'), undefined)
})

test('singleFlight shares one run among concurrent callers and runs again after it settles', async () => {
  let runs = 0
  let release: (v: string) => void = () => {}
  const once = main.singleFlight(() => {
    runs++
    return new Promise<string>((res) => (release = res))
  })
  const a = once()
  const b = once()
  assert.equal(runs, 1)
  release('x')
  assert.deepEqual(await Promise.all([a, b]), ['x', 'x'])
  const c = once()
  assert.equal(runs, 2)
  release('y')
  assert.equal(await c, 'y')
})

test('singleFlight lets a failed run be retried', async () => {
  let runs = 0
  const once = main.singleFlight(async () => {
    runs++
    if (runs === 1) throw new Error('first fails')
    return 'ok'
  })
  await once().then(
    () => assert.fail('should reject'),
    (e: Error) => assert.equal(e.message, 'first fails')
  )
  assert.equal(await once(), 'ok')
  assert.equal(runs, 2)
})

test('tail keeps the last lines and caps the length', () => {
  assert.equal(main.tail('a\nb\nc\nd', 2), 'c\nd')
  assert.equal(main.tail('  x  \n'), 'x')
  assert.equal(main.tail('y'.repeat(900), 6, 100).length, 100)
})

// ---------------------------------------------------------------------------------------------
// Selection semantics

const repoAdd = (id: string) => (a: string[]): CliReply | undefined =>
  a[0] === 'repo' && a[1] === 'add' ? ok({ repo: { id } }) : undefined

test('git root + terminal: repo add, show external worktrees, one new focused tab', async () => {
  const r = rig({ gitRoots: ['/p/app.web'], cli: repoAdd('R1') })
  const w = await start(r)
  await w.request('act', { path: '/p/app.web', action: 'terminal' })
  assert.deepEqual(r.cli, [
    ['repo', 'add', '--path', '/p/app.web', '--json'],
    ['repo', 'set', '--repo', 'id:R1', '--external-worktree-visibility', 'show', '--json'],
    ['terminal', 'create', '--worktree', 'id:R1::/p/app.web', '--title', 'app_web', '--focus', '--json']
  ])
  assert.deepEqual(opens(r), [], 'terminal create --focus switches workspace itself; open would add a stray default shell')
  assert.deepEqual(r.git, [['-C', '/p/app.web', 'rev-parse', '--show-toplevel']])
  assert.deepEqual(w.refusals, [])
})

test('visibility is set before the terminal is created', async () => {
  const r = rig({ gitRoots: ['/p/a'], cli: repoAdd('R1') })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'terminal' })
  const verbs = r.cli.map((a) => `${a[0]} ${a[1]}`)
  assert.ok(verbs.indexOf('repo set') > verbs.indexOf('repo add'))
  assert.ok(verbs.indexOf('terminal create') > verbs.indexOf('repo set'))
})

test('terminal create that fails is retried, then the workspace is opened and it is retried again', async () => {
  let creates = 0
  const r = rig({
    gitRoots: ['/p/a'],
    cli: (a) => {
      if (a[0] === 'repo' && a[1] === 'add') return ok({ repo: { id: 'R1' } })
      if (a[0] === 'terminal') {
        creates++
        return creates <= 2 ? { ok: false, error: { code: 'not_found', message: 'workspace not ready' } } : ok({})
      }
      return undefined
    }
  })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'terminal' })
  assert.equal(creates, 3)
  assert.deepEqual(opens(r), [{ workspaceId: 'R1::/p/a' }])
  assert.ok(w.logs.some((l) => l.includes('opening the workspace and retrying')))
})

test('terminal create that never works reports the failure', async () => {
  const r = rig({
    gitRoots: ['/p/a'],
    cli: (a) => (a[0] === 'repo' && a[1] === 'add' ? ok({ repo: { id: 'R1' } }) : a[0] === 'terminal' ? { ok: false, error: { code: 'x', message: 'boom' } } : undefined)
  })
  const w = await start(r)
  const err = await w.request('act', { path: '/p/a', action: 'terminal' }).then(() => null, (e: Error) => e)
  assert.ok(err && err.message.includes('terminal create'))
})

test('git root + claude and codex launch agents with --focus', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const r = rig({ gitRoots: ['/p/a'], cli: repoAdd('R1') })
    const w = await start(r)
    await w.request('act', { path: '/p/a', action: agent })
    assert.deepEqual(r.cli.at(-1), ['agent', 'launch', '--worktree', 'id:R1::/p/a', '--agent', agent, '--focus', '--json'])
    assert.ok(!r.cli.some((a) => a[0] === 'terminal'))
    await w.deactivate()
    worker = undefined
  }
})

test('git root + worktree: a new isolated worktree, no in-place checkout, no visibility change', async () => {
  const r = rig({ gitRoots: ['/p/my.repo'], cli: repoAdd('R9') })
  const w = await start(r)
  await w.request('act', { path: '/p/my.repo', action: 'worktree' })
  assert.deepEqual(r.cli, [
    ['repo', 'add', '--path', '/p/my.repo', '--json'],
    ['worktree', 'create', '--repo', 'id:R9', '--name', 'my_repo-160509', '--no-parent', '--activate', '--agent', 'claude', '--json']
  ])
  assert.equal(r.host.callsOf('workspace.open').length, 0)
})

test('git root + open only switches workspace: no terminal, no agent', async () => {
  const r = rig({ gitRoots: ['/p/a'], cli: repoAdd('R1') })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'open' })
  assert.deepEqual(opens(r), [{ workspaceId: 'R1::/p/a' }])
  assert.ok(!r.cli.some((a) => a[0] === 'terminal' || a[0] === 'agent'))
})

test('open falls back to worktree activate for a Git target if workspace.open fails', async () => {
  const r = rig({ gitRoots: ['/p/a'], cli: repoAdd('R1') })
  r.host.respond('workspace.open', hostError('action_failed', 'nope'))
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'open' }).catch(() => {})
  assert.ok(r.cli.some((a) => a[0] === 'worktree' && a[1] === 'activate'))
})

test('non-git folder + terminal: folder project, workspace found by path, focused tab', async () => {
  const r = rig({
    cli: (a, host) => {
      if (a[0] === 'repo' && a[1] === 'add') {
        host.respond('workspace.list', {
          workspaces: [{ id: 'folder:F1', kind: 'folder', name: 'plain', path: '/p/plain', branch: null, hostId: null }],
          truncated: false
        })
        return ok({ repo: { id: 'F1' } })
      }
      if (a[0] === 'worktree' && a[1] === 'ps') {
        return ok({ worktrees: [{ path: '/p/plain', address: { worktree: 'id:F1::/p/plain' } }] })
      }
      return undefined
    }
  })
  const w = await start(r)
  await w.request('act', { path: '/p/plain', action: 'terminal' })
  assert.deepEqual(r.cli[0], ['repo', 'add', '--path', '/p/plain', '--kind', 'folder', '--json'])
  assert.deepEqual(r.cli.at(-1), ['terminal', 'create', '--worktree', 'id:F1::/p/plain', '--title', 'plain', '--focus', '--json'])
  assert.deepEqual(opens(r), [])
  assert.ok(!r.cli.some((a) => a[1] === 'set'), 'visibility is a Git-repo concern')
  assert.ok(!r.cli.some((a) => a[0] === 'worktree' && a[1] === 'activate'), 'never activate a folder workspace')
})

test('non-git folder never uses worktree activate, even when workspace.open fails', async () => {
  const r = rig({
    cli: (a, host) => {
      if (a[0] === 'repo') {
        host.respond('workspace.list', {
          workspaces: [{ id: 'folder:F1', kind: 'folder', name: 'plain', path: '/p/plain', branch: null, hostId: null }],
          truncated: false
        })
        return ok({ repo: { id: 'F1' } })
      }
      return undefined
    }
  })
  r.host.respond('workspace.open', hostError('action_failed', 'nope'))
  const w = await start(r)
  const err = await w.request('act', { path: '/p/plain', action: 'open' }).then(() => null, (e: Error) => e)
  assert.ok(err, 'open must fail loudly instead of calling worktree activate')
  assert.ok(!r.cli.some((a) => a[0] === 'worktree' && a[1] === 'activate'))
})

test('non-git folder + worktree falls back to a terminal and says why in the log', async () => {
  const r = rig({
    cli: (a, host) => {
      if (a[0] === 'repo') {
        host.respond('workspace.list', {
          workspaces: [{ id: 'folder:F1', kind: 'folder', name: 'plain', path: '/p/plain', branch: null, hostId: null }],
          truncated: false
        })
        return ok({ repo: { id: 'F1' } })
      }
      return undefined
    }
  })
  const w = await start(r)
  await w.request('act', { path: '/p/plain', action: 'worktree' })
  assert.ok(!r.cli.some((a) => a[0] === 'worktree' && a[1] === 'create'))
  assert.equal(r.cli.at(-1)?.[0], 'terminal')
  assert.ok(w.logs.some((l) => l.includes('not a Git repository root')))
  assert.equal(r.host.callsOf('notifications.show').length, 0)
  assert.deepEqual(w.refusals, [])
})

test('a subfolder inside a repo is a folder, not a repo root', async () => {
  const r = rig({ gitRoots: ['/p/repo'], cli: (a, host) => {
    if (a[0] === 'repo') {
      host.respond('workspace.list', { workspaces: [{ id: 'folder:S', kind: 'folder', name: 's', path: '/p/repo/sub', branch: null, hostId: null }], truncated: false })
      return ok({ repo: { id: 'S' } })
    }
    return undefined
  } })
  const w = await start(r)
  await w.request('act', { path: '/p/repo/sub', action: 'terminal' })
  assert.deepEqual(r.cli[0], ['repo', 'add', '--path', '/p/repo/sub', '--kind', 'folder', '--json'])
})

/** `orca worktree ps` as Orca 1.4.257 prints it: repoId and the exact selector, for given paths. */
const psFor = (rows: { path: string; repoId: string; selector: string }[]) => (a: string[]): CliReply | undefined =>
  a[0] === 'worktree' && a[1] === 'ps'
    ? ok({ worktrees: rows.map((r) => ({ path: r.path, repoId: r.repoId, address: { worktree: r.selector } })) })
    : undefined

test('a folder Orca already has is reused with the selector ps prints: no repo add, no git probe', async () => {
  // Real 1.4.257 shape: a Git workspace id is opaque (identity:wt2:...), it does not contain the repo id.
  const r = rig({
    workspaces: [{ id: 'identity:wt2:local:u1', kind: 'worktree', path: '/p/a' }],
    gitRoots: ['/p/a'],
    cli: psFor([{ path: '/p/a', repoId: 'R1', selector: 'identity:wt2:local:u1' }])
  })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'terminal' })
  assert.ok(!r.cli.some((a) => a[0] === 'repo'), 'no repo add for a folder Orca already shows')
  assert.deepEqual(r.cli.at(-1), ['terminal', 'create', '--worktree', 'identity:wt2:local:u1', '--title', 'a', '--focus', '--json'])
  assert.deepEqual(r.git, [], 'no git probe needed for a known workspace')
})

test('REGRESSION: the repo id for a new worktree comes from ps, never from parsing the workspace id', async () => {
  const r = rig({
    workspaces: [{ id: 'identity:wt2:local:u1', kind: 'worktree', path: '/p/a' }],
    cli: psFor([{ path: '/p/a', repoId: 'REPO-7', selector: 'identity:wt2:local:u1' }])
  })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'worktree' })
  assert.deepEqual(r.cli.at(-1), ['worktree', 'create', '--repo', 'id:REPO-7', '--name', 'a-160509', '--no-parent', '--activate', '--agent', 'claude', '--json'])
})

test('a known Git workspace whose repo id cannot be read falls back to a terminal instead of guessing', async () => {
  const r = rig({ workspaces: [{ id: 'identity:wt2:local:u1', kind: 'worktree', path: '/p/a' }] })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'worktree' })
  assert.ok(!r.cli.some((a) => a[0] === 'worktree' && a[1] === 'create'), 'must not call worktree create with a made-up repo id')
  assert.deepEqual(r.cli.at(-1), ['terminal', 'create', '--worktree', 'path:/p/a', '--title', 'a', '--focus', '--json'])
  assert.ok(w.logs.some((l) => l.includes('not a Git repository root')))
})

test('open on a freshly added Git root uses the id workspace.list reports, not a synthesized one', async () => {
  const r = rig({
    gitRoots: ['/p/a'],
    cli: (a, host) => {
      if (a[0] === 'repo' && a[1] === 'add') return ok({ repo: { id: 'R1' } })
      if (a[0] === 'repo' && a[1] === 'set') {
        host.respond('workspace.list', {
          workspaces: [{ id: 'identity:wt2:local:n1', kind: 'worktree', name: 'a', path: '/p/a', branch: null, hostId: null }],
          truncated: false
        })
        return ok({})
      }
      return undefined
    }
  })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'open' })
  assert.deepEqual(opens(r), [{ workspaceId: 'identity:wt2:local:n1' }])
})

test('trailing slashes and aliases are canonicalized before comparing', async () => {
  const r = rig({ gitRoots: ['/real/a'], cli: repoAdd('R1'), deps: { realpath: async (p) => p.replace(/^\/alias/, '/real') } })
  const w = await start(r)
  await w.request('act', { path: '/alias/a/', action: 'terminal' })
  assert.deepEqual(r.cli[0], ['repo', 'add', '--path', '/real/a', '--json'])
  assert.deepEqual(r.host.data().storage.mruPaths, ['/real/a'])
})

test('MRU keeps newest first across picks', async () => {
  const r = rig({ gitRoots: ['/p/a', '/p/b'], cli: repoAdd('R1'), storage: { mruPaths: ['/p/a', '/p/z'] } })
  const w = await start(r)
  await w.request('act', { path: '/p/b', action: 'terminal' })
  await w.request('act', { path: '/p/a', action: 'terminal' })
  assert.deepEqual(r.host.data().storage.mruPaths, ['/p/a', '/p/b', '/p/z'])
})

test('a CLI that keeps failing surfaces as an error naming the step', async () => {
  const r = rig({ gitRoots: ['/p/a'], cli: (a) => (a[0] === 'repo' && a[1] === 'add' ? { ok: false, error: { code: 'bad', message: 'no such repo' } } : undefined) })
  const w = await start(r)
  const err = await w.request('act', { path: '/p/a', action: 'terminal' }).then(() => null, (e: Error) => e)
  assert.ok(err && err.message.includes('repo add'))
})

test('act rejects malformed input', async () => {
  const r = rig({})
  const w = await start(r)
  for (const bad of [{}, { path: 'rel', action: 'terminal' }, { path: '/a', action: 'delete' }]) {
    const err = await w.request('act', bad as never).then(() => null, (e: Error) => e)
    assert.ok(err, JSON.stringify(bad))
  }
})

test('the whole run is permitted by the manifest capabilities', async () => {
  const r = rig({ gitRoots: ['/p/a'], cli: repoAdd('R1') })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'claude' })
  await w.request('act', { path: '/p/a', action: 'open' })
  assert.deepEqual(w.refusals, [])
  assert.deepEqual(r.host.refusals, [])
})

// ---------------------------------------------------------------------------------------------
// Worktree chooser: what the picker is told

type PsRowIn = {
  path: string
  repoId: string
  branch?: string
  main?: boolean
  archived?: boolean
  kind?: string
  hostId?: string
  selector?: string
}

/** A row of `orca worktree ps --json` as Orca 1.4.257 prints it. */
const psRowOf = (o: PsRowIn) => ({
  workspaceKind: o.kind ?? 'git',
  repoId: o.repoId,
  path: o.path,
  branch: o.branch ?? '',
  isMainWorktree: o.main ?? false,
  isArchived: o.archived ?? false,
  hostId: o.hostId ?? 'local',
  worktreeId: `${o.repoId}::${o.path}`,
  address: { worktree: o.selector ?? `id:${o.repoId}::${o.path}` }
})
const PS = ['worktree', 'ps', '--limit', '1000', '--json']
const psWith = (rows: PsRowIn[], extra: Record<string, unknown> = {}) => (a: string[]): CliReply | undefined =>
  a[0] === 'worktree' && a[1] === 'ps' ? ok({ worktrees: rows.map(psRowOf), truncated: false, ...extra }) : undefined
/** `worktree create --json` prints the new worktree; its id is `<repoId>::<path>`. */
const createdAs = (id: string) => (a: string[]): CliReply | undefined =>
  a[0] === 'worktree' && a[1] === 'create' ? ok({ worktree: { id } }) : undefined
const firstReply = (...fns: ((a: string[], h: Rig['host']) => CliReply | undefined)[]) => (a: string[], h: Rig['host']) => {
  for (const f of fns) {
    const reply = f(a, h)
    if (reply) return reply
  }
  return undefined
}

/**
 * Presses the command and returns the request the picker would have received. Overrides are global,
 * so a trigger an earlier test left in flight can land here too: only a request built from this
 * section's own scan root (`/q`) counts.
 */
async function pickerRequest(r: Rig): Promise<{ req: PickerRequest; w: TestWorker }> {
  let seen: PickerRequest | null = null
  main.setDeps({
    runPicker: async (_bin, request) => {
      if (request.items.every((i) => i.path.startsWith('/q/'))) seen = request
      return null
    }
  })
  const w = await start(r)
  await w.command('folder-sessionizer.open')
  await waitFor(() => seen !== null, 'picker request')
  return { req: seen as unknown as PickerRequest, w }
}

/** A picker that answers with `pick` for this section's own requests and cancels for a stray one. */
const pickOnly = (pick: PickerPick): Deps['runPicker'] => async (_bin, request) =>
  request.items.every((i) => i.path.startsWith('/q/')) ? pick : null

const scanQ = { settings: { searchRoots: '/q' }, deps: { subdirs: async (d: string) => (d === '/q' ? ['a', 'b', 'c'] : []) } }

test('picker items carry the worktrees Orca lists, grouped by repo, on the main checkout only', async () => {
  const r = rig({
    ...scanQ,
    cli: psWith([
      { repoId: 'R1', path: '/q/a', branch: 'refs/heads/main', main: true },
      { repoId: 'R1', path: '/w/a-feat', branch: 'refs/heads/feat/x' },
      // Orca also lists a second workspace on the main checkout: same path, no branch.
      { repoId: 'R1', path: '/q/a' },
      { repoId: 'R2', path: '/q/b', branch: 'refs/heads/dev', main: true }
    ])
  })
  const { req } = await pickerRequest(r)
  assert.deepEqual(req.items, [
    {
      path: '/q/a',
      open: false,
      worktrees: [
        { path: '/q/a', branch: 'main', main: true },
        { path: '/w/a-feat', branch: 'feat/x', main: false }
      ]
    },
    { path: '/q/b', open: false, worktrees: [{ path: '/q/b', branch: 'dev', main: true }] },
    { path: '/q/c', open: false }
  ])
  assert.deepEqual(r.cli, [PS], 'one ps call for the whole list, however many folders')
})

test('archived worktrees, folder workspaces and other hosts never reach the chooser', async () => {
  const r = rig({
    ...scanQ,
    cli: psWith([
      { repoId: 'R1', path: '/q/a', branch: 'refs/heads/main', main: true },
      { repoId: 'R1', path: '/w/a-old', branch: 'refs/heads/old', archived: true },
      { repoId: 'R1', path: '/w/a-folder', kind: 'folder' },
      { repoId: 'R1', path: '/w/a-remote', branch: 'refs/heads/r', hostId: 'ssh:box' }
    ])
  })
  const { req } = await pickerRequest(r)
  assert.deepEqual(req.items[0].worktrees, [{ path: '/q/a', branch: 'main', main: true }])
})

test('picker items have no worktrees field when ps lists none, fails, is cut off or has no main checkout', async () => {
  const plain = [{ path: '/q/a', open: false }, { path: '/q/b', open: false }, { path: '/q/c', open: false }]
  const cases: [string, Parameters<typeof rig>[0]['cli'], string | null][] = [
    ['ps lists nothing', psWith([]), null],
    ['ps has only a non-main worktree', psWith([{ repoId: 'R1', path: '/q/a', branch: 'refs/heads/x' }]), null],
    ['ps throws', () => { throw new Error('orca is not running') }, 'worktree ps failed: orca is not running'],
    ['ps is truncated', psWith([{ repoId: 'R1', path: '/q/a', branch: 'refs/heads/main', main: true }], { truncated: true }), 'truncated'],
    ['ps is not a list', () => ok({ worktrees: 'no' }), 'worktree ps returned no worktree list']
  ]
  for (const [what, cli, logged] of cases) {
    const r = rig({ ...scanQ, cli })
    const { req, w } = await pickerRequest(r)
    assert.deepEqual(req.items, plain, what)
    if (logged) assert.ok(w.logs.some((l) => l.includes(logged)), `${what}: logs a line`)
    await w.deactivate()
    worker = undefined
  }
})

test('worktree paths are canonicalized like picker items', async () => {
  const r = rig({
    ...scanQ,
    deps: { ...scanQ.deps, realpath: async (p) => p.replace(/^\/alias/, '/q') },
    cli: psWith([
      { repoId: 'R1', path: '/alias/a/', branch: 'refs/heads/main', main: true },
      { repoId: 'R1', path: '/alias/a-wt', branch: 'refs/heads/wt' }
    ])
  })
  const { req } = await pickerRequest(r)
  assert.deepEqual(req.items[0].worktrees, [
    { path: '/q/a', branch: 'main', main: true },
    { path: '/q/a-wt', branch: 'wt', main: false }
  ])
})

// ---------------------------------------------------------------------------------------------
// Worktree chooser: an existing worktree

const KNOWN = [
  { id: 'identity:wt2:local:u1', kind: 'worktree' as const, path: '/p/a' },
  { id: 'identity:wt2:local:u2', kind: 'worktree' as const, path: '/w/a.feat' }
]
const REPO_A: PsRowIn[] = [
  { repoId: 'R1', path: '/p/a', branch: 'refs/heads/main', main: true, selector: 'identity:wt2:local:u1' },
  { repoId: 'R1', path: '/w/a.feat', branch: 'refs/heads/feat/x', selector: 'identity:wt2:local:u2' }
]

test('existing worktree + terminal / claude / codex: the same CLI call as a folder, aimed at id:<repo>::<path>', async () => {
  for (const action of ['terminal', 'claude', 'codex'] as const) {
    const r = rig({ workspaces: KNOWN, gitRoots: ['/p/a'], cli: psWith(REPO_A) })
    const w = await start(r)
    await w.request('act', { path: '/p/a', action, worktreePath: '/w/a.feat' })
    const call =
      action === 'terminal'
        ? ['terminal', 'create', '--worktree', 'id:R1::/w/a.feat', '--title', 'a_feat', '--focus', '--json']
        : ['agent', 'launch', '--worktree', 'id:R1::/w/a.feat', '--agent', action, '--focus', '--json']
    assert.deepEqual(r.cli, [PS, call], action)
    assert.deepEqual(r.git, [], 'no git probe and no repo add: Orca already knows the worktree')
    assert.deepEqual(opens(r), [])
    await w.deactivate()
    worker = undefined
  }
})

test('existing worktree + open switches to that workspace; with none listed it falls back to the worktree id', async () => {
  const known = rig({ workspaces: KNOWN, cli: psWith(REPO_A) })
  const w1 = await start(known)
  await w1.request('act', { path: '/p/a', action: 'open', worktreePath: '/w/a.feat' })
  assert.deepEqual(opens(known), [{ workspaceId: 'identity:wt2:local:u2' }])
  assert.deepEqual(known.cli, [PS])
  await w1.deactivate()
  worker = undefined

  const unlisted = rig({ cli: psWith(REPO_A) })
  const w2 = await start(unlisted)
  await w2.request('act', { path: '/p/a', action: 'open', worktreePath: '/w/a.feat' })
  assert.deepEqual(opens(unlisted), [{ workspaceId: 'R1::/w/a.feat' }])
  assert.ok(!unlisted.cli.some((a) => a[0] === 'terminal' || a[0] === 'agent'))
})

test('choosing the main checkout in the chooser is exactly a plain pick of the folder', async () => {
  const mk = () => rig({ workspaces: KNOWN, cli: psWith(REPO_A) })
  const plain = mk()
  const w1 = await start(plain)
  await w1.request('act', { path: '/p/a', action: 'claude' })
  await w1.deactivate()
  worker = undefined
  assert.deepEqual(plain.cli.at(-1), ['agent', 'launch', '--worktree', 'identity:wt2:local:u1', '--agent', 'claude', '--focus', '--json'])

  const viaChooser = mk()
  const w2 = await start(viaChooser)
  await w2.request('act', { path: '/p/a', action: 'claude', worktreePath: '/p/a' })
  assert.deepEqual(viaChooser.cli, plain.cli)
})

test('under a symlinked root the selector keeps the path as Orca prints it, and matching uses the real one', async () => {
  const r = rig({
    deps: { realpath: async (p) => p.replace(/^\/alias/, '/p') },
    cli: psWith([
      { repoId: 'R1', path: '/alias/a', branch: 'refs/heads/main', main: true },
      { repoId: 'R1', path: '/alias/a-feat', branch: 'refs/heads/feat' }
    ])
  })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'terminal', worktreePath: '/p/a-feat' })
  assert.deepEqual(r.cli.at(-1), ['terminal', 'create', '--worktree', 'id:R1::/alias/a-feat', '--title', 'a-feat', '--focus', '--json'])
})

test('an existing worktree is checked against ps before anything is launched', async () => {
  const rows: PsRowIn[] = [
    ...REPO_A,
    { repoId: 'R1', path: '/w/a-old', branch: 'refs/heads/old', archived: true },
    { repoId: 'R2', path: '/p/b', branch: 'refs/heads/main', main: true }
  ]
  const r = rig({ workspaces: KNOWN, cli: psWith(rows) })
  const w = await start(r)
  const attempt = (worktreePath: string) =>
    w.request('act', { path: '/p/a', action: 'terminal', worktreePath }).then(() => null, (e: Error) => e)
  const unknown = await attempt('/w/nope')
  assert.ok(unknown && unknown.message.includes('worktree ps') && unknown.message.includes('/w/nope'))
  const archived = await attempt('/w/a-old')
  assert.ok(archived && archived.message.includes('/w/a-old'), 'an archived worktree is not selectable')
  const other = await attempt('/p/b')
  assert.ok(other && other.message.includes('another repo'))
  assert.ok(!r.cli.some((a) => a[0] === 'terminal' || a[0] === 'agent'))
})

test('the worktree action cannot also name an existing worktree, and neither can a new one', async () => {
  const r = rig({ workspaces: KNOWN, cli: psWith(REPO_A) })
  const w = await start(r)
  const err = await w.request('act', { path: '/p/a', action: 'worktree', worktreePath: '/w/a.feat' }).then(() => null, (e: Error) => e)
  assert.ok(err && err.message.includes('worktreePath'))
  for (const bad of [
    { path: '/p/a', action: 'terminal', worktreePath: '/w/a.feat', newWorktree: 'x' },
    { path: '/p/a', action: 'terminal', worktreePath: 'rel' },
    { path: '/p/a', action: 'terminal', newWorktree: 3 }
  ]) {
    assert.ok(await w.request('act', bad as never).then(() => null, (e: Error) => e), JSON.stringify(bad))
  }
  assert.ok(!r.cli.some((a) => a[0] === 'terminal' || a[0] === 'agent' || a[0] === 'worktree' && a[1] === 'create'))
})

test('the MRU remembers the folder, not the worktree that was picked in it', async () => {
  const r = rig({ workspaces: KNOWN, cli: psWith(REPO_A) })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'terminal', worktreePath: '/w/a.feat' })
  assert.deepEqual(r.host.data().storage.mruPaths, ['/p/a'])
})

test('a worktree picked in the picker flows through trigger to Orca', async () => {
  const r = rig({
    ...scanQ,
    workspaces: [{ id: 'identity:wt2:local:u2', kind: 'worktree', path: '/w/a.feat' }],
    cli: psWith([
      { repoId: 'R1', path: '/q/a', branch: 'refs/heads/main', main: true },
      { repoId: 'R1', path: '/w/a.feat', branch: 'refs/heads/feat/x' }
    ])
  })
  main.setDeps({ runPicker: pickOnly({ path: '/q/a', action: 'claude', worktreePath: '/w/a.feat' }) })
  const w = await start(r)
  await w.command('folder-sessionizer.open')
  await waitFor(() => r.cli.some((a) => a[0] === 'agent'), 'agent launch')
  assert.deepEqual(r.cli.at(-1), ['agent', 'launch', '--worktree', 'id:R1::/w/a.feat', '--agent', 'claude', '--focus', '--json'])
  assert.deepEqual(r.host.data().storage.mruPaths, ['/q/a'])
})

// ---------------------------------------------------------------------------------------------
// Worktree chooser: a new worktree

const CREATE = (name: string, agent?: string) => [
  'worktree', 'create', '--repo', 'id:R1', '--name', name, '--no-parent', '--activate', ...(agent ? ['--agent', agent] : []), '--json'
]
const ADD = ['repo', 'add', '--path', '/p/app.web', '--json']
const newRig = () => rig({ gitRoots: ['/p/app.web'], cli: firstReply(repoAdd('R1'), createdAs('R1::/o/app.web/fix-login')) })

test('new worktree + claude / codex: repo add, then create with that agent and no visibility change', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const r = newRig()
    const w = await start(r)
    await w.request('act', { path: '/p/app.web', action: agent, newWorktree: 'Fix Login' })
    assert.deepEqual(r.cli, [ADD, CREATE('fix-login', agent)], agent)
    await w.deactivate()
    worker = undefined
  }
})

test('new worktree + terminal: create without an agent, then a focused terminal in the id create printed', async () => {
  const r = newRig()
  const w = await start(r)
  await w.request('act', { path: '/p/app.web', action: 'terminal', newWorktree: 'Fix Login' })
  assert.deepEqual(r.cli, [
    ADD,
    CREATE('fix-login'),
    ['terminal', 'create', '--worktree', 'id:R1::/o/app.web/fix-login', '--title', 'fix-login', '--focus', '--json']
  ])
  assert.deepEqual(opens(r), [])
})

test('new worktree + open only creates and activates: no agent, no terminal, no workspace switch', async () => {
  const r = newRig()
  const w = await start(r)
  await w.request('act', { path: '/p/app.web', action: 'open', newWorktree: 'Fix Login' })
  assert.deepEqual(r.cli, [ADD, CREATE('fix-login')])
  assert.deepEqual(opens(r), [])
})

test('new worktree names: typed text is slugged, empty or unusable text gets the automatic name', async () => {
  const names: [string, string][] = [
    ['Fix the Login Bug!', 'fix-the-login-bug'],
    ['  feat/OAuth2  ', 'feat-oauth2'],
    ['', 'app_web-160509'],
    ['!!!', 'app_web-160509']
  ]
  for (const [typed, expected] of names) {
    const r = newRig()
    const w = await start(r)
    await w.request('act', { path: '/p/app.web', action: 'claude', newWorktree: typed })
    assert.deepEqual(r.cli.at(-1), CREATE(expected, 'claude'), JSON.stringify(typed))
    await w.deactivate()
    worker = undefined
  }
})

test('new worktree with the worktree action means a new worktree with Claude', async () => {
  const r = newRig()
  const w = await start(r)
  await w.request('act', { path: '/p/app.web', action: 'worktree', newWorktree: 'x' })
  assert.deepEqual(r.cli, [ADD, CREATE('x', 'claude')])
})

test('new worktree in a repo Orca already shows takes the repo id from ps, with no repo add', async () => {
  const r = rig({ workspaces: KNOWN, cli: firstReply(psWith(REPO_A), createdAs('R1::/o/a/idea')) })
  const w = await start(r)
  await w.request('act', { path: '/p/a', action: 'codex', newWorktree: 'idea' })
  assert.deepEqual(r.cli, [PS, CREATE('idea', 'codex')])
  assert.deepEqual(r.git, [])
})

test('new worktree on a folder that is not a Git root falls back to a terminal and says why', async () => {
  const r = rig({
    cli: (a, host) => {
      if (a[0] === 'repo') {
        host.respond('workspace.list', {
          workspaces: [{ id: 'folder:F1', kind: 'folder', name: 'plain', path: '/p/plain', branch: null, hostId: null }],
          truncated: false
        })
        return ok({ repo: { id: 'F1' } })
      }
      return undefined
    }
  })
  const w = await start(r)
  await w.request('act', { path: '/p/plain', action: 'claude', newWorktree: 'x' })
  assert.ok(!r.cli.some((a) => a[0] === 'worktree' && a[1] === 'create'))
  assert.equal(r.cli.at(-1)?.[0], 'terminal')
  assert.ok(w.logs.some((l) => l.includes('not a Git repository root')))
})

test('new worktree + terminal fails by name when create prints no id, and a failed create stops everything', async () => {
  const noId = rig({ gitRoots: ['/p/app.web'], cli: repoAdd('R1') })
  const w1 = await start(noId)
  const err = await w1.request('act', { path: '/p/app.web', action: 'terminal', newWorktree: 'x' }).then(() => null, (e: Error) => e)
  assert.ok(err && err.message.includes('worktree create'))
  assert.ok(!noId.cli.some((a) => a[0] === 'terminal'))
  await w1.deactivate()
  worker = undefined

  const failing = rig({
    gitRoots: ['/p/app.web'],
    cli: (a) => (a[0] === 'repo' ? ok({ repo: { id: 'R1' } }) : a[0] === 'worktree' ? { ok: false, error: { code: 'x', message: 'branch exists' } } : undefined)
  })
  const w2 = await start(failing)
  const err2 = await w2.request('act', { path: '/p/app.web', action: 'terminal', newWorktree: 'x' }).then(() => null, (e: Error) => e)
  assert.ok(err2 && err2.message.includes('worktree create') && err2.message.includes('branch exists'))
  assert.ok(!failing.cli.some((a) => a[0] === 'terminal'))
})

test('the worktree action on a folder is unchanged: repo add, then create with Claude and the automatic name', async () => {
  const r = rig({ gitRoots: ['/p/my.repo'], cli: repoAdd('R9') })
  const w = await start(r)
  await w.request('act', { path: '/p/my.repo', action: 'worktree' })
  assert.deepEqual(r.cli, [
    ['repo', 'add', '--path', '/p/my.repo', '--json'],
    ['worktree', 'create', '--repo', 'id:R9', '--name', 'my_repo-160509', '--no-parent', '--activate', '--agent', 'claude', '--json']
  ])
})

test('a new worktree picked in the picker flows through trigger, and the MRU remembers the folder', async () => {
  const r = rig({ ...scanQ, gitRoots: ['/q/a'], cli: firstReply(repoAdd('R1'), createdAs('R1::/o/a/idea')) })
  main.setDeps({ runPicker: pickOnly({ path: '/q/a', action: 'claude', newWorktree: 'idea' }) })
  const w = await start(r)
  await w.command('folder-sessionizer.open')
  await waitFor(() => r.cli.some((a) => a[0] === 'worktree' && a[1] === 'create'), 'worktree create')
  assert.deepEqual(r.cli.at(-1), ['worktree', 'create', '--repo', 'id:R1', '--name', 'idea', '--no-parent', '--activate', '--agent', 'claude', '--json'])
  assert.deepEqual(r.host.data().storage.mruPaths, ['/q/a'])
})

// ---------------------------------------------------------------------------------------------
// Picker theme

/** GitHub Dark Default's tokens, as a plugin theme file lists them (a fixture: no logic depends on these values). */
const DARK_TOKENS: ThemeTokens = {
  '--background': '#0d1117',
  '--card': '#010409',
  '--popover': '#161b22',
  '--foreground': '#e6edf3',
  '--muted-foreground': '#7d8590',
  '--border': '#30363d',
  '--accent': '#171b22',
  '--ring': '#1f6feb',
  '--primary': '#238636'
}
const DARK_PALETTE = {
  background: '#0d1117',
  popover: '#161b22',
  foreground: '#e6edf3',
  mutedForeground: '#7d8590',
  border: '#30363d',
  accent: '#171b22',
  ring: '#1f6feb'
}
const LIGHT_TOKENS: ThemeTokens = { '--background': '#fffaf0', '--foreground': '#1a1a1a' }

/** A plugins folder in memory: `readFile` takes paths relative to it, and fails like a missing file. */
function pluginFiles(files: Record<string, string>, reads: string[] = []): (rel: string) => Promise<string> {
  return async (rel) => {
    reads.push(rel)
    const text = files[rel]
    if (text === undefined) throw new Error(`ENOENT ${rel}`)
    return text
  }
}
/** A theme package `<pkg>` with one theme, in the layout Orca installs: `current`, `<hash>/orca-plugin.json`, the theme file. */
function themePackage(pkg: string, id: string, tokens: unknown, hash = 'abc123', path = 'themes/t.json'): Record<string, string> {
  return {
    [`${pkg}/current`]: `${hash}\n`,
    [`${pkg}/${hash}/orca-plugin.json`]: JSON.stringify({ id: 'x', contributes: { themes: [{ id: 'other', path: 'themes/o.json' }, { id, title: 'T', path }] } }),
    [`${pkg}/${hash}/${path}`]: JSON.stringify({ schemaVersion: 1, base: 'dark', tokens })
  }
}
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return assert.fail('expected a rejection')
}

test('parseColor: 3, 4, 6 and 8 digit hex, rgb, rgba and hsl normalize to #rrggbb[aa]', () => {
  const cases: [string, string][] = [
    ['#fff', '#ffffff'],
    ['#ABC', '#aabbcc'],
    ['#abcd', '#aabbccdd'],
    ['#0d1117', '#0d1117'],
    ['  #0D1117 ', '#0d1117'],
    ['#ffffff12', '#ffffff12'],
    ['#ffffffff', '#ffffff'],
    ['rgb(13, 17, 23)', '#0d1117'],
    ['rgb(13 17 23)', '#0d1117'],
    ['rgb(100% 0% 0%)', '#ff0000'],
    ['rgb(300, -5, 0)', '#ff0000'],
    ['rgba(255, 255, 255, 0.07)', '#ffffff12'],
    ['rgb(0 0 0 / 50%)', '#00000080'],
    ['hsl(0 0% 100%)', '#ffffff'],
    ['hsl(210, 100%, 50%)', '#0080ff'],
    ['hsla(120, 100%, 25%, 0.5)', '#00800080'],
    ['hsl(0.5turn 100% 50%)', '#00ffff'],
    ['hsl(-120 100% 50%)', '#0000ff']
  ]
  for (const [input, expected] of cases) assert.equal(main.parseColor(input), expected, input)
})

test('parseColor: other formats and garbage are undefined, never a guess', () => {
  for (const bad of [
    'oklch(0.2 0.01 250)',
    'oklab(0.2 0 0)',
    'color-mix(in srgb, #fff 50%, #000)',
    'red',
    'transparent',
    'var(--background)',
    'rgb(var(--x) 0 0)',
    '#12',
    '#12345',
    '#1234567',
    '#gggggg',
    'rgb(1, 2)',
    'rgb(a, b, c)',
    'rgb(1 2 3 4 5)',
    'hsl(x 1% 1%)',
    ''
  ]) {
    assert.equal(main.parseColor(bad), undefined, JSON.stringify(bad))
  }
})

test('pickThemeIds takes the mode and the two plugin ids, and nothing else', () => {
  const dark = 'plugin:stablyai.pkg/dark-t'
  assert.deepEqual(main.pickThemeIds({ theme: 'dark', pluginAppThemeDark: dark, pluginAppThemeLight: null }), { mode: 'dark', dark, light: null })
  assert.deepEqual(main.pickThemeIds({ theme: 'light', pluginAppThemeLight: 'plugin:a.b/c' }), { mode: 'light', dark: null, light: 'plugin:a.b/c' })
  assert.equal(main.pickThemeIds({ theme: 'system' }).mode, 'system')
  // Orca's default is `system`: that is what a missing or unknown value means.
  for (const settings of [{}, { theme: 'solarized' }, { theme: 7 }, null, 'text', []]) {
    assert.deepEqual(main.pickThemeIds(settings), { mode: 'system', dark: null, light: null }, JSON.stringify(settings))
  }
  // Only plugin ids count; anything else in a slot is "no plugin theme".
  assert.equal(main.pickThemeIds({ pluginAppThemeDark: 'github-dark' }).dark, null)
  assert.equal(main.pickThemeIds({ pluginAppThemeDark: 5 }).dark, null)
  assert.deepEqual(Object.keys(main.pickThemeIds({ theme: 'dark', githubToken: 'ghp_SECRET', apiKey: 'sk-SECRET' })).sort(), ['dark', 'light', 'mode'])
})

test('a theme is found through current, then the manifest, then the theme file', async () => {
  const reads: string[] = []
  const files = themePackage('stablyai.pkg', 'dark-t', { ...DARK_TOKENS, '--chart-1': 7, '--x': { nested: true } })
  assert.deepEqual(await main.resolveThemeTokens('plugin:stablyai.pkg/dark-t', pluginFiles(files, reads)), DARK_TOKENS, 'non-string values are dropped')
  assert.deepEqual(reads, ['stablyai.pkg/current', 'stablyai.pkg/abc123/orca-plugin.json', 'stablyai.pkg/abc123/themes/t.json'])
})

test('a theme that cannot be resolved fails with a plain reason, and no hostile path is ever read', async () => {
  const good = themePackage('p.q', 't', DARK_TOKENS)
  const cases: [string, string, Record<string, string>, string][] = [
    ['plugin not installed', 'plugin:p.q/t', {}, 'not installed'],
    ['manifest missing', 'plugin:p.q/t', { 'p.q/current': 'abc123' }, 'manifest'],
    ['manifest is not JSON', 'plugin:p.q/t', { 'p.q/current': 'abc123', 'p.q/abc123/orca-plugin.json': '{' }, 'manifest'],
    ['theme not offered', 'plugin:p.q/nope', good, 'does not offer'],
    ['theme file missing', 'plugin:p.q/t', { ...good, 'p.q/abc123/themes/t.json': undefined as never }, 'theme file'],
    ['no required tokens', 'plugin:p.q/t', themePackage('p.q', 't', { '--popover': '#111111' }), '--background'],
    ['not a plugin id', 'github-dark', good, 'not a plugin theme id'],
    ['package traversal', 'plugin:../x/t', good, 'not a plugin theme id'],
    ['hash traversal', 'plugin:p.q/t', themePackage('p.q', 't', DARK_TOKENS, '../../elsewhere'), 'not installed'],
    ['absolute theme path', 'plugin:p.q/t', themePackage('p.q', 't', DARK_TOKENS, 'abc123', '/etc/passwd'), 'plain relative path'],
    ['theme path with ..', 'plugin:p.q/t', themePackage('p.q', 't', DARK_TOKENS, 'abc123', 'themes/../../../x.json'), 'plain relative path']
  ]
  for (const [what, id, files, reason] of cases) {
    const reads: string[] = []
    const message = await failure(main.resolveThemeTokens(id, pluginFiles(files, reads)))
    assert.ok(message.includes(reason), `${what}: "${message}" should mention "${reason}"`)
    assert.ok(!reads.some((r) => r.includes('..') || r.startsWith('/')), `${what}: read ${JSON.stringify(reads)}`)
  }
  // A leading ./ in a manifest path is fine.
  const dotted = themePackage('p.q', 't', DARK_TOKENS, 'abc123', './themes/t.json')
  dotted['p.q/abc123/themes/t.json'] = dotted['p.q/abc123/./themes/t.json']
  assert.deepEqual(await main.resolveThemeTokens('plugin:p.q/t', pluginFiles(dotted)), DARK_TOKENS)
})

test('a complete theme becomes the palette unchanged', () => {
  assert.deepEqual(main.paletteFromTokens(DARK_TOKENS), DARK_PALETTE)
})

test('omitted tokens are derived the way Orca does, with the mixes computed, not left out', () => {
  const bg = { '--background': '#000000', '--foreground': '#ffffff' }
  // popover from background, muted text 70 %, border 16 % and accent 12 % of foreground over background, ring from foreground.
  assert.deepEqual(main.paletteFromTokens(bg), {
    background: '#000000',
    popover: '#000000',
    foreground: '#ffffff',
    mutedForeground: '#b3b3b3',
    border: '#292929',
    accent: '#1f1f1f',
    ring: '#ffffff'
  })
  assert.equal(main.paletteFromTokens({ ...bg, '--card': '#111111' }).popover, '#111111', 'popover follows card')
  assert.equal(main.paletteFromTokens({ ...bg, '--card': '#111111', '--popover': '#222222' }).popover, '#222222')
  assert.equal(main.paletteFromTokens({ ...bg, '--primary': 'rgb(0 128 255)' }).ring, '#0080ff', 'ring follows primary')
  assert.equal(main.paletteFromTokens({ ...bg, '--primary': '#123456', '--ring': '#abcdef' }).ring, '#abcdef')
  // Values in rgb / hsl are normalized like everything else.
  assert.equal(main.paletteFromTokens({ ...bg, '--border': 'rgba(255, 255, 255, 0.07)', '--accent': 'hsl(0 0% 100%)' }).border, '#ffffff12')
})

test('a token the picker cannot parse is left out, and so is whatever would be derived from it', () => {
  const withOklch = main.paletteFromTokens({ ...DARK_TOKENS, '--popover': 'oklch(0.2 0.01 250)' })
  assert.ok(!('popover' in withOklch))
  assert.equal(withOklch.border, '#30363d')
  // No usable background: nothing mixed from it, and the surface follows it.
  const noBackground = main.paletteFromTokens({ '--background': 'oklch(0.1 0 0)', '--foreground': '#ffffff' })
  assert.deepEqual(noBackground, { foreground: '#ffffff', ring: '#ffffff' })
})

test('both palettes are built: tokens complete a slot, the built-in palette fills any other', () => {
  assert.deepEqual(main.buildThemePayload('dark', DARK_TOKENS, undefined), {
    schemaVersion: 1,
    mode: 'dark',
    palettes: { dark: DARK_PALETTE, light: main.BUILTIN_PALETTES.light }
  })
  const none = main.buildThemePayload('system', undefined, undefined)
  assert.deepEqual(none.palettes, main.BUILTIN_PALETTES)
  assert.notEqual(none.palettes.dark, main.BUILTIN_PALETTES.dark, 'a copy: the shared table is never handed out')
  for (const palette of Object.values(main.BUILTIN_PALETTES)) {
    assert.deepEqual(Object.keys(palette).sort(), [...main.THEME_KEYS].sort())
    for (const hex of Object.values(palette)) assert.equal(main.parseColor(hex), hex, `built-in ${hex} is normalized`)
  }
})

test('the picker holds the same built-in palettes as the worker', async () => {
  const { promises: fs } = await import('node:fs')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const swift = await fs.readFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'swift', 'Picker.swift'), 'utf8')
  for (const [mode, palette] of Object.entries(main.BUILTIN_PALETTES)) {
    for (const [key, hex] of Object.entries(palette)) {
      assert.ok(swift.includes(`${key}: "${hex}"`), `Picker.swift builtin ${mode} should list ${key}: "${hex}"`)
    }
  }
})

/** `loadTheme` against fake settings and an in-memory plugins folder. */
function themeIo(settings: unknown, files: Record<string, string>, reads: string[] = []): ThemeIo {
  return {
    readSettings: async () => {
      if (settings instanceof Error) throw settings
      return settings
    },
    readPluginFile: pluginFiles(files, reads)
  }
}
const BOTH_PACKAGES = { ...themePackage('a.dark', 'dark-t', DARK_TOKENS), ...themePackage('b.light', 'light-t', LIGHT_TOKENS) }
const BOTH_IDS = { pluginAppThemeDark: 'plugin:a.dark/dark-t', pluginAppThemeLight: 'plugin:b.light/light-t' }
const LIGHT_PALETTE = main.paletteFromTokens(LIGHT_TOKENS)

test('mode dark reads only the dark theme; light only the light one; system reads both', async () => {
  for (const [theme, expectDark, expectLight] of [['dark', true, false], ['light', false, true], ['system', true, true]] as const) {
    const reads: string[] = []
    const logs: string[] = []
    const got = await main.loadTheme(themeIo({ theme, ...BOTH_IDS }, BOTH_PACKAGES, reads), (m) => logs.push(m))
    assert.deepEqual(got, {
      schemaVersion: 1,
      mode: theme,
      palettes: {
        dark: expectDark ? DARK_PALETTE : main.BUILTIN_PALETTES.dark,
        light: expectLight ? LIGHT_PALETTE : main.BUILTIN_PALETTES.light
      }
    }, theme)
    assert.equal(reads.some((r) => r.startsWith('a.dark/')), expectDark, `${theme}: dark package read`)
    assert.equal(reads.some((r) => r.startsWith('b.light/')), expectLight, `${theme}: light package read`)
    assert.deepEqual(logs, [], `${theme}: a clean read says nothing`)
  }
  assert.deepEqual(main.themeSlots('dark'), ['dark'])
  assert.deepEqual(main.themeSlots('light'), ['light'])
  assert.deepEqual(main.themeSlots('system'), ['dark', 'light'])
})

test('no plugin theme in the slot means Orca shows its built-in look: the theme is sent, not omitted', async () => {
  const logs: string[] = []
  const reads: string[] = []
  const got = await main.loadTheme(themeIo({ theme: 'dark', pluginAppThemeDark: null, pluginAppThemeLight: null }, {}, reads), (m) => logs.push(m))
  assert.deepEqual(got, { schemaVersion: 1, mode: 'dark', palettes: main.BUILTIN_PALETTES })
  assert.deepEqual(reads, [])
  assert.deepEqual(logs, [])
})

test('a plugin theme that cannot be resolved falls back to the built-in palette with one log line', async () => {
  const logs: string[] = []
  const files = { 'a.dark/current': 'abc123' } // no manifest
  const got = await main.loadTheme(themeIo({ theme: 'dark', pluginAppThemeDark: 'plugin:a.dark/dark-t' }, files), (m) => logs.push(m))
  assert.deepEqual(got?.palettes.dark, main.BUILTIN_PALETTES.dark)
  assert.equal(got?.mode, 'dark')
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('plugin:a.dark/dark-t') && logs[0].includes('built-in dark') && logs[0].includes('manifest'), logs[0])
})

test('unreadable settings omit the theme and log exactly one line', async () => {
  for (const settings of [new Error('sqlite3 did not answer in time'), null, undefined, 'x']) {
    const logs: string[] = []
    assert.equal(await main.loadTheme(themeIo(settings, {}), (m) => logs.push(m)), undefined)
    assert.equal(logs.length, 1, String(settings))
    assert.ok(logs[0].includes('theme not applied'))
  }
})

test('settings that name no theme at all omit it with one log line; a stated theme with no plugin is sent', async () => {
  for (const settings of [{}, { apiKey: 'x' }, { theme: 5 }, { theme: null, pluginAppThemeDark: null, pluginAppThemeLight: 'github-light' }]) {
    const logs: string[] = []
    assert.equal(await main.loadTheme(themeIo(settings, {}), (m) => logs.push(m)), undefined, JSON.stringify(settings))
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('theme not applied') && logs[0].includes('no theme'))
  }
  for (const theme of ['system', 'light', 'solarized']) {
    const logs: string[] = []
    const got = await main.loadTheme(themeIo({ theme }, {}), (m) => logs.push(m))
    assert.deepEqual(got?.palettes, main.BUILTIN_PALETTES, theme)
    assert.deepEqual(logs, [])
  }
  // A plugin id alone is enough to know what Orca shows.
  const only = await main.loadTheme(themeIo({ pluginAppThemeDark: 'plugin:a.dark/dark-t' }, BOTH_PACKAGES), () => {})
  assert.equal(only?.mode, 'system')
  assert.deepEqual(only?.palettes.dark, DARK_PALETTE)
})

test('only the three theme keys can reach the payload: secrets in the settings never do', async () => {
  const settings = {
    theme: 'dark',
    ...BOTH_IDS,
    githubToken: 'ghp_TOPSECRET',
    apiKey: 'sk-TOPSECRET',
    nested: { password: 'TOPSECRET' },
    sshTargets: [{ privateKey: 'TOPSECRET' }]
  }
  const logs: string[] = []
  const got = await main.loadTheme(themeIo(settings, BOTH_PACKAGES), (m) => logs.push(m))
  assert.ok(got)
  const everything = JSON.stringify({ got, logs, ids: main.pickThemeIds(settings) })
  assert.ok(!everything.includes('SECRET'), 'no secret value anywhere in the payload, the ids or the log')
  assert.ok(!/githubToken|apiKey|password|privateKey|sshTargets/.test(everything), 'no secret-named key either')
  assert.deepEqual(Object.keys(got).sort(), ['mode', 'palettes', 'schemaVersion'])
  // And Orca's settings are read inside SQLite, so only those three values ever leave the database.
  const keys = [...main.THEME_SETTINGS_SQL.matchAll(/json_extract\(payload,'\$\.([A-Za-z]+)'\)/g)].map((m) => m[1])
  assert.deepEqual(keys, ['theme', 'pluginAppThemeDark', 'pluginAppThemeLight'])
  assert.ok(!main.THEME_SETTINGS_SQL.replace(/json_extract\(payload,'[^']*'\)/g, '').includes('payload'), 'the whole payload is never selected')
})

test('sqlite3 output: one row, or a plain reason that quotes none of the output', () => {
  assert.deepEqual(main.parseSettingsRows('[{"theme":"dark","pluginAppThemeDark":null}]\n'), { theme: 'dark', pluginAppThemeDark: null })
  for (const bad of ['', '  \n', '[]', 'not json TOPSECRET', '{"theme":"dark"}']) {
    let message = ''
    try {
      main.parseSettingsRows(bad)
    } catch (e) {
      message = (e as Error).message
    }
    assert.ok(message.length > 0, JSON.stringify(bad))
    assert.ok(!message.includes('TOPSECRET'), 'the output is never echoed')
  }
})

const FIXTURE_THEME: PickerTheme = { schemaVersion: 1, mode: 'dark', palettes: { dark: DARK_PALETTE, light: main.BUILTIN_PALETTES.light } }
const themeRig = (readTheme: Deps['readTheme']) => rig({ ...scanQ, deps: { ...scanQ.deps, readTheme } })

test('the request carries the theme when the reader returns one', async () => {
  const { req } = await pickerRequest(themeRig(async () => FIXTURE_THEME))
  assert.deepEqual(req.theme, FIXTURE_THEME)
  assert.deepEqual(req.items.map((i) => i.path), ['/q/a', '/q/b', '/q/c'], 'the items are what they were')
  assert.equal(req.defaultAction, 'terminal')
})

test('the request has no theme key at all when the reader returns nothing', async () => {
  const { req } = await pickerRequest(themeRig(async () => undefined))
  assert.ok(!('theme' in req), 'absent, not undefined')
  assert.deepEqual(Object.keys(req).sort(), ['defaultAction', 'items'])
})

test('the reader is handed the worker log, so its one line lands in the plugin log', async () => {
  const { w } = await pickerRequest(themeRig(async (log) => {
    log('theme not applied, the default look is used: a test reason')
    return undefined
  }))
  assert.ok(w.logs.some((l) => l.includes('a test reason')))
})

test('a reader that throws never fails the picker: it opens with the default look and the error is logged', async () => {
  const { req, w } = await pickerRequest(themeRig(async () => {
    throw new Error('sqlite3 exploded')
  }))
  assert.ok(!('theme' in req))
  assert.equal(req.items.length, 3)
  assert.ok(w.logs.some((l) => l.includes('theme not applied') && l.includes('sqlite3 exploded')))
})

test('a reader that never answers delays the picker by the grace period only, then it opens with the default look', async () => {
  const t0 = Date.now()
  const { req, w } = await pickerRequest(themeRig(() => new Promise<never>(() => {})))
  const waited = Date.now() - t0
  assert.ok(!('theme' in req))
  assert.ok(waited < main.THEME_GRACE_MS + 1000, `waited ${waited} ms`)
  assert.ok(w.logs.some((l) => l.includes('theme not applied') && l.includes(`${main.THEME_GRACE_MS} ms`)))
})
