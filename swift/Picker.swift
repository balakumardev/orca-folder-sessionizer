// orca-folder-picker: native macOS fuzzy folder picker for the Orca "Folder Sessionizer" plugin.
//
// stdin  : one JSON document  { "defaultAction": "terminal", "items": [{ "path": "/abs", "open": true, "recent": 0,
//          "worktrees": [{ "path": "/abs/wt", "branch": "feat/x", "main": false }] }],
//          "theme": { "schemaVersion": 1, "mode": "dark|light|system", "palettes": { "dark": {...}, "light": {...} } } }
//          ("worktrees" and "theme" are optional; a palette has background, popover, foreground, mutedForeground,
//          border, accent, ring as #rrggbb[aa]. Without a theme the picker keeps its default dark HUD look.)
// stdout : { "path": "/abs/path", "action": "terminal|claude|codex|worktree|open" }   (exit 0)
//          plus, after Tab on a Git folder, exactly one of "worktreePath" (an existing worktree) or
//          "newWorktree" (the typed name, possibly empty).
// exit 1 : cancelled (Esc, focus lost, SIGTERM); exit 2: bad input / usage.
//
// Build: the plugin worker compiles this file on first use, for the Mac it runs on:
//   xcrun swiftc -O -swift-version 5 swift/Picker.swift -o orca-folder-picker
// and keeps the result in ~/Library/Caches/orca-folder-sessionizer/<hash of this file>/.
// Check it by hand with: orca-folder-picker --selftest
// Dev only: orca-folder-picker --snapshot out.png [chooser] [--query TEXT] < request.json renders the panel to a PNG
// without showing it.

import AppKit
import Foundation

// MARK: - Actions and key mapping (pure, covered by --selftest)

enum PickAction: String {
    case terminal, claude, codex, worktree, open
}

enum KeyIntent: Equatable {
    case choose(PickAction?)  // nil = the configured default action
    case moveDown, moveUp, pageDown, pageUp
    case cancel
    case worktrees  // Tab: the worktree chooser for the highlighted Git folder
}

/// One place that decides what a key press means. `chars` is `charactersIgnoringModifiers`,
/// so letter chords follow the keyboard layout while special keys use their key codes.
func intent(forKeyCode code: UInt16, chars: String, flags raw: NSEvent.ModifierFlags) -> KeyIntent? {
    let f = raw.intersection([.command, .control, .option, .shift])
    switch code {
    case 36, 76:  // Return, keypad Enter
        if f.isEmpty || f == .control { return .choose(nil) }
        if f == .command { return .choose(.claude) }
        if f == .shift { return .choose(.worktree) }
        if f == .option { return .choose(.open) }
        return nil
    case 53: return f.isEmpty ? .cancel : nil
    case 48: return f.isEmpty ? .worktrees : nil
    case 125: return f.isEmpty ? .moveDown : nil
    case 126: return f.isEmpty ? .moveUp : nil
    case 121: return f.isEmpty ? .pageDown : nil
    case 116: return f.isEmpty ? .pageUp : nil
    default: break
    }
    guard f == .control else { return nil }
    switch chars.lowercased() {
    case "a": return .choose(.claude)
    case "x": return .choose(.codex)
    case "w": return .choose(.worktree)
    case "o": return .choose(.open)
    case "n", "j": return .moveDown
    case "p", "k": return .moveUp
    default: return nil
    }
}

// MARK: - Worktree chooser (pure, covered by --selftest)

/// The same panel shows either the folder list or the worktree chooser of one folder.
enum PickerMode: Equatable {
    case folders, chooser
}

/// What a key means once the mode is known. Only Tab and Esc depend on it; everything else is `.act`.
enum ModeStep: Equatable {
    case enterChooser, leaveChooser, cancel, ignore
    case act(KeyIntent)
}

func modeStep(for it: KeyIntent, mode: PickerMode, highlightedIsGit: Bool) -> ModeStep {
    switch it {
    case .worktrees: return mode == .folders && highlightedIsGit ? .enterChooser : .ignore
    case .cancel: return mode == .chooser ? .leaveChooser : .cancel
    default: return .act(it)
    }
}

struct WorktreeEntry: Equatable {
    let path: String
    let branch: String  // without refs/heads/; empty for a detached HEAD
    let isMain: Bool
}

func branchName(_ ref: String) -> String {
    ref.hasPrefix("refs/heads/") ? String(ref.dropFirst("refs/heads/".count)) : ref
}

/// `worktrees` of one request item. Entries without an absolute path are skipped; absent means none.
func parseWorktrees(_ raw: Any?) -> [WorktreeEntry] {
    guard let list = raw as? [[String: Any]] else { return [] }
    var out: [WorktreeEntry] = []
    for r in list {
        guard let p = r["path"] as? String, p.hasPrefix("/") else { continue }
        out.append(
            WorktreeEntry(
                path: p, branch: branchName((r["branch"] as? String) ?? ""), isMain: (r["main"] as? Bool) ?? false))
    }
    return out
}

/// The chooser's worktrees: the folder itself as the main checkout first (so Tab then Enter does what
/// Enter does in the folder list), then the other listed ones. A folder Orca lists nothing for still
/// gets its main checkout.
func chooserEntries(folderPath: String, listed: [WorktreeEntry]) -> [WorktreeEntry] {
    var out = [WorktreeEntry(path: folderPath, branch: listed.first { $0.isMain }?.branch ?? "", isMain: true)]
    var seen: Set<String> = [folderPath]
    for w in listed where !w.isMain {
        if seen.insert(w.path).inserted { out.append(w) }
    }
    return out
}

enum ChooserRow: Equatable {
    case new  // the pinned "+ New worktree" row
    case worktree(WorktreeEntry)
}

/// What typing has produced so far, as a worktree name: the text without surrounding blanks.
func typedName(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
}

func newWorktreeLabel(_ typed: String) -> String {
    let t = typedName(typed)
    return t.isEmpty ? "+ New worktree" : "+ New worktree \"\(t)\""
}

/// What typing in the chooser matches: the branch, then the folder name, so both are found and the
/// folder name keeps the ranker's whole-name bonus. Only ranked against, never reported.
func worktreeSearchKey(_ w: WorktreeEntry) -> String {
    let dir = (w.path as NSString).lastPathComponent
    return w.branch.isEmpty ? dir : w.branch + "/" + dir
}

/// Row 1, the main checkout, unless the filter left no worktree: then the "+ New" row.
func chooserHighlight(_ rows: [ChooserRow]) -> Int { rows.count > 1 ? 1 : 0 }

/// The JSON the picker prints after the chooser. Exactly one of `worktreePath` / `newWorktree`.
/// The worktree action (Ctrl+W, Shift+Enter) on any row, like any action on the "+ New" row, makes a
/// new worktree named from the typed text, with Claude unless another agent was asked for.
func chooserOutput(folderPath: String, row: ChooserRow, action: PickAction, typed: String) -> [String: String] {
    if case .worktree(let w) = row, action != .worktree {
        return ["path": folderPath, "action": action.rawValue, "worktreePath": w.path]
    }
    let agent: PickAction = action == .worktree ? .claude : action
    return ["path": folderPath, "action": agent.rawValue, "newWorktree": typedName(typed)]
}

/// Footer key hints. `tabAvailable` is whether the highlighted folder is a Git repo.
func hintPairs(mode: PickerMode, defaultAction: PickAction, tabAvailable: Bool) -> [(String, String)] {
    switch mode {
    case .folders:
        var p = [
            ("\u{21A9}", defaultAction.rawValue), ("\u{2318}\u{21A9}", "claude"), ("\u{2303}X", "codex"),
            ("\u{2303}W", "worktree"), ("\u{2325}\u{21A9}", "open"),
        ]
        if tabAvailable { p.append(("\u{21E5}", "worktrees")) }
        p.append(("esc", "cancel"))
        return p
    case .chooser:
        return [
            ("\u{21A9}", defaultAction == .worktree ? "new worktree" : defaultAction.rawValue),
            ("\u{2318}\u{21A9}", "claude"), ("\u{2303}X", "codex"), ("\u{2303}W", "new worktree"),
            ("\u{2325}\u{21A9}", "open"), ("esc", "back"),
        ]
    }
}

// MARK: - Candidates and fuzzy ranking

/// `~` for the home folder, so rows stay short.
func shortenHome(_ path: String, home: String) -> String {
    if path == home { return "~" }
    if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
    return path
}

final class Candidate {
    let path: String
    let name: String
    let display: String
    let lower: [UInt8]
    let bonus: [UInt8]
    let baseStart: Int
    let lowerName: [UInt8]
    let isOpen: Bool
    let recent: Int?
    /// What Orca lists for this repo (this folder as its main checkout, then the others). Often empty.
    var worktrees: [WorktreeEntry] = []
    private var gitCache: Bool?

    init(path: String, isOpen: Bool, recent: Int?, home: String) {
        self.path = path
        self.name = (path as NSString).lastPathComponent
        display = shortenHome(path, home: home)
        let l = Array(path.lowercased().utf8)
        lower = l
        let slash = l.lastIndex(of: 47) ?? -1
        baseStart = slash + 1
        lowerName = Array(l[baseStart...])
        var b = [UInt8](repeating: 0, count: l.count)
        for j in 0..<l.count {
            var v: UInt8 = 0
            if j == 0 {
                v = 8
            } else {
                let p = l[j - 1]
                if p == 47 { v = (j == baseStart) ? 14 : 9 } else if p == 45 || p == 95 || p == 46 || p == 32 { v = 7 }
            }
            if j >= baseStart { v += 3 }
            b[j] = v
        }
        bonus = b
        self.isOpen = isOpen
        self.recent = recent
    }

