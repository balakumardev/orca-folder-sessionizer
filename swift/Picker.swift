// orca-folder-picker: native macOS fuzzy folder picker for the Orca "Folder Sessionizer" plugin.
//
// stdin  : one JSON document  { "defaultAction": "terminal", "items": [{ "path": "/abs", "open": true, "recent": 0 }] }
// stdout : { "path": "/abs/path", "action": "terminal|claude|codex|worktree|open" }   (exit 0)
// exit 1 : cancelled (Esc, focus lost, SIGTERM); exit 2: bad input / usage.
//
// Build: the plugin worker compiles this file on first use, for the Mac it runs on:
//   xcrun swiftc -O -swift-version 5 swift/Picker.swift -o orca-folder-picker
// and keeps the result in ~/Library/Caches/orca-folder-sessionizer/<hash of this file>/.
// Check it by hand with: orca-folder-picker --selftest

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

// MARK: - Candidates and fuzzy ranking

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
    private var gitCache: Bool?

    init(path: String, isOpen: Bool, recent: Int?, home: String) {
        self.path = path
        self.name = (path as NSString).lastPathComponent
        if path == home {
            display = "~"
        } else if path.hasPrefix(home + "/") {
            display = "~" + path.dropFirst(home.count)
        } else {
            display = path
        }
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

// MARK: - Input

struct PickerInput {
    var defaultAction: PickAction = .terminal
    var items: [Candidate] = []
}

func parseInput(_ data: Data) -> PickerInput? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    var input = PickerInput()
    if let s = obj["defaultAction"] as? String, let a = PickAction(rawValue: s) { input.defaultAction = a }
    let home = NSHomeDirectory()
    guard let raw = obj["items"] as? [[String: Any]] else { return input }
    var seen = Set<String>()
    for r in raw {
        guard let p = r["path"] as? String, !p.isEmpty, seen.insert(p).inserted else { continue }
        input.items.append(
            Candidate(path: p, isOpen: (r["open"] as? Bool) ?? false, recent: r["recent"] as? Int, home: home))
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
    override func drawSelection(in dirtyRect: NSRect) {
        guard isSelected else { return }
        let r = bounds.insetBy(dx: 8, dy: 2)
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

    func configure(_ c: Candidate, selected: Bool) {
        nameLabel.stringValue = c.name.isEmpty ? c.path : c.name
        pathLabel.stringValue = c.display
        nameLabel.textColor = selected ? .white : .labelColor
        pathLabel.textColor = selected ? NSColor.white.withAlphaComponent(0.78) : .secondaryLabelColor
        let s = NSMutableAttributedString()
        let font = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
        if c.isOpen {
            s.append(
                NSAttributedString(
                    string: "[open]",
                    attributes: [.font: font, .foregroundColor: selected ? NSColor.white : NSColor.systemGreen]))
        }
        if c.isGit {
            if s.length > 0 { s.append(NSAttributedString(string: " ", attributes: [.font: font])) }
            s.append(
                NSAttributedString(
                    string: "[git]",
                    attributes: [
                        .font: font,
                        .foregroundColor: selected
                            ? NSColor.white.withAlphaComponent(0.78) : NSColor.tertiaryLabelColor,
                    ]))
        }
        badgeLabel.attributedStringValue = s
    }
}

final class AppController: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSTableViewDataSource,
    NSTableViewDelegate
{
    let input: PickerInput
    let ranker: Ranker
    var ranked: [Ranked] = []
    var panel: PickerPanel!
    let field = NSTextField()
    let table = NSTableView()
    let countLabel = NSTextField(labelWithString: "")
    let emptyLabel = NSTextField(labelWithString: "No matching folders")
    var keyMonitor: Any?
    var signalSources: [DispatchSourceSignal] = []
    var hasBecomeKey = false
    var finished = false
    var lastSelected = -1

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

        let effect = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 16
        effect.layer?.masksToBounds = true
        effect.layer?.borderWidth = 0.5
        effect.layer?.borderColor = NSColor.separatorColor.cgColor
        panel.contentView = effect

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
        icon.contentTintColor = .secondaryLabelColor
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 20, weight: .regular)
        icon.translatesAutoresizingMaskIntoConstraints = false

        field.translatesAutoresizingMaskIntoConstraints = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 24, weight: .light)
        field.placeholderString = "Search project folders"
        field.textColor = .labelColor
        field.delegate = self
        field.cell?.usesSingleLineMode = true
        field.cell?.isScrollable = true

        let topRule = NSBox()
        topRule.boxType = .separator
        topRule.translatesAutoresizingMaskIntoConstraints = false
        let bottomRule = NSBox()
        bottomRule.boxType = .separator
        bottomRule.translatesAutoresizingMaskIntoConstraints = false

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
        emptyLabel.font = .systemFont(ofSize: 14)
        emptyLabel.textColor = .tertiaryLabelColor
        emptyLabel.isHidden = true

        let hint = NSTextField(labelWithString: "")
        hint.translatesAutoresizingMaskIntoConstraints = false
        hint.attributedStringValue = hintString()
        hint.lineBreakMode = .byTruncatingTail
        hint.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        countLabel.translatesAutoresizingMaskIntoConstraints = false
        countLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        countLabel.textColor = .tertiaryLabelColor
        countLabel.alignment = .right
        countLabel.setContentHuggingPriority(.required, for: .horizontal)

        for v in [icon, field, topRule, scroll, emptyLabel, bottomRule, hint, countLabel] { effect.addSubview(v) }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: effect.leadingAnchor, constant: 20),
            icon.centerYAnchor.constraint(equalTo: field.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 26),
            field.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            field.trailingAnchor.constraint(equalTo: effect.trailingAnchor, constant: -20),
            field.topAnchor.constraint(equalTo: effect.topAnchor, constant: 18),
            field.heightAnchor.constraint(equalToConstant: 34),
            topRule.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            topRule.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            topRule.topAnchor.constraint(equalTo: effect.topAnchor, constant: 64),
            scroll.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topRule.bottomAnchor, constant: 4),
            scroll.bottomAnchor.constraint(equalTo: bottomRule.topAnchor, constant: -4),
            emptyLabel.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
            bottomRule.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            bottomRule.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            bottomRule.bottomAnchor.constraint(equalTo: effect.bottomAnchor, constant: -34),
            hint.leadingAnchor.constraint(equalTo: effect.leadingAnchor, constant: 18),
            hint.trailingAnchor.constraint(lessThanOrEqualTo: countLabel.leadingAnchor, constant: -12),
            hint.centerYAnchor.constraint(equalTo: effect.bottomAnchor, constant: -17),
            countLabel.trailingAnchor.constraint(equalTo: effect.trailingAnchor, constant: -18),
            countLabel.centerYAnchor.constraint(equalTo: hint.centerYAnchor),
        ])
    }

    private func hintString() -> NSAttributedString {
        let key = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)
        let txt = NSFont.systemFont(ofSize: 11)
        let s = NSMutableAttributedString()
        let pairs: [(String, String)] = [
            ("\u{21A9}", input.defaultAction.rawValue), ("\u{2318}\u{21A9}", "claude"),
            ("\u{2303}X", "codex"), ("\u{2303}W", "worktree"), ("\u{2325}\u{21A9}", "open"), ("esc", "cancel"),
        ]
        for (i, p) in pairs.enumerated() {
            if i > 0 { s.append(NSAttributedString(string: "    ", attributes: [.font: txt])) }
            s.append(
                NSAttributedString(string: p.0, attributes: [.font: key, .foregroundColor: NSColor.labelColor]))
            s.append(
                NSAttributedString(
                    string: " " + p.1, attributes: [.font: txt, .foregroundColor: NSColor.secondaryLabelColor]))
        }
        return s
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
        switch it {
        case .cancel: finish(code: 1, output: nil, reactivate: true)
        case .moveDown: moveSelection(by: 1)
        case .moveUp: moveSelection(by: -1)
        case .pageDown: moveSelection(by: 8)
        case .pageUp: moveSelection(by: -8)
        case .choose(let a): choose(a ?? input.defaultAction)
        }
    }

    private func choose(_ action: PickAction) {
        let row = table.selectedRow
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
        guard !ranked.isEmpty else { return }
        let cur = max(0, table.selectedRow)
        let next = min(max(cur + delta, 0), ranked.count - 1)
        table.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
        table.scrollRowToVisible(next)
    }

    func controlTextDidChange(_ obj: Notification) { refilter() }

    private func refilter() {
        ranked = ranker.rank(field.stringValue)
        lastSelected = -1
        table.reloadData()
        emptyLabel.isHidden = !ranked.isEmpty
        countLabel.stringValue = "\(ranked.count) / \(input.items.count)"
        if !ranked.isEmpty {
            table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
            table.scrollRowToVisible(0)
        }
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { ranked.count }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? { RowView() }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("cell")
        let cell = (tableView.makeView(withIdentifier: id, owner: nil) as? Cell) ?? Cell(frame: .zero)
        cell.identifier = id
        cell.configure(input.items[ranked[row].index], selected: row == tableView.selectedRow)
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        var rows = IndexSet()
        if lastSelected >= 0, lastSelected < ranked.count { rows.insert(lastSelected) }
        let now = table.selectedRow
        if now >= 0 { rows.insert(now) }
        lastSelected = now
        table.reloadData(forRowIndexes: rows, columnIndexes: IndexSet(integer: 0))
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

    print(failures == 0 ? "selftest OK" : "selftest: \(failures) failure(s)")
    return failures == 0 ? 0 : 1
}

let usage = """
    orca-folder-picker - native fuzzy folder picker for the Orca Folder Sessionizer plugin

    usage: orca-folder-picker [--debug] < request.json
           orca-folder-picker --dry-run [--query TEXT] [--limit N] < request.json
           orca-folder-picker --selftest | --help

    stdin   {"defaultAction":"terminal","items":[{"path":"/abs","open":true,"recent":0}]}
    stdout  {"action":"terminal|claude|codex|worktree|open","path":"/abs"}   (exit 0)
    exit 1  cancelled (Esc, focus lost, SIGTERM)    exit 2  bad input or usage

    keys    Enter default action     Cmd+Enter / Ctrl+A claude    Ctrl+X codex
            Ctrl+W / Shift+Enter worktree    Opt+Enter / Ctrl+O open
            Up Down Ctrl+N Ctrl+P Ctrl+J Ctrl+K move    Esc cancel

    --dry-run prints the ranked rows to stdout and opens no window.

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

if argv.contains("--dry-run") {
    func value(_ flag: String) -> String? {
        guard let i = argv.firstIndex(of: flag), i + 1 < argv.count else { return nil }
        return argv[i + 1]
    }
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
app.delegate = controller
app.run()
