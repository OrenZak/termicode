<div align="center">
  <img src="media/claude-icon.svg" width="100" />
  <h1>Termicode – Claude Code Panel</h1>
  <p>Run <a href="https://claude.ai/code">Claude Code</a> CLI as a first-class terminal panel inside VS Code's secondary sidebar.</p>
</div>

---

No more alt-tabbing to a terminal. Termicode embeds a full Claude Code session next to your code, with multi-tab support, file/selection injection, and a real PTY so the terminal behaves exactly like your native terminal.

---

## Features

**Multi-session tabs** — run multiple independent Claude instances simultaneously, each in its own tab with a live status indicator.

**Selection → context** — press `Cmd+L` on selected code to inject it as a file reference (`@file:line-range`) into Claude's input. No text copied, Claude reads it directly.

**File & image injection** — add the current file, a selection, or an image to Claude's context with a single shortcut or toolbar button.

**Worktree mode** — create a new git worktree per session so parallel Claude instances never interfere with each other.

**Session persistence** — sessions survive VS Code reloads; Claude restarts with `--continue` to pick up where it left off.

**Plan preview** — when Claude writes a plan, it automatically opens in a Markdown preview panel.

**Real PTY** — powered by a Python bridge that allocates a true pseudo-terminal, so colours, cursor movement, and interactive prompts all work correctly.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+L` | Add selected code to Claude (`@file:line`) · toggle panel when no selection |
| `Cmd+Escape` | Same as `Cmd+L` |
| `Cmd+Shift+A` | Add current file to Claude |
| `Cmd+Alt+N` | New Claude session (new tab) |
| `Cmd+Alt+C` | Open Termicode panel |
| `Cmd+Alt+I` | Add image to Claude |
| `Cmd+Alt+H` | Session history (`/resume`) |
| `Cmd+Alt+X` | Clear context (`/clear`) |
| `Cmd+Alt+M` | Compact context (`/compact`) |

> Windows/Linux: replace `Cmd` with `Ctrl`.

---

## Installation

### From source

```bash
git clone https://github.com/OrenZak/termicode.git
cd termicode
yarn install
yarn package          # produces termicode-*.vsix
code --install-extension termicode-*.vsix
```

### Prerequisites

- [Claude Code CLI](https://claude.ai/code) installed and on your `PATH`
- Python 3 (ships with macOS / most Linux distros)
- VS Code 1.90+

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `termicode.claudePath` | _(auto-detect)_ | Path to the `claude` executable — set this if `claude` isn't on your `PATH` |

Auto-detection checks `~/.local/bin`, `~/.npm-global/bin`, `/usr/local/bin`, and `/opt/homebrew/bin`.

---

## Development

```bash
yarn watch       # rebuild on every save
```

Press `F5` in VS Code to launch the Extension Development Host with the latest build.

```
src/
  extension.ts      # command registration & keybindings
  provider.ts       # webview lifecycle & public API
  sessionManager.ts # multi-tab state & persistence
  bridgeManager.ts  # PTY bridge process management
  features.ts       # code apply, copy response, plan preview
  utils.ts          # shared helpers
media/
  pty_bridge.py     # Python PTY bridge
  webview.html      # UI template
  webview.js        # xterm.js + tab bar + toolbar
```

---

## License

MIT