    /// Looked up lazily: only rows that are drawn pay for the stat call.
    var isGit: Bool {
        if let g = gitCache { return g }
        let g = FileManager.default.fileExists(atPath: path + "/.git")
        gitCache = g
        return g
    }
}

struct Ranked {
    let index: Int
    let score: Int
}

final class Ranker {
    let items: [Candidate]
    private var prev: [Int]
    private var cur: [Int]
    private static let neg = Int.min / 4
    private static let gap = 1

    init(items: [Candidate]) {
        self.items = items
        let cap = (items.map { $0.lower.count }.max() ?? 0) + 1
        prev = [Int](repeating: Ranker.neg, count: cap)
        cur = prev
    }

    /// Best score of `q` as a subsequence of the candidate path, or nil when it is not one.
    func tokenScore(_ q: [UInt8], _ c: Candidate) -> Int? {
        let h = c.lower
        let m = q.count, n = h.count
        if m == 0 { return 0 }
        if m > n { return nil }
        var qi = 0
        for ch in h where ch == q[qi] {
            qi += 1
            if qi == m { break }
        }
        if qi < m { return nil }

        let neg = Ranker.neg, gap = Ranker.gap
        for j in 0..<n { prev[j] = neg }
        for j in 0..<n where h[j] == q[0] { prev[j] = 16 + Int(c.bonus[j]) }
        if m > 1 {
            for i in 1..<m {
                for j in 0..<n { cur[j] = neg }
                var g = neg  // best prev[k] - gap * (j - k - 1) for k <= j - 2
                for j in 0..<n {
                    if h[j] == q[i] {
                        var v = neg
                        if j >= 1, prev[j - 1] > neg { v = prev[j - 1] + 16 + 7 }  // contiguous run
                        if g > neg { v = max(v, g + 16 + Int(c.bonus[j])) }
                        cur[j] = v
                    }
                    var ng = g > neg ? g - gap : neg
                    if j >= 1, prev[j - 1] > neg { ng = max(ng, prev[j - 1] - gap) }
                    g = ng
                }
                swap(&prev, &cur)
            }
        }
        var best = neg
        for j in 0..<n where prev[j] > best { best = prev[j] }
        if best <= neg { return nil }

        // Whole-token bonuses on the folder name beat any scattered match in the path.
        var extra = 0
        let name = c.lowerName
        if name == q {
            extra += 80
        } else if name.starts(with: q) {
            extra += 40
        } else if contains(name, q) {
            extra += 24
        }
        return best + extra
    }

    private func contains(_ hay: [UInt8], _ needle: [UInt8]) -> Bool {
        if needle.isEmpty { return true }
        if needle.count > hay.count { return false }
        for s in 0...(hay.count - needle.count) {
            var ok = true
            for k in 0..<needle.count where hay[s + k] != needle[k] {
                ok = false
                break
            }
            if ok { return true }
        }
        return false
    }

    func rank(_ query: String) -> [Ranked] {
        let tokens = query.lowercased().split(whereSeparator: { $0 == " " || $0 == "\t" }).map { Array($0.utf8) }
        if tokens.isEmpty {
            // Open workspaces first, then recent picks (newest first), then everything else A-Z.
            let order = items.indices.sorted { a, b in
                let x = items[a], y = items[b]
                if x.isOpen != y.isOpen { return x.isOpen }
                switch (x.recent, y.recent) {
                case let (r1?, r2?): if r1 != r2 { return r1 < r2 }
                case (_?, nil): return true
                case (nil, _?): return false
                default: break
                }
                return x.path.localizedCaseInsensitiveCompare(y.path) == .orderedAscending
            }
            return order.map { Ranked(index: $0, score: 0) }
        }
        var out: [Ranked] = []
        for (i, c) in items.enumerated() {
            var total = 0
            var ok = true
            for t in tokens {
                guard let s = tokenScore(t, c) else {
                    ok = false
                    break
                }
                total += s
            }
            if !ok { continue }
            total -= c.lower.count / 10  // prefer shorter paths
            if c.isOpen { total += 30 }
            if let r = c.recent { total += max(0, 20 - r) }
            out.append(Ranked(index: i, score: total))
        }
        out.sort { a, b in
            if a.score != b.score { return a.score > b.score }
            let x = items[a.index], y = items[b.index]
            if x.lower.count != y.lower.count { return x.lower.count < y.lower.count }
            return x.path < y.path
        }
        return out
    }
}

/// The worktree chooser of one Git folder: the same ranker over the worktrees' search keys, with the
/// "+ New worktree" row pinned on top whatever is typed.
final class Chooser {
    let folder: Candidate
    let entries: [WorktreeEntry]
    private let ranker: Ranker

    init(folder: Candidate) {
        self.folder = folder
        entries = chooserEntries(folderPath: folder.path, listed: folder.worktrees)
        ranker = Ranker(
            items: entries.map { Candidate(path: worktreeSearchKey($0), isOpen: false, recent: nil, home: "") })
    }

    /// "+ New", then the worktrees matching `query`: all of them in their fixed order (main checkout
    /// first) while it is empty, best match first otherwise. `Ranker.rank("")` would reorder, so the
    /// empty query is handled here.
    func rows(for query: String) -> [ChooserRow] {
        let blank = query.split(whereSeparator: { $0 == " " || $0 == "\t" }).isEmpty
        let shown = blank ? entries : ranker.rank(query).map { entries[$0.index] }
        return [.new] + shown.map { .worktree($0) }
    }
}

// MARK: - Theme (pure, covered by --selftest)

/// A colour in sRGB, channels 0...1, with straight (not premultiplied) alpha.
struct RGBA: Equatable {
    var r: Double
    var g: Double
    var b: Double
    var a: Double
    init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }
}

/// `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; nil for anything else.
func parseHex(_ text: String) -> RGBA? {
    let t = text.trimmingCharacters(in: .whitespaces).lowercased()
    guard t.hasPrefix("#") else { return nil }
    var digits = Array(t.dropFirst())
    guard [3, 4, 6, 8].contains(digits.count) else { return nil }
    if digits.count <= 4 { digits = digits.flatMap { [$0, $0] } }
    let bytes = stride(from: 0, to: digits.count, by: 2).compactMap { Int(String(digits[$0...$0 + 1]), radix: 16) }
    guard bytes.count == digits.count / 2 else { return nil }
    let v = bytes.map { Double($0) / 255 }
    return RGBA(v[0], v[1], v[2], v.count == 4 ? v[3] : 1)
}

extension RGBA {
    func with(alpha: Double) -> RGBA { RGBA(r, g, b, alpha) }

    /// This colour painted over `base`.
    func over(_ base: RGBA) -> RGBA {
        let out = a + base.a * (1 - a)
        guard out > 0 else { return RGBA(0, 0, 0, 0) }
        func mix(_ x: Double, _ y: Double) -> Double { (x * a + y * base.a * (1 - a)) / out }
        return RGBA(mix(r, base.r), mix(g, base.g), mix(b, base.b), out)
    }
}

