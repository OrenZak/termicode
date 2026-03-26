# Termicode – Claude Code Panel

A VS Code extension that runs Claude Code CLI as a first-class terminal panel in the secondary sidebar.

## Build & Run

```bash
yarn build          # production build → dist/extension.js
yarn watch          # incremental rebuild on save
yarn package        # build + vsce package → .vsix
```

Press `F5` in VS Code to launch the Extension Development Host.
Reload the host with `Cmd+Shift+P → Developer: Reload Window` after changes.

## Architecture

```
src/
  extension.ts      # activate(), command registration, keybindings
  provider.ts       # ClaudeTerminalViewProvider — webview lifecycle & public API
  sessionManager.ts # multi-tab session state, persistence, worktree mode
  bridgeManager.ts  # spawns pty_bridge.py, wires stdout→webview / stdin←inject
  features.ts       # applyCode, copyLastResponse, plan preview helpers
  utils.ts          # getNonce, stripAnsi, parseModelName, execPromise
media/
  pty_bridge.py     # Python PTY bridge — runs `claude` in a real pseudo-terminal
  webview.html      # HTML template ({{NONCE}}, {{XTERM_*}} placeholders)
  webview.js        # xterm.js wiring, tab bar, toolbar, drag-drop, key handlers
```

Key data flow: `webview.js` ↔ `postMessage` ↔ `provider.ts` ↔ `sessionManager` / `bridgeManager` ↔ `pty_bridge.py` ↔ Claude CLI.

## Coding Conventions

- TypeScript strict mode; no `any` except message union types
- `provider?.method()` optional chaining — `provider` can be undefined before activation
- Webview messages use a discriminated union (`WebviewMessage` type in `provider.ts`)
- All session state lives in `SessionManager`; `BridgeManager` is stateless
- `webview.js` is plain ES5-compatible JS (no bundler for media files)

## Common Workflows

**Add a new command:**
1. Register in `extension.ts` with `reg('termicode.myCmd', ...)`
2. Declare in `package.json` under `contributes.commands`
3. Add keybinding under `contributes.keybindings` if needed

**Add a new webview message type:**
1. Add to the `WebviewMessage` union in `provider.ts`
2. Handle in the `switch` in `resolveWebviewView`
3. Post from `webview.js` via `vscode.postMessage({ type: '...' })`

---

## Agent Guidelines

### Plan Mode
- Enter plan mode for any task with 3+ steps or architectural decisions.
- If something goes sideways, **stop and re-plan** — do not keep pushing.
- Write detailed specs upfront to reduce ambiguity.

### Subagent Strategy
- Use subagents to keep the main context clean — delegate research and parallel analysis.
- One focused task per subagent.

### Verification Before Done
- Never mark a task complete without proving it works.
- Ask: *"Would a staff engineer approve this?"*
- Run builds, check logs, demonstrate correctness.

### Elegance
- For non-trivial changes, pause and ask: *"Is there a more elegant way?"*
- If a fix feels hacky: re-implement the elegant solution.
- Skip this for simple, obvious fixes — do not over-engineer.

### Autonomous Bug Fixing
- When given a bug report, fix it — no hand-holding needed.
- Point at logs and errors, then resolve them.

### Self-Improvement
- After any correction, update `tasks/lessons.md` with the pattern to prevent recurrence.
- Review lessons at session start.

### Core Principles
- **Simplicity first** — minimal code impact, no temporary fixes.
- Find root causes, not workarounds.
