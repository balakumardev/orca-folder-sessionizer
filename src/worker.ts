// Folder Sessionizer: Orca plugin worker.
//
// Ctrl+Shift+F (or the "Projects" status bar item) scans the configured roots, shows the native
// picker and opens the chosen folder in Orca as a terminal tab, a Claude/Codex agent, a plain
// workspace switch, or a new Git worktree. Tab on a Git folder switches the picker to that repo's
// worktrees, where the same actions apply to an existing worktree or to a new one.
//
// The picker is compiled from swift/Picker.swift on first use and cached under
// ~/Library/Caches/orca-folder-sessionizer, so the repository ships no executable.
//
// Everything that touches the OS goes through `deps`, so tests inject fakes and `activate` itself
// never scans or spawns anything.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, promises as fsp } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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

/** Longest a `sqlite3` read of Orca's settings may take. */
export const THEME_READ_TIMEOUT_MS = 1500
/** How long the picker waits for the theme once the folder scan is done: the default look beats a late window. */
export const THEME_GRACE_MS = 150

export interface Config {
  roots: string[]
  maxDepth: number
  defaultEnterAction: Action
}

/** One worktree of a repo as Orca lists it, for the picker's worktree chooser. */
export interface PickerWorktree {
  path: string
  /** Without `refs/heads/`; empty for a detached HEAD. */
  branch: string
  main: boolean
}
export interface PickerItem {
  path: string
  open: boolean
  recent?: number
  /** Only on a repo's main checkout, and only when Orca knows worktrees for it. */
  worktrees?: PickerWorktree[]
}
export interface PickerRequest {
  defaultAction: Action
  items: PickerItem[]
  /** The selected Orca app theme; absent when it could not be read, and the picker keeps its default look. */
  theme?: PickerTheme
}
export interface PickerPick {
  path: string
  action: Action
  /** An existing worktree chosen in the worktree chooser: an absolute path. */
  worktreePath?: string
  /** A new worktree: the typed name, empty for an automatic one. Never set together with `worktreePath`. */
  newWorktree?: string
}
export interface PickerHandle {
  focus(): void
  kill(): void
}

/** The colours the picker takes from the Orca theme, as `#rrggbb` or `#rrggbbaa`. A token it cannot parse is left out. */
export const THEME_KEYS = ['background', 'popover', 'foreground', 'mutedForeground', 'border', 'accent', 'ring'] as const
export type ThemeKey = (typeof THEME_KEYS)[number]
export type ThemePalette = Partial<Record<ThemeKey, string>>
/** Orca's `theme` setting. `system` is resolved by the picker, from the OS appearance. */
export type ThemeMode = 'dark' | 'light' | 'system'
export interface PickerTheme {
  schemaVersion: 1
  mode: ThemeMode
  palettes: { dark: ThemePalette; light: ThemePalette }
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
  /** The selected Orca app theme for the picker, or undefined (after a log line) when it cannot be determined. Never rejects. */
  readTheme(log: (m: string) => void): Promise<PickerTheme | undefined>
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

/** A typed worktree name as a folder and branch name: lowercase, runs of other characters become one `-`. May be empty. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function mergeMru(mru: readonly string[], path: string, limit = MRU_LIMIT): string[] {
  return [path, ...mru.filter((p) => p !== path)].slice(0, limit)
}

/**
 * The optional worktree fields of a pick: `{}` for a plain folder pick, null when a field is
 * malformed or both are set. Keys are only present when given, so a plain pick stays `{path, action}`.
 */
export function worktreeFields(v: Record<string, unknown>): Pick<PickerPick, 'worktreePath' | 'newWorktree'> | null {
  const { worktreePath, newWorktree } = v
  if (worktreePath !== undefined && newWorktree !== undefined) return null
  if (worktreePath !== undefined) {
    return typeof worktreePath === 'string' && worktreePath.startsWith('/') ? { worktreePath } : null
  }
  if (newWorktree !== undefined) return typeof newWorktree === 'string' ? { newWorktree } : null
  return {}
}

export function parsePick(stdout: string): PickerPick | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    const v = obj(JSON.parse(text))
    const extra = v ? worktreeFields(v) : null
    if (v && extra && typeof v.path === 'string' && v.path.startsWith('/') && isAction(v.action)) {
      return { path: v.path, action: v.action, ...extra }
    }
  } catch {
    // fall through
  }
  return null
}