/// WCAG relative luminance.
func relativeLuminance(_ c: RGBA) -> Double {
    func linear(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
}

/// WCAG contrast ratio of `fg` painted over `bg`, 1 (identical) to 21. Transparency is composited first.
func contrastRatio(_ fg: RGBA, over bg: RGBA) -> Double {
    let back = bg.over(RGBA(0, 0, 0))
    let l1 = relativeLuminance(fg.over(back)), l2 = relativeLuminance(back)
    return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
}

/// Straight-line distance in sRGB, 0 (identical) to about 1.73.
func colorDistance(_ x: RGBA, _ y: RGBA) -> Double {
    let dr = x.r - y.r, dg = x.g - y.g, db = x.b - y.b
    return (dr * dr + dg * dg + db * db).squareRoot()
}

/// The colours the picker takes from the Orca theme. `ring` is nil when the theme gave none that parses.
struct ThemePalette: Equatable {
    var background: RGBA
    var popover: RGBA
    var foreground: RGBA
    var mutedForeground: RGBA
    var border: RGBA
    var accent: RGBA
    var ring: RGBA?
}

extension ThemePalette {
    init(background: String, popover: String, foreground: String, mutedForeground: String, border: String, accent: String, ring: String) {
        // A typo in a built-in would show as loud magenta, and --selftest checks the values.
        func c(_ s: String) -> RGBA { parseHex(s) ?? RGBA(1, 0, 1) }
        self.init(
            background: c(background), popover: c(popover), foreground: c(foreground), mutedForeground: c(mutedForeground),
            border: c(border), accent: c(accent), ring: c(ring))
    }
}

/// Orca's own palettes, for a theme slot with no plugin theme and for any token that does not parse.
/// The worker's BUILTIN_PALETTES holds the same values; a test there keeps the two in step.
let builtinDark = ThemePalette(
    background: "#0a0a0a", popover: "#171717", foreground: "#fafafa", mutedForeground: "#a1a1a1",
    border: "#ffffff12", accent: "#404040", ring: "#6b7280")
let builtinLight = ThemePalette(
    background: "#ffffff", popover: "#f5f5f5", foreground: "#0a0a0a", mutedForeground: "#696969",
    border: "#e5e5e5", accent: "#e5e5e5", ring: "#a3a3a3")

/// Orca's `theme` setting; `system` follows the OS appearance.
enum ThemeMode: String {
    case dark, light, system
}

enum ThemeScheme: Equatable {
    case dark, light
}

struct ThemeSpec: Equatable {
    var mode: ThemeMode
    var dark: ThemePalette
    var light: ThemePalette
}

/// A palette from its JSON object. A token that is missing or does not parse takes the built-in value
/// for the mode, except `ring`, which stays nil so the selection tint comes from the text colour. No
/// object at all is the whole built-in palette.
func decodePalette(_ raw: Any?, fallback: ThemePalette) -> ThemePalette {
    guard let o = raw as? [String: Any] else { return fallback }
    func token(_ key: String, _ standIn: RGBA) -> RGBA { (o[key] as? String).flatMap(parseHex) ?? standIn }
    return ThemePalette(
        background: token("background", fallback.background), popover: token("popover", fallback.popover),
        foreground: token("foreground", fallback.foreground),
        mutedForeground: token("mutedForeground", fallback.mutedForeground),
        border: token("border", fallback.border), accent: token("accent", fallback.accent),
        ring: (o["ring"] as? String).flatMap(parseHex))
}

/// The request's `theme`: nil (the default look) when it is absent, not an object, or of another schema version.
func parseTheme(_ raw: Any?) -> ThemeSpec? {
    guard let o = raw as? [String: Any] else { return nil }
    if let v = o["schemaVersion"], (v as? Int) != 1 { return nil }
    let mode = (o["mode"] as? String).flatMap(ThemeMode.init(rawValue:)) ?? .system
    let palettes = o["palettes"] as? [String: Any] ?? [:]
    return ThemeSpec(
        mode: mode, dark: decodePalette(palettes["dark"], fallback: builtinDark),
        light: decodePalette(palettes["light"], fallback: builtinLight))
}

/// Whether the OS is in dark mode. No appearance counts as dark, like the default look.
func systemIsDark(_ appearance: NSAppearance?) -> Bool {
    appearance?.bestMatch(from: [.darkAqua, .aqua]) != .aqua
}

func resolveScheme(_ mode: ThemeMode, systemIsDark: Bool) -> ThemeScheme {
    switch mode {
    case .dark: return .dark
    case .light: return .light
    case .system: return systemIsDark ? .dark : .light
    }
}

/// The selected row's fill: the ring colour at 18 % over the popover surface. Orca's own `--accent` fill
/// is often the same colour as the surface, so it would not show. Without a ring: the text colour at 8 %.
func selectionTint(_ p: ThemePalette) -> RGBA {
    if let ring = p.ring { return ring.with(alpha: 0.18 * ring.a).over(p.popover) }
    return p.foreground.with(alpha: 0.08 * p.foreground.a).over(p.popover)
}

let minTextContrast = 4.5
let minMutedContrast = 3.0
let minTintDistance = 0.04

/// Keeps a theme from rendering unreadably. Text that is under 4.5:1 against the surface takes the
/// built-in text and surface (either one may be the culprit); muted text under 3:1 takes the built-in
/// muted colour; a selection tint too close to the surface takes the built-in ring, then none. The rest
/// of the theme is kept. `notes` says what was replaced.
func guardedPalette(_ p: ThemePalette, builtin: ThemePalette) -> (palette: ThemePalette, notes: [String]) {
    var out = p
    var notes: [String] = []
    if contrastRatio(out.foreground, over: out.popover) < minTextContrast {
        out.foreground = builtin.foreground
        out.popover = builtin.popover
        notes.append("text colour and surface")
    }
    if contrastRatio(out.mutedForeground, over: out.popover) < minMutedContrast {
        out.mutedForeground = builtin.mutedForeground
        notes.append("muted text")
    }
    func distinct(_ q: ThemePalette) -> Bool { colorDistance(selectionTint(q), q.popover) >= minTintDistance }
    if !distinct(out) {
        notes.append("selection tint")
        var tried = out
        tried.ring = builtin.ring
        if distinct(tried) {
            out = tried
        } else {
            tried.ring = nil
            if distinct(tried) { out = tried }
        }
    }
    return (out, notes)
}

func nsColor(_ c: RGBA) -> NSColor {
    NSColor(srgbRed: CGFloat(c.r), green: CGFloat(c.g), blue: CGFloat(c.b), alpha: CGFloat(c.a))
}

/// What the panel is drawn with, after the mode is resolved and the contrast guard has run.
struct ThemeLook {
    let scheme: ThemeScheme
    let popover: NSColor
    let border: NSColor
    let foreground: NSColor
    let muted: NSColor
    let tint: NSColor
    /// The highlight behind selected text in the search box.
    let textSelection: NSColor
    /// The `[open]` badge: the ring colour when it reads on the surface, else the text colour.
    let openBadge: NSColor
    let notes: [String]

    init(spec: ThemeSpec, systemIsDark: Bool) {
        let scheme = resolveScheme(spec.mode, systemIsDark: systemIsDark)
        let guarded = guardedPalette(scheme == .dark ? spec.dark : spec.light, builtin: scheme == .dark ? builtinDark : builtinLight)
        let p = guarded.palette
        let accent = p.ring ?? p.foreground
        self.scheme = scheme
        popover = nsColor(p.popover)
        border = nsColor(p.border)
        foreground = nsColor(p.foreground)
        muted = nsColor(p.mutedForeground)
        tint = nsColor(selectionTint(p))
        textSelection = nsColor(accent.with(alpha: 0.35 * accent.a).over(p.popover))
        openBadge = nsColor(p.ring.flatMap { contrastRatio($0, over: p.popover) >= minMutedContrast ? $0 : nil } ?? p.foreground)
        notes = guarded.notes
    }
}

/// Orca's UI font when it is installed, else the system font. Only the themed look asks for it, so the
/// default look does not change with the fonts on the Mac.
enum Geist {
    static let installed = NSFont(name: "Geist", size: 12) != nil
}
func themedFont(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    if Geist.installed {
        let d = NSFontDescriptor(fontAttributes: [
            .family: "Geist", .traits: [NSFontDescriptor.TraitKey.weight: weight.rawValue],
        ])
        if let f = NSFont(descriptor: d, size: size) { return f }
    }
    return .systemFont(ofSize: size, weight: weight)
}

// MARK: - Input

struct PickerInput {
    var defaultAction: PickAction = .terminal
    var items: [Candidate] = []
    /// The selected Orca app theme. Nil keeps the default (dark HUD) look.
    var theme: ThemeSpec?
}

func parseInput(_ data: Data) -> PickerInput? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    var input = PickerInput()
    if let s = obj["defaultAction"] as? String, let a = PickAction(rawValue: s) { input.defaultAction = a }
    input.theme = parseTheme(obj["theme"])
    let home = NSHomeDirectory()
    guard let raw = obj["items"] as? [[String: Any]] else { return input }
    var seen = Set<String>()
    for r in raw {
        guard let p = r["path"] as? String, !p.isEmpty, seen.insert(p).inserted else { continue }
        let c = Candidate(path: p, isOpen: (r["open"] as? Bool) ?? false, recent: r["recent"] as? Int, home: home)
        c.worktrees = parseWorktrees(r["worktrees"])
        input.items.append(c)
    }
    return input
}

// MARK: - Re-activating Orca

let orcaBundleIds = ["com.stablyai.orca", "ai.stably.orca"]

/// `--debug` narrates focus decisions on stderr; stdout stays reserved for the JSON result.
var debugEnabled = false
func dbg(_ message: @autoclosure () -> String) {
    guard debugEnabled else { return }
    FileHandle.standardError.write(Data(("[picker] " + message() + "\n").utf8))
}

func findOrca() -> NSRunningApplication? {
    for id in orcaBundleIds {
        if let a = NSRunningApplication.runningApplications(withBundleIdentifier: id).first { return a }
    }
    return NSWorkspace.shared.runningApplications.first { $0.localizedName == "Orca" }
}

func activateOrca() {
    guard let a = findOrca() else { return }
    if #available(macOS 14.0, *) {
        _ = a.activate(from: NSRunningApplication.current, options: [])
    } else {
        _ = a.activate(options: [.activateIgnoringOtherApps])
    }
}

// MARK: - UI

final class PickerPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class RowView: NSTableRowView {
    /// Set for the themed look; nil draws the default selection.
    var look: ThemeLook?

    override func drawSelection(in dirtyRect: NSRect) {
        guard isSelected else { return }
        let r = bounds.insetBy(dx: 8, dy: 2)
        if let look = look {
            // Orca's selected row: a tinted fill and a 1 px border on rounded corners.
            let path = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
            look.tint.setFill()
            path.fill()
            look.border.setStroke()
            path.lineWidth = 1
            path.stroke()
            return
        }
        NSColor.controlAccentColor.withAlphaComponent(0.9).setFill()
        NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8).fill()
    }
    override var isEmphasized: Bool {
        get { true }
        set {}
    }
}

