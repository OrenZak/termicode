<div align="center">
  <img src="media/claude-icon.svg" width="100" />
  <h1>Termicode – AI Agent Panel</h1>
  <p>Run AI coding agents like <a href="https://claude.ai/code">Claude Code</a>, OpenAI Codex, Cursor Agent, and Gemini CLI as a first-class terminal panel inside VS Code's secondary sidebar.</p>
</div>

---

No more alt-tabbing to a terminal. Termicode embeds full coding-agent sessions next to your code, with multi-tab support, provider selection per tab, file/selection injection, and a real PTY so the terminal behaves exactly like your native terminal.

---

## Features

**Multi-provider tabs** — run Claude, Codex, Cursor Agent, and Gemini in separate tabs, with a visible provider badge and live status indicator on each one.

**Default provider** — set a favorite agent for the `+DEF` button and the new-session shortcut, while the plain `+` button always opens the provider picker for one-off sessions.

**Selection → context** — press `Cmd+L` on selected code to inject it as a file reference (`@file:line-range`) into the active agent's input.

**File & image injection** — add the current file, a selection, or an image to the active agent's context with a single shortcut or toolbar button.

**Provider-aware controls** — compact, clear, and history actions adapt to the active provider, and unsupported actions are disabled instead of sending the wrong command.

**Install on demand** — if you pick a provider that is missing, Termicode offers to install it before the session opens and ignores stale configured binary paths that no longer exist.

**Worktree mode** — create a new git worktree per session so parallel agent instances never interfere with each other.

**Session persistence** — tabs survive VS Code reloads. Providers with resumable CLI session IDs restore their conversations when possible; others reopen fresh tabs in the same working directory.

**Plan preview** — when an agent writes a plan, it automatically opens in a Markdown preview panel.

**Real PTY** — powered by a Python bridge that allocates a true pseudo-terminal, so colours, cursor movement, and interactive prompts all work correctly.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+L` | Add selected code to the active agent (`@file:line`) · toggle panel when no selection |
| `Cmd+Escape` | Same as `Cmd+L` |
| `Cmd+Shift+A` | Add current file to the active agent |
| `Cmd+Alt+N` | New agent session using your default provider, or the picker if default is `Always Ask` |
| `Cmd+Alt+C` | Open Termicode panel |
| `Cmd+Alt+I` | Add image to the active agent |
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
- OpenAI Codex CLI, Cursor Agent CLI, and/or Gemini CLI if you want to use those providers
- Python 3 (ships with macOS / most Linux distros)
- VS Code 1.90+

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `termicode.defaultProvider` | `prompt` | Default provider for new sessions. Set this to `claude`, `codex`, `cursor`, or `gemini` to make the `+` button and `Cmd+Alt+N` open that provider directly |
| `termicode.claudePath` | _(auto-detect)_ | Path to the `claude` executable — set this if `claude` isn't on your `PATH` |
| `termicode.codexPath` | _(auto-detect)_ | Path to the `codex` executable |
| `termicode.cursorAgentPath` | _(auto-detect)_ | Path to the `cursor-agent` executable |
| `termicode.geminiPath` | _(auto-detect)_ | Path to the `gemini` executable |

Auto-detection checks common install locations in `~/.local/bin`, `~/.npm-global/bin`, `/usr/local/bin`, and `/opt/homebrew/bin` for each provider.

Use `Termicode: Set Default Provider...` to update the default from the command palette or panel title bar, and `Termicode: New Session (Choose Provider)...` whenever you want to override it for a single tab.

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
