import { afterEach, assert, hostError, mockHost, mountWorker, test as baseTest, type TestWorker } from 'orca/testing'
import * as main from './worker'
import type { CliReply, Deps, PickerHandle, PickerPick, PickerRequest } from './worker'

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
  assert.deepEqual(r.cli, [])
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