final class Cell: NSTableCellView {
    let nameLabel = NSTextField(labelWithString: "")
    let pathLabel = NSTextField(labelWithString: "")
    let badgeLabel = NSTextField(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        nameLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        nameLabel.lineBreakMode = .byTruncatingTail
        pathLabel.font = .systemFont(ofSize: 11.5)
        pathLabel.lineBreakMode = .byTruncatingMiddle
        badgeLabel.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        badgeLabel.alignment = .right
        for v in [nameLabel, pathLabel, badgeLabel] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        badgeLabel.setContentHuggingPriority(.required, for: .horizontal)
        badgeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        pathLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        NSLayoutConstraint.activate([
            nameLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: badgeLabel.leadingAnchor, constant: -10),
            nameLabel.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            pathLabel.leadingAnchor.constraint(equalTo: nameLabel.leadingAnchor),
            pathLabel.trailingAnchor.constraint(equalTo: badgeLabel.leadingAnchor, constant: -10),
            pathLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 1),
            badgeLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            badgeLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The four text colours of a row, for the default look or the themed one.
    struct Colors {
        let name: NSColor
        let path: NSColor
        let open: NSColor
        /// `[git]`, `[main]`
        let badge: NSColor

        static func standard(selected: Bool) -> Colors {
            Colors(
                name: selected ? .white : .labelColor,
                path: selected ? NSColor.white.withAlphaComponent(0.78) : .secondaryLabelColor,
                open: selected ? .white : .systemGreen,
                badge: selected ? NSColor.white.withAlphaComponent(0.78) : .tertiaryLabelColor)
        }

        static func themed(_ look: ThemeLook, selected: Bool) -> Colors {
            Colors(
                name: look.foreground, path: look.muted, open: selected ? look.foreground : look.openBadge,
                badge: look.muted)
        }
    }

    private func rowColors(_ look: ThemeLook?, selected: Bool) -> Colors {
        guard let look = look else { return .standard(selected: selected) }
        nameLabel.font = themedFont(size: 15, weight: .semibold)
        pathLabel.font = themedFont(size: 11.5)
        return .themed(look, selected: selected)
    }

    func configure(_ c: Candidate, selected: Bool, look: ThemeLook? = nil) {
        let colors = rowColors(look, selected: selected)
        nameLabel.stringValue = c.name.isEmpty ? c.path : c.name
        pathLabel.stringValue = c.display
        nameLabel.textColor = colors.name
        pathLabel.textColor = colors.path
        let s = NSMutableAttributedString()
        let font = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
        if c.isOpen {
            s.append(NSAttributedString(string: "[open]", attributes: [.font: font, .foregroundColor: colors.open]))
        }
        if c.isGit {
            if s.length > 0 { s.append(NSAttributedString(string: " ", attributes: [.font: font])) }
            s.append(NSAttributedString(string: "[git]", attributes: [.font: font, .foregroundColor: colors.badge]))
        }
        badgeLabel.attributedStringValue = s
    }

    func configure(_ row: ChooserRow, typed: String, home: String, selected: Bool, look: ThemeLook? = nil) {
        let colors = rowColors(look, selected: selected)
        let name: String
        let sub: String
        var badge = ""
        switch row {
        case .new:
            name = newWorktreeLabel(typed)
            sub = typedName(typed).isEmpty ? "named automatically" : "named from what you typed"
        case .worktree(let w):
            name = w.branch.isEmpty ? (w.path as NSString).lastPathComponent : w.branch
            sub = shortenHome(w.path, home: home)
            if w.isMain { badge = "[main]" }
        }
        nameLabel.stringValue = name
        pathLabel.stringValue = sub
        nameLabel.textColor = colors.name
        pathLabel.textColor = colors.path
        badgeLabel.attributedStringValue = NSAttributedString(
            string: badge,
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
                .foregroundColor: colors.badge,
            ])
    }
}

/// The search box's cell. With a theme it gives the editor a caret and a selection highlight in the
/// theme's colours; without one it is a plain NSTextFieldCell.
final class SearchFieldCell: NSTextFieldCell {
    var look: ThemeLook?

    override func setUpFieldEditorAttributes(_ textObj: NSText) -> NSText {
        let editor = super.setUpFieldEditorAttributes(textObj)
        if let look = look, let view = editor as? NSTextView {
            view.insertionPointColor = look.foreground
            view.selectedTextAttributes = [.backgroundColor: look.textSelection, .foregroundColor: look.foreground]
        }
        return editor
    }
}

final class SearchField: NSTextField {
    override class var cellClass: AnyClass? {
        get { SearchFieldCell.self }
        set {}
    }
}