export function buildItems(
  paths: readonly string[],
  openPaths: ReadonlySet<string>,
  mru: readonly string[],
  worktrees: ReadonlyMap<string, PickerWorktree[]> = new Map()
): PickerItem[] {
  const rank = new Map<string, number>()
  mru.forEach((p, i) => {
    if (!rank.has(p)) rank.set(p, i)
  })
  return paths.map((path) => {
    const item: PickerItem = { path, open: openPaths.has(path) }
    const r = rank.get(path)
    if (r !== undefined) item.recent = r
    const w = worktrees.get(path)
    if (w && w.length > 0) item.worktrees = w
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

/** A worktree row of `orca worktree ps --json`, reduced to what the chooser and the lookups need. */
export interface PsWorktree {
  repoId: string
  path: string
  branch: string
  main: boolean
}

/** `refs/heads/feat/x` as `feat/x`. */
export function stripRefsHeads(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

/** The live worktrees of Git repos on this machine: no archived rows, folder workspaces or other hosts. */
export function psWorktrees(rows: readonly unknown[]): PsWorktree[] {
  const out: PsWorktree[] = []
  for (const row of rows) {
    const r = obj(row)
    if (!r || r.isArchived === true) continue
    const kind = str(r.workspaceKind)
    if (kind && kind !== 'git') continue
    // Paths on an SSH or paired host could collide with a local folder's.
    const host = str(r.hostId)
    if (host && host !== 'local') continue
    const repoId = str(r.repoId)
    const path = str(r.path)
    if (!repoId || !path || !path.startsWith('/')) continue
    out.push({ repoId, path, branch: stripRefsHeads(str(r.branch) ?? ''), main: r.isMainWorktree === true })
  }
  return out
}

/**
 * Worktrees per repo, keyed by the repo's main checkout (what the picker lists as a folder): the main
 * checkout first, then the others. Orca can list one path twice (a second workspace on the main
 * checkout), so a path appears once, the main checkout's own row winning. A repo whose main checkout
 * Orca does not list has no key.
 */
export function groupWorktrees(list: readonly PsWorktree[]): Map<string, PickerWorktree[]> {
  const byRepo = new Map<string, PsWorktree[]>()
  for (const w of list) byRepo.set(w.repoId, [...(byRepo.get(w.repoId) ?? []), w])
  const out = new Map<string, PickerWorktree[]>()
  for (const rows of byRepo.values()) {
    const main = rows.find((w) => w.main)
    if (!main) continue
    const group: PickerWorktree[] = [{ path: main.path, branch: main.branch, main: true }]
    const seen = new Set([main.path])
    for (const w of rows) {
      if (seen.has(w.path)) continue
      seen.add(w.path)
      group.push({ path: w.path, branch: w.branch, main: false })
    }
    out.set(main.path, group)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Picker theme: the selected Orca app theme, reduced to the few colours the picker draws with.
// Orca has no plugin API for it, so the worker reads Orca's own settings and theme files.

/** Orca's own palettes, used when no plugin theme is selected. The picker holds the same values (`builtinDark`, `builtinLight`). */
export const BUILTIN_PALETTES: { dark: Required<ThemePalette>; light: Required<ThemePalette> } = {
  dark: { background: '#0a0a0a', popover: '#171717', foreground: '#fafafa', mutedForeground: '#a1a1a1', border: '#ffffff12', accent: '#404040', ring: '#6b7280' },
  light: { background: '#ffffff', popover: '#f5f5f5', foreground: '#0a0a0a', mutedForeground: '#696969', border: '#e5e5e5', accent: '#e5e5e5', ring: '#a3a3a3' }
}

/** channels 0..255, alpha 0..1 */
interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
function num(s: string): number | undefined {
  return NUMBER.test(s) ? Number(s) : undefined
}
/** `12` or `50%`, as 0..255. */
function rgbChannel(s: string): number | undefined {
  const pct = s.endsWith('%')
  const n = num(pct ? s.slice(0, -1) : s)
  return n === undefined ? undefined : pct ? clamp(n, 0, 100) * 2.55 : clamp(n, 0, 255)
}
/** `0.5` or `50%`, as 0..1. */
function alphaValue(s: string): number | undefined {
  const pct = s.endsWith('%')
  const n = num(pct ? s.slice(0, -1) : s)
  return n === undefined ? undefined : clamp(pct ? n / 100 : n, 0, 1)
}
/** A hue in degrees, plain or with a deg, grad, rad or turn unit. */
function hueDegrees(s: string): number | undefined {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/.exec(s)
  if (!m) return undefined
  const n = Number(m[1])
  return m[2] === 'grad' ? n * 0.9 : m[2] === 'rad' ? (n * 180) / Math.PI : m[2] === 'turn' ? n * 360 : n
}
/** h in degrees, s and l in 0..1; channels 0..255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + hue / 30) % 12
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255
  }
  return [f(0), f(8), f(4)]
}

/** Hex (3, 4, 6 or 8 digits), `rgb()`/`rgba()` and `hsl()`/`hsla()`. Anything else (oklch, names, `var()`) is undefined. */
function toRgba(token: string): Rgba | undefined {
  const t = token.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t)
  if (hex) {
    const h = hex[1].length <= 4 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    const byte = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) / 255 : 1 }
  }
  const fn = /^(rgba?|hsla?)\(\s*([^()]*?)\s*\)$/.exec(t)
  if (!fn) return undefined
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return undefined
  const a = parts.length === 4 ? alphaValue(parts[3]) : 1
  if (a === undefined) return undefined
  if (fn[1].startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map(rgbChannel)
    return r !== undefined && g !== undefined && b !== undefined ? { r, g, b, a } : undefined
  }
  const h = hueDegrees(parts[0])
  const s = num(parts[1].replace(/%$/, ''))
  const l = num(parts[2].replace(/%$/, ''))
  if (h === undefined || s === undefined || l === undefined) return undefined
  const [r, g, b] = hslToRgb(h, clamp(s, 0, 100) / 100, clamp(l, 0, 100) / 100)
  return { r, g, b, a }
}

function toHex(c: Rgba): string {
  const byte = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')
  const alpha = Math.round(clamp(c.a, 0, 1) * 255)
  return '#' + byte(c.r) + byte(c.g) + byte(c.b) + (alpha === 255 ? '' : byte(alpha))
}

/** A CSS colour as `#rrggbb` (or `#rrggbbaa` when not opaque), or undefined when it is not one of the formats above. */
export function parseColor(token: string): string | undefined {
  const c = toRgba(token)
  return c ? toHex(c) : undefined
}

/** `color-mix(in srgb, fg pct%, bg)`: how Orca derives a border, muted text or accent the theme leaves out. */
function mix(fg: Rgba, pct: number, bg: Rgba): Rgba {
  const p = pct / 100
  const m = (x: number, y: number) => x * p + y * (1 - p)
  return { r: m(fg.r, bg.r), g: m(fg.g, bg.g), b: m(fg.b, bg.b), a: m(fg.a, bg.a) }
}

/** A theme's `tokens`: CSS variable name to colour string. */
export type ThemeTokens = Readonly<Record<string, string>>

/**
 * The picker's colours from a theme's tokens, with the ones the theme omits derived the way Orca does
 * (`completePluginAppThemeTokens`): popover from card from background, muted text, border and accent
 * as foreground mixed into background, ring from primary from foreground. The mixes are computed
 * here, because Orca's `color-mix()` strings are not a format the picker parses. A token that is
 * present but unparseable (oklch) is left out, and so is anything derived from a missing colour.
 */
export function paletteFromTokens(tokens: ThemeTokens): ThemePalette {
  const has = (k: string) => Boolean(tokens[k])
  const color = (k: string) => (has(k) ? toRgba(tokens[k]) : undefined)
  const bg = color('--background')
  const fg = color('--foreground')
  const card = has('--card') ? color('--card') : bg
  const primary = has('--primary') ? color('--primary') : fg
  const derived = (k: string, pct: number) => (has(k) ? color(k) : bg && fg ? mix(fg, pct, bg) : undefined)
  const out: ThemePalette = {}
  const put = (key: ThemeKey, c: Rgba | undefined) => {
    if (c) out[key] = toHex(c)
  }
  put('background', bg)
  put('popover', has('--popover') ? color('--popover') : card)
  put('foreground', fg)
  put('mutedForeground', derived('--muted-foreground', 70))
  put('border', derived('--border', 16))
  put('accent', derived('--accent', 12))
  put('ring', has('--ring') ? color('--ring') : primary)
  return out
}

export interface ThemeIds {
  mode: ThemeMode
  dark: string | null
  light: string | null
}

/**
 * The only three settings the picker looks at. Anything else in the object, secrets included, is
 * ignored here and never copied. A missing or unknown `theme` is Orca's default, `system`.
 */
export function pickThemeIds(settings: unknown): ThemeIds {
  const s = obj(settings)
  const theme = s?.theme
  const id = (v: unknown) => (typeof v === 'string' && v.startsWith('plugin:') ? v : null)
  return {
    mode: theme === 'dark' || theme === 'light' ? theme : 'system',
    dark: id(s?.pluginAppThemeDark),
    light: id(s?.pluginAppThemeLight)
  }
}

/** One path segment of a folder or file name taken from Orca's files: no `.`, `..`, separators or odd characters. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** `themes/x.json` as segments; null for an absolute path, `..` or anything that is not a plain relative path. */
export function relativeSegments(p: string): string[] | null {
  const parts = p.replace(/^\.\//, '').split('/')
  return p.length <= 200 && parts.every((s) => SAFE_SEGMENT.test(s)) ? parts : null
}

async function readJson(readFile: (rel: string) => Promise<string>, rel: string, what: string): Promise<Record<string, unknown> | null> {
  try {
    return obj(JSON.parse(await readFile(rel)))
  } catch {
    throw new Error(`${what} unreadable`)
  }
}

/**
 * The tokens of `plugin:<publisher.name>/<themeId>`: `<publisher.name>/current` names the installed
 * version folder, its manifest lists the theme and its file, and that file holds the tokens. `readFile`
 * takes paths relative to Orca's plugins folder. Throws a plain reason when any step fails.
 */
export async function resolveThemeTokens(themeId: string, readFile: (rel: string) => Promise<string>): Promise<ThemeTokens> {
  const m = /^plugin:([^/]+)\/(.+)$/.exec(themeId)
  if (!m || !SAFE_SEGMENT.test(m[1])) throw new Error('not a plugin theme id')
  const [, pkg, id] = m
  let hash = ''
  try {
    hash = (await readFile(`${pkg}/current`)).trim()
  } catch {
    // reported below
  }
  if (!SAFE_SEGMENT.test(hash)) throw new Error('the plugin is not installed')
  const dir = `${pkg}/${hash}`
  const manifest = await readJson(readFile, `${dir}/orca-plugin.json`, 'plugin manifest')
  const themes = obj(manifest?.contributes)?.themes
  const entry = Array.isArray(themes) ? themes.map(obj).find((t) => t?.id === id) : undefined
  if (!entry) throw new Error('the plugin does not offer that theme')
  const segments = relativeSegments(str(entry.path) ?? '')
  if (!segments) throw new Error('the theme path is not a plain relative path')
  const file = await readJson(readFile, `${dir}/${segments.join('/')}`, 'theme file')
  const tokens: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj(file?.tokens) ?? {})) if (typeof v === 'string') tokens[k] = v
  if (!tokens['--background'] || !tokens['--foreground']) throw new Error('the theme has no --background or --foreground')
  return tokens
}

/** Both palettes: a slot with theme tokens gets them completed, any other slot gets Orca's built-in one. */
export function buildThemePayload(mode: ThemeMode, dark: ThemeTokens | undefined, light: ThemeTokens | undefined): PickerTheme {
  return {
    schemaVersion: 1,
    mode,
    palettes: {
      dark: dark ? paletteFromTokens(dark) : { ...BUILTIN_PALETTES.dark },
      light: light ? paletteFromTokens(light) : { ...BUILTIN_PALETTES.light }
    }
  }
}

/** The slots the picker may show for a mode. `system` follows the OS appearance, which only the picker knows. */
export function themeSlots(mode: ThemeMode): ('dark' | 'light')[] {
  return mode === 'system' ? ['dark', 'light'] : [mode]
}

/** Where `loadTheme` reads from, so tests never touch Orca's real files. */
export interface ThemeIo {
  /** Orca's settings, of which only the three theme keys need to be present. Throws a plain reason when unreadable. */
  readSettings(): Promise<unknown>
  /** A file under Orca's plugins folder, by path relative to it. */
  readPluginFile(rel: string): Promise<string>
}

/**
 * The picker theme for the settings `io` returns, or undefined with ONE log line when the settings
 * cannot be read or name no theme at all. A theme slot that cannot be resolved (no plugin selected, plugin missing) is not a
 * failure: Orca shows its built-in palette there, so the picker gets that one.
 */
export async function loadTheme(io: ThemeIo, log: (m: string) => void): Promise<PickerTheme | undefined> {
  let settings: unknown
  try {
    settings = await io.readSettings()
  } catch (e) {
    log(`theme not applied, the default look is used: ${errMsg(e)}`)
    return undefined
  }
  if (!obj(settings)) {
    log('theme not applied, the default look is used: Orca has no settings yet')
    return undefined
  }
  const ids = pickThemeIds(settings)
  // A row that names no theme and no plugin theme says nothing about what Orca shows.
  if (typeof obj(settings)?.theme !== 'string' && !ids.dark && !ids.light) {
    log('theme not applied, the default look is used: the settings name no theme')
    return undefined
  }
  const tokens: { dark?: ThemeTokens; light?: ThemeTokens } = {}
  for (const slot of themeSlots(ids.mode)) {
    const id = ids[slot]
    if (!id) continue
    try {
      tokens[slot] = await resolveThemeTokens(id, io.readPluginFile)
    } catch (e) {
      log(`theme ${id} not applied, the built-in ${slot} palette is used: ${errMsg(e)}`)
    }
  }
  return buildThemePayload(ids.mode, tokens.dark, tokens.light)
}

/**
 * Reads exactly the three theme keys inside SQLite, so nothing else in Orca's settings (which hold
 * secrets) ever leaves the database. An empty result means there is no settings row.
 */
export const THEME_SETTINGS_SQL =
  "select json_extract(payload,'$.theme') as theme, json_extract(payload,'$.pluginAppThemeDark') as pluginAppThemeDark, json_extract(payload,'$.pluginAppThemeLight') as pluginAppThemeLight from profile_state_documents where domain='settings'"

/** `sqlite3 -json` output: one row, or none. */
export function parseSettingsRows(stdout: string): unknown {
  const text = stdout.trim()
  if (!text) throw new Error('Orca has no settings row')
  try {
    const rows: unknown = JSON.parse(text)
    if (Array.isArray(rows) && rows.length > 0) return rows[0]
  } catch {
    // fall through
  }
  throw new Error('sqlite3 gave unreadable output')
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

  const orcaDir = join(home, 'Library', 'Application Support', 'orca')
  const SQLITE3 = '/usr/bin/sqlite3'

  /**
   * The three theme settings from the active profile's database, opened read-only while Orca runs.
   * Only if that fails fast is the database copied (with its -wal and -shm, always together) into a
   * private temp folder and read from there; the copy is removed afterwards. A timeout is not retried.
   * Throws plain reasons only, never `sqlite3`'s own output.
   */
  async function readThemeSettings(): Promise<unknown> {
    let profile = ''
    try {
      const index = obj(JSON.parse(await fsp.readFile(join(orcaDir, 'orca-profile-index.json'), 'utf8')))
      profile = str(index?.activeProfileId) ?? ''
    } catch {
      // reported below
    }
    if (!SAFE_SEGMENT.test(profile)) throw new Error('Orca has no active profile')
    const db = join(orcaDir, 'profiles', profile, 'profile-state.db')
    if (!(await exists(db))) throw new Error('the profile database does not exist')
    const t0 = Date.now()
    const live = await run(SQLITE3, ['-readonly', '-json', db, THEME_SETTINGS_SQL], { timeout: THEME_READ_TIMEOUT_MS })
    if (live.code === 0) return parseSettingsRows(live.stdout)
    if (Date.now() - t0 >= THEME_READ_TIMEOUT_MS / 2) throw new Error('sqlite3 did not answer in time')

    const dir = await fsp.mkdtemp(join(tmpdir(), 'orca-folder-picker-'))
    try {
      const copy = join(dir, 'profile-state.db')
      await fsp.copyFile(db, copy)
      for (const ext of ['-wal', '-shm']) {
        try {
          await fsp.copyFile(db + ext, copy + ext)
        } catch {
          // a database that is not in WAL mode has neither
        }
      }
      const read = await run(SQLITE3, ['-readonly', '-json', copy, THEME_SETTINGS_SQL], {
        timeout: Math.max(300, THEME_READ_TIMEOUT_MS - (Date.now() - t0))
      })
      if (read.code !== 0) throw new Error('sqlite3 could not read the settings')
      return parseSettingsRows(read.stdout)
    } finally {
      await fsp.rm(dir, { force: true, recursive: true })
    }
  }

  /** A file under Orca's plugins folder. Symlinks that lead out of it are not followed. */
  async function readPluginFile(rel: string): Promise<string> {
    const root = await fsp.realpath(join(orcaDir, 'plugins'))
    const file = await fsp.realpath(join(root, rel))
    if (!file.startsWith(root + '/')) throw new Error('outside the plugins folder')
    return fsp.readFile(file, 'utf8')
  }

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

    async readTheme(log) {
      try {
        return await loadTheme({ readSettings: readThemeSettings, readPluginFile }, log)
      } catch (e) {
        log(`theme not applied, the default look is used: ${errMsg(e)}`)
        return undefined
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

  /** Never rejects: whatever goes wrong, the picker just keeps its default look. */
  async function readTheme(): Promise<PickerTheme | undefined> {
    try {
      return await deps.readTheme(log)
    } catch (e) {
      log(`theme not applied, the default look is used: ${errMsg(e)}`)
      return undefined
    }
  }

  async function buildRequest(cfg: Config): Promise<{ request: PickerRequest; total: number }> {
    // Started with the scan, so it costs nothing unless it is the slowest.
    const themeRead = readTheme()
    const [paths, open, mru, worktrees] = await Promise.all([
      scanFolders(cfg.roots, cfg.maxDepth, deps, log),
      listWorkspaces(),
      readMru(),
      worktreeGroups()
    ])
    const theme = await new Promise<PickerTheme | undefined>((res) => {
      const timer = setTimeout(() => {
        log(`theme not applied, the default look is used: the settings read took over ${THEME_GRACE_MS} ms after the scan`)
        res(undefined)
      }, THEME_GRACE_MS)
      void themeRead.then((t) => {
        clearTimeout(timer)
        res(t)
      })
    })
    const items = buildItems(paths, new Set(open.keys()), mru, worktrees)
    const request: PickerRequest = { defaultAction: cfg.defaultEnterAction, items }
    if (theme) request.theme = theme
    return { request, total: items.length }
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

  /** One `orca worktree ps` call: every row Orca has, or null (and a log line) when it cannot be read. */
  async function fetchPs(): Promise<{ rows: unknown[]; truncated: boolean } | null> {
    try {
      const reply = await deps.cli(['worktree', 'ps', '--limit', '1000', '--json'])
      const result = obj(reply.result)
      const rows = result?.worktrees
      if (!Array.isArray(rows)) {
        log('worktree ps returned no worktree list')
        return null
      }
      return { rows, truncated: result?.truncated === true }
    } catch (e) {
      log(`worktree ps failed: ${errMsg(e)}`)
      return null
    }
  }

  /**
   * What `orca worktree ps` knows about a folder: its repo id and the exact selector Orca prints for
   * it. Workspace ids from `workspace.list` are opaque, so neither is parsed out of them.
   */
  async function psRow(path: string): Promise<PsRow | null> {
    const ps = await fetchPs()
    for (const row of ps?.rows ?? []) {
      const r = obj(row)
      if (!r || str(r.path) !== path) continue
      const worktreeId = str(r.worktreeId)
      return {
        repoId: str(r.repoId),
        selector: str(obj(r.address)?.worktree) ?? (worktreeId ? `id:${worktreeId}` : null)
      }
    }
    return null
  }

  /**
   * The live worktrees from `ps`, with `path` canonicalized the way picker items are for matching.
   * `orcaPath` keeps the path as Orca prints it: its ids are `<repoId>::<that path>`.
   */
  async function canonicalWorktrees(rows: readonly unknown[]): Promise<(PsWorktree & { orcaPath: string })[]> {
    return Promise.all(psWorktrees(rows).map(async (w) => ({ ...w, path: await canonical(w.path), orcaPath: w.path })))
  }

  /** What the picker's worktree chooser lists, per repo main checkout. Empty when `ps` cannot be trusted. */
  async function worktreeGroups(): Promise<Map<string, PickerWorktree[]>> {
    const ps = await fetchPs()
    if (!ps) return new Map()
    if (ps.truncated) {
      log('worktree ps is truncated: the worktree chooser lists nothing')
      return new Map()
    }
    return groupWorktrees(await canonicalWorktrees(ps.rows))
  }

  async function isGitRoot(path: string): Promise<boolean> {
    const top = await deps.git(['-C', path, 'rev-parse', '--show-toplevel'])
    return top !== null && top !== '' && (await canonical(top)) === path
  }

  /** Creates a worktree and returns the id Orca printed for it (`<repoId>::<path>`), or null if it printed none. */
  async function createWorktree(repoId: string, name: string, agent?: 'claude' | 'codex'): Promise<string | null> {
    const reply = await cliOk([
      'worktree', 'create', '--repo', `id:${repoId}`, '--name', name, '--no-parent', '--activate',
      ...(agent ? ['--agent', agent] : []),
      '--json'
    ])
    log(`created worktree ${name} in repo ${repoId}`)
    return str(obj(obj(reply.result)?.worktree)?.id)
  }

  async function waitForWorkspace(path: string): Promise<Known | null> {
    for (let i = 0; i < 6; i++) {
      const found = (await listWorkspaces()).get(path)
      if (found) return found
      await deps.sleep(250)
    }
    return null
  }

  /** The action itself, once the target is known. `worktree` is handled before this. */
  async function runAction(
    action: Exclude<Action, 'worktree'>,
    target: Target,
    kind: 'git' | 'folder',
    label: string,
    selected: string
  ): Promise<void> {
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

  /**
   * A worktree picked in the chooser: one of the repo's Orca worktrees, found in `ps`. The selector is
   * built from the repo id `ps` prints, never from a workspace id, which is opaque.
   */
  async function openWorktree(selected: string, path: string, action: Exclude<Action, 'worktree'>): Promise<void> {
    const ps = await fetchPs()
    const rows = await canonicalWorktrees(ps?.rows ?? [])
    const row = rows.find((w) => w.path === path)
    if (!row) throw new Error(`worktree ps does not list the worktree ${path}`)
    const main = rows.find((w) => w.path === selected)
    if (main && main.repoId !== row.repoId) throw new Error(`${path} is a worktree of another repo than ${selected}`)
    const repoId = row.repoId
    const target: Target = {
      selector: `id:${repoId}::${row.orcaPath}`,
      workspaceId: async () => (await waitForWorkspace(path))?.id ?? `${repoId}::${row.orcaPath}`
    }
    await runAction(action, target, 'git', labelFor(path), path)
  }

  /** A new worktree named from what the person typed, then what the action asks for in it. */
  async function createNamedWorktree(repoId: string, typed: string, action: Action, label: string): Promise<void> {
    const name = slugify(typed) || worktreeName(label, deps.now())
    // The worktree action means "new worktree with Claude", as it does for a folder.
    const agent = action === 'codex' ? 'codex' : action === 'claude' || action === 'worktree' ? 'claude' : undefined
    const id = await createWorktree(repoId, name, agent)
    if (action !== 'terminal') return
    if (!id) throw new Error('worktree create printed no worktree id, so no terminal was opened in it')
    await createFocused({ selector: `id:${id}`, workspaceId: async () => id }, [
      'terminal', 'create', '--worktree', `id:${id}`, '--title', name, '--focus', '--json'
    ])
  }

  async function performSelection(pick: PickerPick): Promise<void> {
    // A relative path would resolve against this worker's cwd, not anything the person chose.
    if (!pick.path.startsWith('/')) throw new Error(`not an absolute path: ${pick.path}`)
    if (pick.worktreePath !== undefined && pick.newWorktree !== undefined) {
      throw new Error('a pick names an existing worktree or a new one, not both')
    }
    if (pick.worktreePath !== undefined && !pick.worktreePath.startsWith('/')) {
      throw new Error(`not an absolute path: ${pick.worktreePath}`)
    }
    const selected = await canonical(pick.path)
    if (!(await deps.isDir(selected))) throw new Error(`not a folder: ${selected}`)
    await recordMru(selected)
    const label = labelFor(selected)
    let action = pick.action

    if (pick.worktreePath !== undefined) {
      // The worktree action creates one, so it cannot also name one that exists.
      if (pick.action === 'worktree') throw new Error('the worktree action creates a new worktree: it cannot be combined with worktreePath')
      const chosen = await canonical(pick.worktreePath)
      // The main checkout is the folder itself: handled below, exactly as for a plain pick.
      if (chosen !== selected) {
        await openWorktree(selected, chosen, pick.action)
        return
      }
    }
    const newWorktree = pick.newWorktree

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
      // A new worktree, or the worktree action, creates one: the main checkout need not be shown for that.
      if (action !== 'worktree' && newWorktree === undefined) {
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

    if (action === 'worktree' || newWorktree !== undefined) {
      if (kind === 'git' && repoId) {
        if (newWorktree === undefined) await createWorktree(repoId, worktreeName(label, deps.now()), 'claude')
        else await createNamedWorktree(repoId, newWorktree, action, label)
        return
      }
      // No notifications:show capability is granted, so say it in the log and carry on.
      log(`${selected} is not a Git repository root: opening it as a folder terminal instead of a worktree`)
      action = 'terminal'
    }

    await runAction(action, target, kind, label, selected)
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
  // Optional, one of: "worktreePath": "/abs/worktree" (an existing one) or "newWorktree": "name".
  orca.panels.handle('act', async (input) => {
    const v = obj(input)
    const path = str(v?.path)
    const action = v?.action
    if (!path || !isAction(action)) throw new Error('act needs {"path": "/abs/dir", "action": terminal|claude|codex|worktree|open}')
    const extra = worktreeFields(v ?? {})
    if (!extra) throw new Error('act: worktreePath must be an absolute path, newWorktree a string, and not both')
    await c.performSelection({ path, action, ...extra })
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
