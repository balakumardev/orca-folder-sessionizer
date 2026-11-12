# Folder Sessionizer for Orca

Press `Ctrl+Shift+F` in Orca, type a few letters of a project name, press Enter. A native macOS picker lists the folders under your search roots and opens the one you choose in Orca.

## Install

```
orca plugin install balakumardev/orca-folder-sessionizer@v0.1.0
```

The plugin runs code, so Orca stops with exit code 3 and prints what it would be granted plus an `--approve` command. Read the list, then run that command.

Needs Orca 1.4.248 or newer on macOS 13 or newer. Tested on Orca 1.4.257 on Apple Silicon; the Intel half of the picker is built but not run by the author. [`fd`](https://github.com/sharkdp/fd) is optional: without it the plugin scans with `readdir`, which is slower.

## Keys

| Key | Action |
| --- | --- |
| Enter | the action set in Settings (default: new terminal tab) |
| `Cmd+Enter`, `Ctrl+A` | Claude agent |
| `Ctrl+X` | Codex agent |
| `Ctrl+W`, `Shift+Enter` | new Git worktree with a Claude agent |
| `Opt+Enter`, `Ctrl+O` | switch to the workspace, open nothing new |
| Up, Down, `Ctrl+N`, `Ctrl+P`, `Ctrl+J`, `Ctrl+K` | move |
| Esc | cancel |

Open workspaces and recently used folders come first when the search box is empty. The shortcut can be rebound in Settings, Shortcuts.

## Settings

- **Search roots**: comma-separated folders, `~` allowed. Default `~/workspace, ~/personal`.
- **Max depth**: 1 to 6 levels below each root. Default 3.
- **Enter key action**: terminal, claude, codex, open or worktree. Default terminal.

## What it does with a folder

- A Git repository root is added to Orca as a project, and its main checkout is shown, so the terminal or agent opens in that exact folder. No copy is made.
- Any other folder (a subfolder, or a parent of several repos) is added as a folder workspace.
- The worktree action creates a new isolated worktree and starts Claude in it. On a folder that is not a Git root it opens a terminal instead and logs why.
- A folder Orca already shows is reused. Nothing is added twice.

## What it is allowed to do

It is a `trusted-worker`: a Node process with your user's access to the machine. It also ships a compiled picker, `bin/orca-folder-picker`. The source is `swift/Picker.swift`, so you can rebuild it and compare:

```
swiftc -O -swift-version 5 -target arm64-apple-macos13.0  swift/Picker.swift -o /tmp/picker-arm64
swiftc -O -swift-version 5 -target x86_64-apple-macos13.0 swift/Picker.swift -o /tmp/picker-x86_64
lipo -create /tmp/picker-arm64 /tmp/picker-x86_64 -output bin/orca-folder-picker
codesign --force --sign - bin/orca-folder-picker
```

Capabilities: `workspace:read` (list existing workspaces), `workspace:write` (switch workspace), `settings:own`, `storage:own` (recent folders), `terminal:send` and `agent:launch`. The last two are declared, but the worker currently opens terminals and agents through the `orca` CLI rather than these host calls.

## Troubleshooting

`orca plugin logs balakumardev.folder-sessionizer` shows what the worker did. A `picker: N folders` line means the shortcut fired and the picker was started. The picker is macOS only, so on another system the command logs an error.

## Development

```
orca plugin types .      # writes .orca/types, needed by tsc
tsc --noEmit -p .
orca plugin validate .
orca plugin test .
bin/orca-folder-picker --selftest
```

Remove `.orca/` before installing or updating from a local folder. On Orca 1.4.257 its presence made the integrity check fail for a dev-loaded plugin.

## License

MIT