final class AppController: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSTableViewDataSource,
    NSTableViewDelegate
{
    let input: PickerInput
    let ranker: Ranker
    var ranked: [Ranked] = []
    var panel: PickerPanel!
    /// Set when the request carries a theme; nil is the default look, kept exactly as it was.
    var look: ThemeLook?
    let field = SearchField()
    let table = NSTableView()
    let countLabel = NSTextField(labelWithString: "")
    let emptyLabel = NSTextField(labelWithString: "No matching folders")
    var keyMonitor: Any?
    var signalSources: [DispatchSourceSignal] = []
    var hasBecomeKey = false
    var finished = false
    var lastSelected = -1
    let home = NSHomeDirectory()
    let iconView = NSImageView()
    let hintLabel = NSTextField(labelWithString: "")
    var mode: PickerMode = .folders
    /// Set while the worktree chooser is showing; `chooserRows` is then what the table lists.
    var chooser: Chooser?
    var chooserRows: [ChooserRow] = []
    /// What the folder list showed when Tab opened the chooser, so Esc can put it back.
    var savedQuery = ""
    var savedFolder = -1

    init(input: PickerInput) {
        self.input = input
        ranker = Ranker(items: input.items)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildPanel()
        installSignals()
        refilter()
        showPanel()
    }

    /// Dev only (`--snapshot`): builds the panel as launch does, but never shows it, activates nothing and
    /// writes it to `path` as a PNG. `chooser` renders the worktree chooser of the first Git folder.
    func renderSnapshot(to path: String, chooser wantChooser: Bool, query: String?) -> Bool {
        buildPanel()
        if let q = query { field.stringValue = q }
        refilter()
        if wantChooser, let target = ranked.first(where: { input.items[$0.index].isGit }) ?? ranked.first {
            showChooser(for: target.index)
        }
        guard let view = panel.contentView else { return false }
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        do {
            try png.write(to: URL(fileURLWithPath: path))
        } catch {
            FileHandle.standardError.write(Data("cannot write \(path): \(error.localizedDescription)\n".utf8))
            return false
        }
        return true
    }

    // MARK: layout

    private func buildPanel() {
        let size = NSSize(width: 700, height: 440)
        let screen =
            NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        let vis = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let origin = NSPoint(x: vis.midX - size.width / 2, y: vis.midY - size.height / 2)
        panel = PickerPanel(
            contentRect: NSRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        look = input.theme.map { ThemeLook(spec: $0, systemIsDark: systemIsDark(NSApp.effectiveAppearance)) }
        if let look = look { dbg("theme: \(look.scheme), replaced by the contrast guard: \(look.notes.isEmpty ? "nothing" : look.notes.joined(separator: ", "))") }

        let root: NSView
        if let look = look {
            // Orca's overlay: a solid popover-coloured surface, 1 px border, 10 px corners. No vibrancy.
            let surface = NSView(frame: NSRect(origin: .zero, size: size))
            surface.wantsLayer = true
            surface.layer?.backgroundColor = look.popover.cgColor
            surface.layer?.cornerRadius = 10
            surface.layer?.masksToBounds = true
            surface.layer?.borderWidth = 1
            surface.layer?.borderColor = look.border.cgColor
            // The text field, caret, scrollers and system controls follow the theme's light or dark.
            panel.appearance = NSAppearance(named: look.scheme == .dark ? .darkAqua : .aqua)
            root = surface
        } else {
            let effect = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
            effect.material = .hudWindow
            effect.blendingMode = .behindWindow
            effect.state = .active
            effect.wantsLayer = true
            effect.layer?.cornerRadius = 16
            effect.layer?.masksToBounds = true
            effect.layer?.borderWidth = 0.5
            effect.layer?.borderColor = NSColor.separatorColor.cgColor
            root = effect
        }
        panel.contentView = root

        let icon = iconView
        icon.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
        icon.contentTintColor = look?.muted ?? .secondaryLabelColor
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 20, weight: .regular)
        icon.translatesAutoresizingMaskIntoConstraints = false

        field.translatesAutoresizingMaskIntoConstraints = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = uiFont(24, .light)
        (field.cell as? SearchFieldCell)?.look = look
        setPlaceholder("Search project folders")
        field.textColor = look?.foreground ?? .labelColor
        field.delegate = self
        field.cell?.usesSingleLineMode = true
        field.cell?.isScrollable = true

        let topRule = makeRule()
        let bottomRule = makeRule()

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("c"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 46
        table.intercellSpacing = NSSize(width: 0, height: 0)
        table.backgroundColor = .clear
        table.selectionHighlightStyle = .regular
        table.allowsEmptySelection = false
        table.allowsMultipleSelection = false
        table.refusesFirstResponder = true
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(rowDoubleClicked)
        if #available(macOS 11.0, *) { table.style = .plain }

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.scrollerStyle = .overlay

        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        emptyLabel.font = uiFont(14)
        emptyLabel.textColor = look?.muted ?? .tertiaryLabelColor
        emptyLabel.isHidden = true

        let hint = hintLabel
        hint.translatesAutoresizingMaskIntoConstraints = false
        hint.attributedStringValue = hintString()
        hint.lineBreakMode = .byTruncatingTail
        hint.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        countLabel.translatesAutoresizingMaskIntoConstraints = false
        countLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        countLabel.textColor = look?.muted ?? .tertiaryLabelColor
        countLabel.alignment = .right
        countLabel.setContentHuggingPriority(.required, for: .horizontal)

        for v in [icon, field, topRule, scroll, emptyLabel, bottomRule, hint, countLabel] { root.addSubview(v) }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            icon.centerYAnchor.constraint(equalTo: field.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 26),
            field.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            field.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            field.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            field.heightAnchor.constraint(equalToConstant: 34),
            topRule.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            topRule.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            topRule.topAnchor.constraint(equalTo: root.topAnchor, constant: 64),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topRule.bottomAnchor, constant: 4),
            scroll.bottomAnchor.constraint(equalTo: bottomRule.topAnchor, constant: -4),
            emptyLabel.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
            bottomRule.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bottomRule.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bottomRule.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -34),
            hint.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            hint.trailingAnchor.constraint(lessThanOrEqualTo: countLabel.leadingAnchor, constant: -12),
            hint.centerYAnchor.constraint(equalTo: root.bottomAnchor, constant: -17),
            countLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            countLabel.centerYAnchor.constraint(equalTo: hint.centerYAnchor),
        ])
    }

    private func hintString() -> NSAttributedString {
        let key = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)
        let txt = uiFont(11)
        let keyColor = look?.foreground ?? .labelColor
        let textColor = look?.muted ?? .secondaryLabelColor
        let s = NSMutableAttributedString()
        let pairs = hintPairs(mode: mode, defaultAction: input.defaultAction, tabAvailable: highlightedIsGit)
        for (i, p) in pairs.enumerated() {
            if i > 0 { s.append(NSAttributedString(string: "    ", attributes: [.font: txt])) }
            s.append(NSAttributedString(string: p.0, attributes: [.font: key, .foregroundColor: keyColor]))
            s.append(NSAttributedString(string: " " + p.1, attributes: [.font: txt, .foregroundColor: textColor]))
        }
        return s
    }

    /// The UI font: Geist when themed and installed, else the system font (always, without a theme).
    private func uiFont(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        look == nil ? .systemFont(ofSize: size, weight: weight) : themedFont(size: size, weight: weight)
    }

    /// The search box's hint text; muted when themed, since the chooser changes it as well.
    private func setPlaceholder(_ text: String) {
        guard let look = look else {
            field.placeholderString = text
            return
        }
        field.placeholderAttributedString = NSAttributedString(
            string: text, attributes: [.foregroundColor: look.muted, .font: field.font ?? uiFont(24, .light)])
    }

    /// A 1 px divider: the system separator, or the theme's border colour.
    private func makeRule() -> NSView {
        guard let look = look else {
            let box = NSBox()
            box.boxType = .separator
            box.translatesAutoresizingMaskIntoConstraints = false
            return box
        }
        let rule = NSView()
        rule.wantsLayer = true
        rule.layer?.backgroundColor = look.border.cgColor
        rule.translatesAutoresizingMaskIntoConstraints = false
        rule.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return rule
    }

    // MARK: lifecycle

    private func showPanel() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(panelDidBecomeKey), name: NSWindow.didBecomeKeyNotification, object: panel)
        NotificationCenter.default.addObserver(
            self, selector: #selector(panelDidResignKey), name: NSWindow.didResignKeyNotification, object: panel)
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] ev in
            guard let self = self, !self.finished else { return ev }
            if let editor = self.field.currentEditor() as? NSTextView, editor.hasMarkedText() { return ev }
            guard
                let it = intent(
                    forKeyCode: ev.keyCode, chars: ev.charactersIgnoringModifiers ?? "", flags: ev.modifierFlags)
            else { return ev }
            self.handle(it)
            return nil
        }
        panel.orderFrontRegardless()
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        panel.invalidateShadow()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self = self else { return }
            dbg("t+150ms key=\(self.panel.isKeyWindow) appActive=\(NSApp.isActive) front=\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "nil") firstResponderIsField=\(self.panel.firstResponder === self.field.currentEditor())")
        }
        // Cooperative activation can refuse a non-activating panel its key status; ask harder once.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self = self, !self.finished, !self.panel.isKeyWindow else { return }
            dbg("panel not key after 250ms, forcing activation")
            if #available(macOS 14.0, *) {
                NSApp.activate()
            } else {
                NSApp.activate(ignoringOtherApps: true)
            }
            self.panel.makeKeyAndOrderFront(nil)
            self.panel.makeFirstResponder(self.field)
        }
    }

    @objc private func panelDidBecomeKey(_ n: Notification) {
        hasBecomeKey = true
        dbg("became key")
    }

    @objc private func panelDidResignKey(_ n: Notification) {
        // Only a panel that was key once can lose it; this ignores setup churn.
        guard hasBecomeKey, !finished else { return }
        // Do not pull focus back to Orca if the person moved to some other app.
        let front = NSWorkspace.shared.frontmostApplication
        let toOrca = front == nil || front?.processIdentifier == findOrca()?.processIdentifier
        dbg("resigned key; front=\(front?.localizedName ?? "nil") reactivateOrca=\(toOrca)")
        finish(code: 1, output: nil, reactivate: toOrca)
    }

    private func installSignals() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            s.setEventHandler { [weak self] in self?.finish(code: 1, output: nil, reactivate: true) }
            s.resume()
            signalSources.append(s)
        }
        // SIGUSR1 = "you are already open, come to the front" (a second trigger from the worker).
        signal(SIGUSR1, SIG_IGN)
        let u = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        u.setEventHandler { [weak self] in
            guard let self = self, !self.finished else { return }
            self.panel.orderFrontRegardless()
            self.panel.makeKeyAndOrderFront(nil)
            self.panel.makeFirstResponder(self.field)
        }
        u.resume()
        signalSources.append(u)
    }

    private func finish(code: Int32, output: [String: String]?, reactivate: Bool) {
        if finished { return }
        finished = true
        if let m = keyMonitor { NSEvent.removeMonitor(m) }
        if let out = output, let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
        panel.orderOut(nil)
        if reactivate { activateOrca() }
        // Give the activation request a beat to leave the process before it exits.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exit(code) }
    }

    // MARK: behaviour

    private func handle(_ it: KeyIntent) {
        switch modeStep(for: it, mode: mode, highlightedIsGit: highlightedIsGit) {
        case .enterChooser: enterChooser()
        case .leaveChooser: leaveChooser()
        case .cancel: finish(code: 1, output: nil, reactivate: true)
        case .ignore: break
        case .act(let a):
            switch a {
            case .moveDown: moveSelection(by: 1)
            case .moveUp: moveSelection(by: -1)
            case .pageDown: moveSelection(by: 8)
            case .pageUp: moveSelection(by: -8)
            case .choose(let action): choose(action ?? input.defaultAction)
            case .cancel, .worktrees: break  // already turned into a step above
            }
        }
    }

    /// Whether Tab would open the chooser: the highlighted row of the folder list is a Git folder.
    private var highlightedIsGit: Bool {
        guard mode == .folders else { return false }
        let row = table.selectedRow
        guard row >= 0, row < ranked.count else { return false }
        return input.items[ranked[row].index].isGit
    }

    private var rowCount: Int { chooser != nil ? chooserRows.count : ranked.count }

    private func updateHint() { hintLabel.attributedStringValue = hintString() }

    /// Replaces the search text. Programmatic edits do not reach `controlTextDidChange`, so callers refilter.
    private func setQuery(_ text: String) {
        field.stringValue = text
        if field.currentEditor() == nil { panel.makeFirstResponder(field) }
        field.currentEditor()?.selectedRange = NSRange(location: (text as NSString).length, length: 0)
    }

    /// Tab: the same panel lists this folder's worktrees instead of folders. Nothing is opened or closed.
    private func enterChooser() {
        let row = table.selectedRow
        guard row >= 0, row < ranked.count, input.items[ranked[row].index].isGit else { return }
        showChooser(for: ranked[row].index)
    }

    /// The worktree chooser of `input.items[index]`.
    private func showChooser(for index: Int) {
        let folder = input.items[index]
        savedQuery = field.stringValue
        savedFolder = index
        chooser = Chooser(folder: folder)
        mode = .chooser
        setQuery("")
        iconView.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil)
        setPlaceholder("Worktrees of \(folder.name)")
        refilter()
    }

    /// Esc in the chooser: back to the folder list, with the search text and the highlighted folder as they were.
    private func leaveChooser() {
        guard chooser != nil else { return }
        chooser = nil
        chooserRows = []
        mode = .folders
        setQuery(savedQuery)
        iconView.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
        setPlaceholder("Search project folders")
        refilter(selecting: savedFolder)
    }

    private func choose(_ action: PickAction) {
        let row = table.selectedRow
        if let ch = chooser {
            guard row >= 0, row < chooserRows.count else {
                NSSound.beep()
                return
            }
            let out = chooserOutput(
                folderPath: ch.folder.path, row: chooserRows[row], action: action, typed: field.stringValue)
            finish(code: 0, output: out, reactivate: true)
            return
        }
        guard row >= 0, row < ranked.count else {
            NSSound.beep()
            return
        }
        let c = input.items[ranked[row].index]
        finish(code: 0, output: ["path": c.path, "action": action.rawValue], reactivate: true)
    }

    @objc private func rowDoubleClicked() {
        if table.clickedRow >= 0 { choose(input.defaultAction) }
    }

    private func moveSelection(by delta: Int) {
        guard rowCount > 0 else { return }
        let cur = max(0, table.selectedRow)
        let next = min(max(cur + delta, 0), rowCount - 1)
        table.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
        table.scrollRowToVisible(next)
    }

    func controlTextDidChange(_ obj: Notification) { refilter() }

    /// `selecting` is a folder's index in `input.items` to keep highlighted when it is still listed.
    private func refilter(selecting folderIndex: Int? = nil) {
        defer { updateHint() }
        lastSelected = -1
        let highlight: Int
        if let ch = chooser {
            chooserRows = ch.rows(for: field.stringValue)
            emptyLabel.isHidden = true  // the "+ New" row is always there
            countLabel.stringValue = "\(chooserRows.count - 1) / \(ch.entries.count)"
            highlight = chooserHighlight(chooserRows)
        } else {
            ranked = ranker.rank(field.stringValue)
            emptyLabel.isHidden = !ranked.isEmpty
            countLabel.stringValue = "\(ranked.count) / \(input.items.count)"
            highlight = folderIndex.flatMap { i in ranked.firstIndex { $0.index == i } } ?? 0
        }
        table.reloadData()
        if rowCount > 0 {
            table.selectRowIndexes(IndexSet(integer: highlight), byExtendingSelection: false)
            table.scrollRowToVisible(highlight)
        }
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { rowCount }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = RowView()
        view.look = look
        return view
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("cell")
        let cell = (tableView.makeView(withIdentifier: id, owner: nil) as? Cell) ?? Cell(frame: .zero)
        cell.identifier = id
        if chooser != nil {
            cell.configure(
                chooserRows[row], typed: field.stringValue, home: home, selected: row == tableView.selectedRow,
                look: look)
        } else {
            cell.configure(input.items[ranked[row].index], selected: row == tableView.selectedRow, look: look)
        }
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        var rows = IndexSet()
        if lastSelected >= 0, lastSelected < rowCount { rows.insert(lastSelected) }
        let now = table.selectedRow
        if now >= 0 { rows.insert(now) }
        lastSelected = now
        table.reloadData(forRowIndexes: rows, columnIndexes: IndexSet(integer: 0))
        updateHint()
    }
}

// MARK: - Self test and CLI

func selfTest() -> Int32 {
    var failures = 0
    func check(_ ok: Bool, _ what: String) {
        if !ok {
            failures += 1
            print("FAIL: \(what)")
        }
    }
    let home = "/Users/t"
    func items(_ paths: [String]) -> [Candidate] {
        paths.map { Candidate(path: $0, isOpen: false, recent: nil, home: home) }
    }
    let list = items([
        "/Users/t/workspace/frontend-web", "/Users/t/workspace/frontend", "/Users/t/workspace/other/f-r-o-n-t-e-n-d",
        "/Users/t/personal/notes", "/Users/t/personal/nested/frontend-old",
    ])
    let r = Ranker(items: list)
    let top = r.rank("frontend")
    check(top.first.map { list[$0.index].path } == "/Users/t/workspace/frontend", "exact name ranks first")
    check(top.count == 4, "four paths contain the subsequence 'frontend' (got \(top.count))")
    check(r.rank("zzz").isEmpty, "non-subsequence is dropped")
    let fw = r.rank("fw")
    check(fw.count == 1 && list[fw[0].index].path.hasSuffix("frontend-web"), "fw can only be frontend-web (got \(fw.count))")
    check(r.rank("work fron").count == 3, "two tokens must both match (got \(r.rank("work fron").count))")
    let withState = [
        Candidate(path: "/Users/t/a/zeta", isOpen: false, recent: nil, home: home),
        Candidate(path: "/Users/t/a/alpha", isOpen: false, recent: nil, home: home),
        Candidate(path: "/Users/t/a/mid", isOpen: false, recent: 0, home: home),
        Candidate(path: "/Users/t/a/open", isOpen: true, recent: nil, home: home),
    ]
    let empty = Ranker(items: withState).rank("").map { withState[$0.index].name }
    check(empty == ["open", "mid", "alpha", "zeta"], "empty query: open, recent, then A-Z (got \(empty))")
    check(list[0].display == "~/workspace/frontend-web", "home shortened (got \(list[0].display))")

    check(intent(forKeyCode: 36, chars: "\r", flags: []) == .choose(nil), "Return = default")
    check(intent(forKeyCode: 36, chars: "\r", flags: .command) == .choose(.claude), "Cmd+Return = claude")
    check(intent(forKeyCode: 36, chars: "\r", flags: .shift) == .choose(.worktree), "Shift+Return = worktree")
    check(intent(forKeyCode: 36, chars: "\r", flags: .option) == .choose(.open), "Opt+Return = open")
    check(intent(forKeyCode: 76, chars: "\r", flags: []) == .choose(nil), "keypad Enter = default")
    check(intent(forKeyCode: 0, chars: "a", flags: .control) == .choose(.claude), "Ctrl+A = claude")
    check(intent(forKeyCode: 7, chars: "x", flags: .control) == .choose(.codex), "Ctrl+X = codex")
    check(intent(forKeyCode: 13, chars: "w", flags: .control) == .choose(.worktree), "Ctrl+W = worktree")
    check(intent(forKeyCode: 31, chars: "o", flags: .control) == .choose(.open), "Ctrl+O = open")
    check(intent(forKeyCode: 45, chars: "n", flags: .control) == .moveDown, "Ctrl+N down")
    check(intent(forKeyCode: 38, chars: "j", flags: .control) == .moveDown, "Ctrl+J down")
    check(intent(forKeyCode: 35, chars: "p", flags: .control) == .moveUp, "Ctrl+P up")
    check(intent(forKeyCode: 40, chars: "k", flags: .control) == .moveUp, "Ctrl+K up")
    check(intent(forKeyCode: 125, chars: "", flags: []) == .moveDown, "Down arrow")
    check(intent(forKeyCode: 126, chars: "", flags: []) == .moveUp, "Up arrow")
    check(intent(forKeyCode: 53, chars: "", flags: []) == .cancel, "Esc cancels")
    check(intent(forKeyCode: 0, chars: "a", flags: .command) == nil, "Cmd+A stays select-all")
    check(intent(forKeyCode: 0, chars: "a", flags: []) == nil, "plain a is typed")
    check(intent(forKeyCode: 7, chars: "x", flags: [.control, .shift]) == nil, "Ctrl+Shift+X is not a chord")

    selfTestChooser(check)
    selfTestTheme(check)

    print(failures == 0 ? "selftest OK" : "selftest: \(failures) failure(s)")
    return failures == 0 ? 0 : 1
}

/// The worktree chooser, without a window: Tab and Esc, the rows and their order, the pinned "+ New"
/// row, filtering, and the JSON a choice prints.
func selfTestChooser(_ check: (Bool, String) -> Void) {
    check(intent(forKeyCode: 48, chars: "\t", flags: []) == .worktrees, "Tab = worktree chooser")
    check(intent(forKeyCode: 48, chars: "\t", flags: .shift) == nil, "Shift+Tab is left to AppKit")
    check(intent(forKeyCode: 48, chars: "\t", flags: .control) == nil, "Ctrl+Tab is not a chord")

    check(modeStep(for: .worktrees, mode: .folders, highlightedIsGit: true) == .enterChooser, "Tab on a Git row opens the chooser")
    check(modeStep(for: .worktrees, mode: .folders, highlightedIsGit: false) == .ignore, "Tab on a non-Git row does nothing")
    check(modeStep(for: .worktrees, mode: .chooser, highlightedIsGit: true) == .ignore, "Tab inside the chooser does nothing")
    check(modeStep(for: .cancel, mode: .chooser, highlightedIsGit: false) == .leaveChooser, "Esc in the chooser goes back to the list")
    check(modeStep(for: .cancel, mode: .folders, highlightedIsGit: true) == .cancel, "Esc in the folder list cancels")
    check(modeStep(for: .choose(.codex), mode: .chooser, highlightedIsGit: false) == .act(.choose(.codex)), "action keys work the same in the chooser")
    check(modeStep(for: .moveDown, mode: .chooser, highlightedIsGit: false) == .act(.moveDown), "movement works in the chooser")

    check(branchName("refs/heads/feat/x") == "feat/x" && branchName("main") == "main" && branchName("") == "", "branch names lose refs/heads/")

    let app = "/Users/t/workspace/app"
    let json = """
        {"defaultAction":"claude","items":[
          {"path":"\(app)","open":true,"worktrees":[
            {"path":"\(app)","branch":"refs/heads/main","main":true},
            {"path":"/Users/t/orca/app/feat","branch":"refs/heads/feat/login","main":false},
            {"path":"/Users/t/orca/app/scratch","branch":"","main":false},
            {"path":"relative","branch":"skipped"},
            {"branch":"no path"}]},
          {"path":"/Users/t/workspace/plain"}]}
        """
    guard let parsed = parseInput(Data(json.utf8)), parsed.items.count == 2 else {
        check(false, "the request with worktrees parses")
        return
    }
    let appItem = parsed.items[0], plain = parsed.items[1]
    check(appItem.worktrees.count == 3, "entries without an absolute path are skipped (got \(appItem.worktrees.count))")
    check(plain.worktrees.isEmpty, "missing worktrees decode to none")

    // Rows: "+ New" pinned first, then the main checkout, then the other worktrees; highlight on the main checkout.
    let chooser = Chooser(folder: appItem)
    let main = WorktreeEntry(path: app, branch: "main", isMain: true)
    let feat = WorktreeEntry(path: "/Users/t/orca/app/feat", branch: "feat/login", isMain: false)
    let scratch = WorktreeEntry(path: "/Users/t/orca/app/scratch", branch: "", isMain: false)
    let all = chooser.rows(for: "")
    check(all == [.new, .worktree(main), .worktree(feat), .worktree(scratch)], "rows: New, main checkout, other worktrees (got \(all))")
    check(chooserHighlight(all) == 1, "the highlight starts on the main checkout, one row below New")
    check(chooser.rows(for: "  ") == all, "blank text keeps the fixed order")

    // A folder Orca lists nothing for still gets a chooser: its main checkout and "+ New".
    let bare = Chooser(folder: plain).rows(for: "")
    check(bare == [.new, .worktree(WorktreeEntry(path: plain.path, branch: "", isMain: true))], "unknown repo: New and the folder itself")
    check(chooserHighlight(bare) == 1, "unknown repo: highlight on the folder itself")

    // The label of the "+ New" row follows the typed text.
    check(newWorktreeLabel("") == "+ New worktree", "empty box: plain label")
    check(newWorktreeLabel("   ") == "+ New worktree", "blanks only: plain label")
    check(newWorktreeLabel("  fix login ") == "+ New worktree \"fix login\"", "typed text in the label, trimmed")

    // Typing filters the worktrees on branch and folder name, and "+ New" never goes away.
    check(chooser.rows(for: "login") == [.new, .worktree(feat)], "matches on the branch (got \(chooser.rows(for: "login")))")
    check(chooser.rows(for: "scratch") == [.new, .worktree(scratch)], "matches on the folder name when the branch is empty")
    check(chooser.rows(for: "zzz") == [.new], "no match: only the pinned New row")
    check(chooserHighlight(chooser.rows(for: "zzz")) == 0, "no match: highlight on New")
    check(chooser.rows(for: "FEAT").first == .new, "New stays first while filtering")

    // The JSON a choice prints: exactly one of worktreePath / newWorktree.
    func exactlyOne(_ o: [String: String]) -> Bool { (o["worktreePath"] != nil) != (o["newWorktree"] != nil) }
    let onFeat = chooserOutput(folderPath: app, row: .worktree(feat), action: .codex, typed: "ignored")
    check(onFeat == ["path": app, "action": "codex", "worktreePath": feat.path], "existing worktree: path, action, worktreePath (got \(onFeat))")
    let onMain = chooserOutput(folderPath: app, row: .worktree(main), action: .terminal, typed: "")
    check(onMain["worktreePath"] == app && exactlyOne(onMain), "the main checkout is a worktreePath too")
    let onNew = chooserOutput(folderPath: app, row: .new, action: .claude, typed: "  fix login ")
    check(onNew == ["path": app, "action": "claude", "newWorktree": "fix login"], "New row: typed name, trimmed (got \(onNew))")
    let autoNamed = chooserOutput(folderPath: app, row: .new, action: .open, typed: "")
    check(autoNamed["newWorktree"] == "" && autoNamed["action"] == "open" && exactlyOne(autoNamed), "New row, empty box: empty name asks for an automatic one")
    let defaultWorktree = chooserOutput(folderPath: app, row: .new, action: .worktree, typed: "")
    check(defaultWorktree["action"] == "claude" && defaultWorktree["newWorktree"] == "", "the worktree action means Claude in a new worktree")
    let ctrlW = chooserOutput(folderPath: app, row: .worktree(feat), action: .worktree, typed: "idea")
    check(ctrlW == ["path": app, "action": "claude", "newWorktree": "idea"], "Ctrl+W on a worktree row makes a new worktree from the typed text")
    for o in [onFeat, onMain, onNew, autoNamed, defaultWorktree, ctrlW] {
        check(exactlyOne(o) && o["path"] == app, "exactly one of worktreePath / newWorktree, and always path (got \(o))")
    }
    if let data = try? JSONSerialization.data(withJSONObject: autoNamed, options: [.sortedKeys]) {
        let text = String(decoding: data, as: UTF8.self)
        check(text.contains("\"newWorktree\":\"\"") && !text.contains("worktreePath"), "an empty name still prints the key (got \(text))")
    }

    // Footer hints.
    let folderHints = hintPairs(mode: .folders, defaultAction: .terminal, tabAvailable: false)
    check(!folderHints.contains { $0.1 == "worktrees" }, "no Tab hint on a non-Git row")
    check(hintPairs(mode: .folders, defaultAction: .terminal, tabAvailable: true).contains { $0.0 == "\u{21E5}" && $0.1 == "worktrees" }, "Tab hint on a Git row")
    check(folderHints.last?.1 == "cancel", "folder list: esc cancels")
    let chooserHints = hintPairs(mode: .chooser, defaultAction: .terminal, tabAvailable: true)
    check(chooserHints.last?.0 == "esc" && chooserHints.last?.1 == "back" && !chooserHints.contains { $0.1 == "worktrees" }, "chooser: esc goes back")
}

/// The theme: colour parsing, per-token fallback, mode resolution, the selection tint and the contrast guard.
/// Pure: no window and no running NSApplication.
func selfTestTheme(_ check: (Bool, String) -> Void) {
    func rgb8(_ r: Int, _ g: Int, _ b: Int, _ a: Int = 255) -> RGBA {
        RGBA(Double(r) / 255, Double(g) / 255, Double(b) / 255, Double(a) / 255)
    }
    func rgbD(_ r: Double, _ g: Double, _ b: Double) -> RGBA { RGBA(r / 255, g / 255, b / 255) }
    func near(_ x: RGBA, _ y: RGBA) -> Bool {
        abs(x.r - y.r) < 0.002 && abs(x.g - y.g) < 0.002 && abs(x.b - y.b) < 0.002 && abs(x.a - y.a) < 0.002
    }

    // Hex: 3, 4, 6 and 8 digits; anything else is nil.
    check(parseHex("#fff") == rgb8(255, 255, 255), "#rgb")
    check(parseHex("#FfF") == rgb8(255, 255, 255), "hex is case-insensitive")
    check(parseHex("#abcd") == rgb8(0xaa, 0xbb, 0xcc, 0xdd), "#rgba")
    check(parseHex("#0d1117") == rgb8(0x0d, 0x11, 0x17), "#rrggbb")
    check(parseHex("#ffffff12") == rgb8(255, 255, 255, 0x12), "#rrggbbaa keeps its alpha")
    check(parseHex(" #0d1117 ") == rgb8(0x0d, 0x11, 0x17), "surrounding blanks are ignored")
    for bad in ["", "fff", "#", "#12", "#12345", "#1234567", "#gggggg", "red", "rgb(1,2,3)", "#ff ff", "\u{FF03}fff", "#\u{FF46}\u{FF46}\u{FF46}"] {
        check(parseHex(bad) == nil, "not a colour: \(bad)")
    }

    // The built-in palettes parse and read on their own surface.
    check(builtinDark.popover == rgb8(0x17, 0x17, 0x17) && builtinDark.border == rgb8(255, 255, 255, 0x12), "built-in dark values")
    check(builtinLight.popover == rgb8(0xf5, 0xf5, 0xf5) && builtinLight.foreground == rgb8(0x0a, 0x0a, 0x0a), "built-in light values")
    for (name, p) in [("dark", builtinDark), ("light", builtinLight)] {
        let all = [p.background, p.popover, p.foreground, p.mutedForeground, p.border, p.accent, p.ring ?? RGBA(1, 0, 1)]
        check(!all.contains(RGBA(1, 0, 1)) && p.ring != nil, "built-in \(name) has no mistyped value")
        check(guardedPalette(p, builtin: p).notes.isEmpty, "built-in \(name) passes its own contrast guard")
    }

    // The request's theme: tolerant decoding with a per-token fallback.
    let fixture = """
        {"schemaVersion":1,"mode":"dark","palettes":{"dark":{"background":"#0d1117","popover":"#161b22","foreground":"#e6edf3",
        "mutedForeground":"#7d8590","border":"#30363d","accent":"#171b22","ring":"#1f6feb"}}}
        """
    guard let json = try? JSONSerialization.jsonObject(with: Data(fixture.utf8)), let spec = parseTheme(json) else {
        check(false, "the theme fixture decodes")
        return
    }
    check(spec.mode == .dark && spec.dark.popover == rgb8(0x16, 0x1b, 0x22) && spec.dark.ring == rgb8(0x1f, 0x6f, 0xeb), "the theme decodes")
    check(spec.light == builtinLight, "a palette that was not sent is the built-in one, ring included")
    let partial = parseTheme(
        ["mode": "light", "palettes": ["light": ["popover": "#fffaf0", "foreground": "oklch(0.2 0 0)", "ring": "nope"]]] as [String: Any])
    check(partial?.mode == .light && partial?.light.popover == rgb8(0xff, 0xfa, 0xf0), "a good token is kept")
    check(partial?.light.foreground == builtinLight.foreground, "an unparseable token takes the built-in value")
    check(partial?.light.border == builtinLight.border, "a missing token takes the built-in value")
    check(partial?.light.ring == nil, "no usable ring stays nil, so the tint comes from the text colour")
    check(partial?.dark == builtinDark, "the other palette is the built-in one")
    check(parseTheme(nil) == nil && parseTheme("text") == nil && parseTheme([1, 2]) == nil, "not an object: no theme")
    check(parseTheme(["schemaVersion": 2, "mode": "dark"] as [String: Any]) == nil, "another schema version: no theme")
    check(parseTheme([String: Any]())?.mode == .system, "an empty theme is system mode with built-in palettes")
    check(parseTheme(["mode": "sepia"] as [String: Any])?.mode == .system, "an unknown mode is system")

    // The light or dark palette: dark and light as given, system through the OS appearance.
    check(resolveScheme(.dark, systemIsDark: false) == .dark && resolveScheme(.light, systemIsDark: true) == .light, "dark and light are not second-guessed")
    check(resolveScheme(.system, systemIsDark: true) == .dark && resolveScheme(.system, systemIsDark: false) == .light, "system follows the OS")
    if let dark = NSAppearance(named: .darkAqua), let light = NSAppearance(named: .aqua) {
        check(systemIsDark(dark) && !systemIsDark(light), "system resolves through a given appearance")
    }
    check(systemIsDark(nil), "no appearance counts as dark")
    let systemSpec = ThemeSpec(mode: .system, dark: spec.dark, light: builtinLight)
    check(ThemeLook(spec: systemSpec, systemIsDark: false).scheme == .light, "a system theme on a light OS is the light look")
    check(ThemeLook(spec: systemSpec, systemIsDark: true).scheme == .dark, "a system theme on a dark OS is the dark look")
    check(ThemeLook(spec: spec, systemIsDark: true).notes.isEmpty, "the current-theme fixture passes the guard untouched")

    // The selection tint is visible on the popover even where Orca's accent is not.
    check(near(selectionTint(spec.dark), rgbD(22 + 0.18 * 9, 27 + 0.18 * 84, 34 + 0.18 * 201)), "tint = 18% ring over the popover")
    check(colorDistance(selectionTint(spec.dark), spec.dark.popover) >= minTintDistance, "the tint differs from the popover")
    check(colorDistance(spec.dark.accent, spec.dark.popover) < minTintDistance, "this theme's accent equals its surface, which is why the tint exists")
    var noRing = spec.dark
    noRing.ring = nil
    check(near(selectionTint(noRing), rgbD(22 + 0.08 * 208, 27 + 0.08 * 210, 34 + 0.08 * 209)), "no ring: the text colour at 8%")

    // Contrast.
    let white = RGBA(1, 1, 1), black = RGBA(0, 0, 0)
    check(abs(contrastRatio(white, over: black) - 21) < 0.01, "white on black is 21:1")
    check(abs(contrastRatio(white, over: white) - 1) < 0.001, "white on white is 1:1")
    check(contrastRatio(RGBA(1, 1, 1, 0.5), over: black) < contrastRatio(white, over: black), "transparency is composited first")
    check(contrastRatio(spec.dark.foreground, over: spec.dark.popover) >= minTextContrast, "the fixture's text reads on its surface")

    // The contrast guard replaces only what is unreadable.
    let sane = guardedPalette(spec.dark, builtin: builtinDark)
    check(sane.palette == spec.dark && sane.notes.isEmpty, "a readable theme is left alone")
    var whiteOnWhite = spec.dark
    whiteOnWhite.foreground = white
    whiteOnWhite.popover = white
    let fixed = guardedPalette(whiteOnWhite, builtin: builtinDark)
    check(contrastRatio(fixed.palette.foreground, over: fixed.palette.popover) >= minTextContrast, "white on white is made readable")
    check(!fixed.notes.isEmpty && fixed.palette.border == whiteOnWhite.border, "only the text and surface were replaced")
    var faint = spec.dark
    faint.mutedForeground = spec.dark.popover
    let muted = guardedPalette(faint, builtin: builtinDark)
    check(contrastRatio(muted.palette.mutedForeground, over: muted.palette.popover) >= minMutedContrast, "invisible muted text is replaced")
    check(muted.palette.foreground == spec.dark.foreground && muted.palette.popover == spec.dark.popover, "and nothing else with it")
    var flat = spec.dark
    flat.ring = spec.dark.popover
    let tinted = guardedPalette(flat, builtin: builtinDark)
    check(colorDistance(selectionTint(tinted.palette), tinted.palette.popover) >= minTintDistance, "a tint equal to the surface is replaced")

    // No theme in the request is the default look, and a broken theme is no error.
    let items = #""items":[{"path":"/a"}]"#
    check(parseInput(Data("{\(items)}".utf8))?.theme == nil, "no theme: the default look")
    check(parseInput(Data("{\(items),\"theme\":\"dark\"}".utf8))?.theme == nil, "a malformed theme: the default look")
    check(parseInput(Data("{\(items),\"theme\":\"dark\"}".utf8))?.items.count == 1, "and the items still load")
    let themed = parseInput(Data("{\(items),\"theme\":\(fixture)}".utf8))
    check(themed?.theme == spec && themed?.items.count == 1, "a theme in the request is decoded next to the items")
    check(themedFont(size: 12).pointSize == 12, "the themed font is always something")
}

let usage = """
    orca-folder-picker - native fuzzy folder picker for the Orca Folder Sessionizer plugin

    usage: orca-folder-picker [--debug] < request.json
           orca-folder-picker --dry-run [--query TEXT] [--limit N] < request.json
           orca-folder-picker --snapshot out.png [chooser] [--query TEXT] < request.json
           orca-folder-picker --selftest | --help

    stdin   {"defaultAction":"terminal","items":[{"path":"/abs","open":true,"recent":0,
              "worktrees":[{"path":"/abs/wt","branch":"feat/x","main":false}]}],
              "theme":{"schemaVersion":1,"mode":"dark","palettes":{"dark":{"popover":"#161b22",...}}}}
            ("worktrees" and "theme" optional; no theme keeps the default dark HUD look)
    stdout  {"action":"terminal|claude|codex|worktree|open","path":"/abs"}   (exit 0)
            after Tab on a Git folder it also has exactly one of
            "worktreePath":"/abs/wt" (an existing worktree) or "newWorktree":"name" (may be "")
    exit 1  cancelled (Esc, focus lost, SIGTERM)    exit 2  bad input or usage

    keys    Enter default action     Cmd+Enter / Ctrl+A claude    Ctrl+X codex
            Ctrl+W / Shift+Enter worktree    Opt+Enter / Ctrl+O open
            Up Down Ctrl+N Ctrl+P Ctrl+J Ctrl+K move    Esc cancel
            Tab on a Git folder: its worktrees (the pinned "+ New worktree" row makes a new one,
            named from what you typed); Esc goes back

    --dry-run prints the ranked rows to stdout and opens no window.
    --snapshot builds the panel, writes it to a PNG (the worktree chooser of the first Git folder with
    "chooser") and exits 0 without showing a window or taking focus. Dev only.

    """

let argv = Array(CommandLine.arguments.dropFirst())
debugEnabled = argv.contains("--debug")
if argv.contains("--help") || argv.contains("-h") {
    print(usage, terminator: "")
    exit(0)
}
if argv.contains("--selftest") { exit(selfTest()) }
if isatty(0) != 0 {
    FileHandle.standardError.write(Data(("reads JSON on stdin; see --help\n").utf8))
    exit(2)
}
guard let parsed = parseInput(FileHandle.standardInput.readDataToEndOfFile()) else {
    FileHandle.standardError.write(Data("invalid JSON on stdin\n".utf8))
    exit(2)
}

func flagValue(_ flag: String) -> String? {
    guard let i = argv.firstIndex(of: flag), i + 1 < argv.count else { return nil }
    return argv[i + 1]
}

if argv.contains("--dry-run") {
    let value = flagValue
    let ranker = Ranker(items: parsed.items)
    let rows = ranker.rank(value("--query") ?? "")
    let limit = Int(value("--limit") ?? "") ?? 10
    print("matched \(rows.count) of \(parsed.items.count), default action \(parsed.defaultAction.rawValue)")
    for r in rows.prefix(limit) {
        let c = parsed.items[r.index]
        print("\(r.score)\t\(c.isOpen ? "[open]" : "      ")\(c.isGit ? "[git]" : "     ")\t\(c.path)")
    }
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = AppController(input: parsed)
if argv.contains("--snapshot") {
    guard let out = flagValue("--snapshot") else {
        FileHandle.standardError.write(Data("--snapshot needs an output path; see --help\n".utf8))
        exit(2)
    }
    exit(controller.renderSnapshot(to: out, chooser: argv.contains("chooser"), query: flagValue("--query")) ? 0 : 1)
}
app.delegate = controller
app.run()
