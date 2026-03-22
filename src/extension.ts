import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

let provider: ClaudeTerminalViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	provider = new ClaudeTerminalViewProvider(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'termicode.terminal',
			provider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	const reg = (id: string, fn: (...args: any[]) => any) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	reg('termicode.open', () =>
		vscode.commands.executeCommand('workbench.view.extension.termicode-claude'));

	reg('termicode.newSession', () => provider?.newSession());

	reg('termicode.addFile', (fileUri?: vscode.Uri) => {
		const rel = provider?.getRelativePath(fileUri);
		if (rel) {
			provider?.injectText(`@${rel} `);
			vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
		} else {
			vscode.window.showWarningMessage('Termicode: No file to add (open a file first).');
		}
	});

	reg('termicode.addSelection', () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			vscode.window.showWarningMessage('Termicode: Select some code first.');
			return;
		}
		const sel = editor.selection;
		const text = editor.document.getText(sel);
		const rel = provider?.getRelativePath() ?? editor.document.uri.fsPath;
		const lang = editor.document.languageId;
		const startLine = sel.start.line + 1;
		const endLine = sel.end.line + 1;
		const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
		const block = `\`\`\`${lang}\n# ${rel}:${lineRange}\n${text}\n\`\`\`\n`;
		provider?.injectText(block);
		vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
	});

	reg('termicode.askClaude', async () => {
		const editor = vscode.window.activeTextEditor;
		const hasSelection = editor && !editor.selection.isEmpty;
		const question = await vscode.window.showInputBox({
			prompt: hasSelection ? 'Ask Claude about the selected code' : 'Ask Claude',
			placeHolder: 'What does this do? How can I improve it?',
		});
		if (!question) { return; }
		let payload = '';
		if (hasSelection && editor) {
			const text = editor.document.getText(editor.selection);
			const rel = provider?.getRelativePath() ?? editor.document.uri.fsPath;
			const lang = editor.document.languageId;
			const line = editor.selection.start.line + 1;
			payload = `${question}\n\`\`\`${lang}\n# ${rel}:${line}\n${text}\n\`\`\`\r`;
		} else {
			payload = `${question}\r`;
		}
		provider?.injectText(payload);
		vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
	});

	reg('termicode.addImage', async () => {
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
			filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
			title: 'Select image to add to Claude',
		});
		if (uris?.[0]) {
			provider?.injectText(`${uris[0].fsPath} `);
			vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
		}
	});

	reg('termicode.clearContext',    () => provider?.injectText('/clear\r'));
	reg('termicode.compactContext',  () => provider?.injectText('/compact\r'));
	reg('termicode.history',         () => provider?.injectText('/resume\r'));
	reg('termicode.copyLastResponse',() => provider?.copyLastResponse());

	reg('termicode.cmdL', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor && !editor.selection.isEmpty) {
			const sel = editor.selection;
			const text = editor.document.getText(sel);
			const rel = provider?.getRelativePath() ?? editor.document.uri.fsPath;
			const lang = editor.document.languageId;
			const startLine = sel.start.line + 1;
			const endLine = sel.end.line + 1;
			const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
			provider?.injectText(`\`\`\`${lang}\n# ${rel}:${lineRange}\n${text}\n\`\`\`\n`);
			vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
		} else {
			vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
		}
	});
}

export function deactivate() { provider = undefined; }

// ---------------------------------------------------------------------------

interface Session {
	id: string;
	bridge?: cp.ChildProcess;
	startupBuffer: string;
	modelParsed: boolean;
	responseBuffer: string;
	cwd: string;
	label: string;
}

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'input'; data: string }
	| { type: 'resize'; cols: number; rows: number }
	| { type: 'command'; command: string }
	| { type: 'switchTab'; id: string }
	| { type: 'closeTab'; id: string }
	| { type: 'applyCode'; filepath: string; code: string }
	| { type: 'dropImage'; name: string };

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function parseModelName(plain: string): string | null {
	const patterns = [
		/\b(claude-[a-z0-9-]+)/i,
		/\b(sonnet|opus|haiku)[\s-]+([\d.]+[^\s,\r\n]*)/i,
		/model[:\s]+([^\n\r,]{4,50})/i,
	];
	for (const re of patterns) {
		const m = plain.match(re);
		if (m) { return m[0].replace(/\s+/g, ' ').trim().substring(0, 50); }
	}
	return null;
}

// ---------------------------------------------------------------------------

class ClaudeTerminalViewProvider implements vscode.WebviewViewProvider {

	private view?: vscode.WebviewView;
	private sessions = new Map<string, Session>();
	private activeSessionId: string | null = null;
	private sessionCounter = 0;

	constructor(private readonly context: vscode.ExtensionContext) { }

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_ctx: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
			switch (msg.type) {
				case 'ready':
					// Start first session automatically
					this.newSession();
					break;

				case 'input': {
					if (msg.data) {
						const s = this.activeSession();
						if (s) {
							if (msg.data.includes('\r')) { s.responseBuffer = ''; }
							s.bridge?.stdin?.write(msg.data);
						}
					}
					break;
				}

				case 'resize': {
					if (msg.cols && msg.rows) {
						// resize all sessions so they're ready when switched to
						for (const s of this.sessions.values()) {
							s.bridge?.stdin?.write(`\x1b[8;${msg.rows};${msg.cols}t`);
						}
					}
					break;
				}

				case 'command':
					vscode.commands.executeCommand((msg as any).command);
					break;

				case 'switchTab':
					if (this.sessions.has((msg as any).id)) {
						this.activeSessionId = (msg as any).id;
					}
					break;

				case 'closeTab':
					this.closeSession((msg as any).id);
					break;

				case 'applyCode':
					await this.applyCodeToFile((msg as any).filepath, (msg as any).code);
					break;

				case 'dropImage':
					await this.resolveDroppedImage((msg as any).name);
					break;
			}
		});

		webviewView.onDidDispose(() => {
			for (const s of this.sessions.values()) { s.bridge?.kill(); }
			this.sessions.clear();
			this.activeSessionId = null;
		});
	}

	// -------------------------------------------------------------------------
	// Session management

	newSession() {
		const id = String(++this.sessionCounter);
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const label = path.basename(cwd);
		const session: Session = {
			id, cwd, label,
			startupBuffer: '', modelParsed: false, responseBuffer: '',
		};
		this.sessions.set(id, session);
		this.activeSessionId = id;

		// tell webview to create the terminal tab and switch to it
		this.view?.webview.postMessage({ type: 'newTab', id, label });

		this.startBridge(session);
	}

	// legacy alias used by restartSession command
	restartSession() {
		const s = this.activeSession();
		if (s) {
			s.bridge?.kill();
			s.bridge = undefined;
			s.startupBuffer = '';
			s.modelParsed = false;
			s.responseBuffer = '';
			this.view?.webview.postMessage({ type: 'resetTab', id: s.id });
			setTimeout(() => this.startBridge(s), 200);
		} else {
			this.newSession();
		}
	}

	private closeSession(id: string) {
		const s = this.sessions.get(id);
		if (!s) { return; }
		s.bridge?.kill();
		this.sessions.delete(id);

		if (this.activeSessionId === id) {
			const remaining = [...this.sessions.keys()];
			this.activeSessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
			if (this.activeSessionId) {
				this.view?.webview.postMessage({ type: 'activateTab', id: this.activeSessionId });
			}
		}
	}

	private startBridge(session: Session) {
		const claudePath = this.resolveClaudePath();
		const bridgePath = path.join(this.context.extensionPath, 'media', 'pty_bridge.py');
		const shortCwd = session.cwd.replace(os.homedir(), '~');

		this.write(session.id, `\x1b[90mStarting Claude Code in ${session.cwd}...\x1b[0m\r\n`);
		this.view?.webview.postMessage({ type: 'sessionStarted', id: session.id, cwd: shortCwd });

		session.bridge = cp.spawn('python3', [bridgePath, claudePath, '120', '40'], {
			cwd: session.cwd,
			env: { ...process.env },
		});

		session.bridge.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			this.write(session.id, text);
			session.responseBuffer += text;

			if (!session.modelParsed) {
				session.startupBuffer += stripAnsi(text);
				if (session.startupBuffer.length > 4096) { session.modelParsed = true; }
				const name = parseModelName(session.startupBuffer);
				if (name) {
					session.modelParsed = true;
					this.view?.webview.postMessage({ type: 'modelName', id: session.id, name });
				}
			}
		});

		session.bridge.stderr?.on('data', (chunk: Buffer) => {
			this.write(session.id, chunk.toString('utf8'));
		});

		session.bridge.on('error', (err) => {
			this.write(session.id, `\r\n\x1b[31m[Failed to start: ${err.message}]\x1b[0m\r\n`);
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				this.write(session.id, `\x1b[33mMake sure "claude" is installed or set termicode.claudePath.\x1b[0m\r\n`);
			}
			session.bridge = undefined;
		});

		session.bridge.on('exit', (code) => {
			session.bridge = undefined;
			this.view?.webview.postMessage({ type: 'sessionEnded', id: session.id });
			this.write(session.id, `\r\n\x1b[90m[Session ended (code ${code}). Press + to start a new session.]\x1b[0m\r\n`);
		});
	}

	// -------------------------------------------------------------------------
	// Public feature methods

	injectText(text: string) {
		const s = this.activeSession();
		if (!s?.bridge?.stdin) {
			vscode.window.showWarningMessage('Termicode: No active Claude session.');
			return;
		}
		s.bridge.stdin.write(text);
	}

	getRelativePath(fileUri?: vscode.Uri): string | undefined {
		const uri = fileUri ?? vscode.window.activeTextEditor?.document.uri;
		if (!uri) { return undefined; }
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		return folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
	}

	async copyLastResponse() {
		const s = this.activeSession();
		const plain = s ? stripAnsi(s.responseBuffer).trim() : '';
		if (!plain) {
			vscode.window.showInformationMessage('Termicode: No response to copy yet.');
			return;
		}
		await vscode.env.clipboard.writeText(plain);
		vscode.window.showInformationMessage('Termicode: Last response copied to clipboard.');
	}

	private activeSession(): Session | undefined {
		return this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
	}

	private async applyCodeToFile(filepath: string, code: string) {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const absPath = root ? path.resolve(root, filepath) : path.resolve(filepath);
		const uri = vscode.Uri.file(absPath);
		const answer = await vscode.window.showInformationMessage(
			`Apply Claude's code to ${path.basename(filepath)}?`,
			{ modal: true }, 'Apply', 'Open Diff'
		);
		if (answer === 'Apply') {
			await vscode.workspace.fs.writeFile(uri, Buffer.from(code, 'utf8'));
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true });
		} else if (answer === 'Open Diff') {
			let existingUri = uri;
			try { fs.accessSync(absPath); } catch { existingUri = vscode.Uri.parse('untitled:empty'); }
			const proposed = await vscode.workspace.openTextDocument({ content: code });
			await vscode.commands.executeCommand('vscode.diff', existingUri, proposed.uri, `${path.basename(filepath)}: Current ↔ Claude`);
		}
	}

	private async resolveDroppedImage(name: string) {
		const matches = await vscode.workspace.findFiles(`**/${name}`, undefined, 5);
		if (matches.length === 1) {
			this.injectText(`${matches[0].fsPath} `);
		} else if (matches.length > 1) {
			const picked = await vscode.window.showQuickPick(matches.map(u => u.fsPath));
			if (picked) { this.injectText(`${picked} `); }
		} else {
			const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'] } });
			if (uris?.[0]) { this.injectText(`${uris[0].fsPath} `); }
		}
	}

	private resolveClaudePath(): string {
		const configured = vscode.workspace.getConfiguration('termicode').get<string>('claudePath', '');
		if (configured) { return configured; }
		const candidates = [
			path.join(os.homedir(), '.local', 'bin', 'claude'),
			path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
			'/usr/local/bin/claude',
			'/opt/homebrew/bin/claude',
		];
		for (const p of candidates) {
			try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { }
		}
		return 'claude';
	}

	private write(sessionId: string, data: string) {
		this.view?.webview.postMessage({ type: 'write', id: sessionId, data });
	}

	// -------------------------------------------------------------------------
	// Webview HTML

	private getHtml(webview: vscode.Webview): string {
		const uri = (file: string) => webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', file)
		);
		const nonce = getNonce();

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${uri('xterm.css')}">
	<style>
		*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

		html, body {
			width: 100%; height: 100%;
			overflow: hidden;
			display: flex;
			flex-direction: column;
			background: var(--vscode-terminal-background, #1e1e1e);
			font-family: var(--vscode-font-family, system-ui);
			font-size: 11px;
		}

		/* ── Session tab bar ─────────────────────────────────── */
		#tab-bar {
			display: flex;
			align-items: stretch;
			background: var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d);
			border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #252526);
			height: 35px;
			overflow-x: auto;
			overflow-y: hidden;
			flex-shrink: 0;
			scrollbar-width: none;
		}
		#tab-bar::-webkit-scrollbar { display: none; }

		.session-tab {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 0 10px 0 12px;
			border: none;
			border-right: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #252526);
			background: var(--vscode-tab-inactiveBackground, #2d2d2d);
			color: var(--vscode-tab-inactiveForeground, #888);
			cursor: pointer;
			white-space: nowrap;
			font-size: 11px;
			min-width: 80px;
			max-width: 150px;
			flex-shrink: 0;
			position: relative;
			transition: background 0.1s;
		}
		.session-tab:hover { background: var(--vscode-tab-hoverBackground, #323232); color: var(--vscode-tab-hoverForeground, #aaa); }
		.session-tab.active {
			background: var(--vscode-tab-activeBackground, #1e1e1e);
			color: var(--vscode-tab-activeForeground, #fff);
			border-top: 1px solid var(--vscode-tab-activeBorderTop, #007acc);
		}
		.tab-dot {
			width: 5px; height: 5px;
			border-radius: 50%;
			background: #444;
			flex-shrink: 0;
			transition: background 0.3s;
		}
		.session-tab.running .tab-dot { background: #4ec9b0; }
		.tab-label {
			flex: 1;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.tab-close {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 16px; height: 16px;
			border: none;
			border-radius: 3px;
			background: transparent;
			color: inherit;
			cursor: pointer;
			font-size: 14px;
			opacity: 0;
			flex-shrink: 0;
			line-height: 1;
			transition: opacity 0.1s, background 0.1s;
		}
		.session-tab:hover .tab-close,
		.session-tab.active .tab-close { opacity: 0.6; }
		.tab-close:hover { opacity: 1 !important; background: rgba(255,255,255,.1); }

		#btn-new-tab {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 35px;
			border: none;
			background: transparent;
			color: var(--vscode-tab-inactiveForeground, #666);
			cursor: pointer;
			font-size: 18px;
			flex-shrink: 0;
		}
		#btn-new-tab:hover { color: var(--vscode-foreground, #fff); background: rgba(255,255,255,.05); }

		/* ── Status bar ───────────────────────────────────────── */
		#status-bar {
			display: flex;
			align-items: center;
			gap: 5px;
			padding: 0 10px;
			height: 22px;
			background: var(--vscode-sideBar-background, #252526);
			border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, #2d2d2d);
			flex-shrink: 0;
			font-size: 10px;
			color: var(--vscode-descriptionForeground, #666);
			user-select: none;
		}
		#status-dot {
			width: 6px; height: 6px;
			border-radius: 50%;
			background: #444;
			flex-shrink: 0;
			transition: background 0.3s;
		}
		#status-dot.active { background: #4ec9b0; box-shadow: 0 0 4px #4ec9b066; }
		#status-label { color: var(--vscode-foreground, #ccc); font-weight: 500; }
		.st-sep { opacity: 0.25; margin: 0 1px; }
		#status-model { color: var(--vscode-descriptionForeground, #666); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		#status-cwd   { color: var(--vscode-descriptionForeground, #555); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

		/* ── Terminal area ────────────────────────────────────── */
		#terminal-wrap {
			flex: 1;
			min-height: 0;
			position: relative;
			overflow: hidden;
			padding: 6px 8px 4px;
		}

		.term-instance {
			position: absolute;
			inset: 6px 8px 4px;
			display: none;
		}
		.term-instance.active { display: block; }

		/* thin VS Code-style scrollbar */
		.xterm-viewport::-webkit-scrollbar { width: 6px; }
		.xterm-viewport::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 3px; }
		.xterm-viewport::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.25); }
		.xterm-viewport::-webkit-scrollbar-track { background: transparent; }

		/* ── Drag overlay ────────────────────────────────────── */
		#drag-overlay {
			display: none;
			position: absolute;
			inset: 0;
			background: rgba(14, 99, 156, 0.25);
			border: 2px dashed var(--vscode-focusBorder, #007fd4);
			z-index: 10;
			align-items: center;
			justify-content: center;
			font-size: 14px;
			color: var(--vscode-foreground, #ccc);
			pointer-events: none;
		}
		#drag-overlay.visible { display: flex; }

		/* ── Apply code bar ───────────────────────────────────── */
		#apply-bar {
			display: none;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			background: var(--vscode-editorInfo-background, #1f3a5f);
			border-top: 1px solid var(--vscode-editorInfo-border, #2e6da4);
			flex-shrink: 0;
			font-size: 11px;
			color: var(--vscode-foreground, #ccc);
		}
		#apply-bar.visible { display: flex; }
		#apply-file { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		#btn-apply {
			padding: 2px 10px; border: none; border-radius: 3px;
			background: var(--vscode-button-background, #0e639c);
			color: var(--vscode-button-foreground, #fff);
			cursor: pointer; font-size: 11px;
		}
		#btn-apply:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
		#btn-apply-diff {
			padding: 2px 8px;
			border: 1px solid var(--vscode-button-border, #555);
			border-radius: 3px; background: transparent;
			color: var(--vscode-foreground, #ccc);
			cursor: pointer; font-size: 11px;
		}
		#btn-apply-diff:hover { background: rgba(255,255,255,.1); }

		/* ── Bottom toolbar ───────────────────────────────────── */
		#toolbar {
			display: flex;
			align-items: center;
			gap: 1px;
			padding: 2px 4px;
			background: var(--vscode-sideBar-background, #252526);
			border-top: 1px solid var(--vscode-sideBarSectionHeader-border, #3c3c3c);
			flex-shrink: 0;
		}
		.tb-btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 28px; height: 26px;
			padding: 0;
			border: none;
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-icon-foreground, #c5c5c5);
			cursor: pointer;
			flex-shrink: 0;
		}
		.tb-btn svg { display: block; pointer-events: none; }
		.tb-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.1)); color: var(--vscode-foreground, #fff); }
		.tb-btn:active { background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,.18)); }
		.tb-btn.danger:hover { color: var(--vscode-errorForeground, #f48771); }
		.tb-sep {
			width: 1px; height: 16px;
			background: var(--vscode-widget-border, #404040);
			margin: 0 3px; flex-shrink: 0; opacity: 0.6;
		}
		#model-badge {
			margin-left: auto;
			font-size: 10px;
			color: var(--vscode-descriptionForeground, #888);
			white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
			max-width: 140px; padding: 0 6px 0 4px;
			opacity: 0; transition: opacity 0.5s;
		}
		#model-badge.visible { opacity: 1; }
	</style>
</head>
<body>

	<!-- Session tab bar -->
	<div id="tab-bar">
		<button id="btn-new-tab" title="New Claude Session  ⌘⌥N">+</button>
	</div>

	<!-- Status bar -->
	<div id="status-bar">
		<span id="status-dot"></span>
		<span id="status-label">No session</span>
		<span class="st-sep">·</span>
		<span id="status-model"></span>
		<span class="st-sep" id="status-cwd-sep" style="display:none">·</span>
		<span id="status-cwd"></span>
	</div>

	<!-- Terminal area (multiple instances stacked) -->
	<div id="terminal-wrap">
		<div id="drag-overlay">Drop image to add to Claude</div>
	</div>

	<!-- Apply code bar -->
	<div id="apply-bar">
		<span>Claude suggests changes to</span>
		<span id="apply-file"></span>
		<button id="btn-apply">Apply</button>
		<button id="btn-apply-diff">Diff</button>
	</div>

	<!-- Bottom toolbar -->
	<div id="toolbar">
		<button class="tb-btn" id="btn-addFile" title="Add Current File  ⌘⇧A">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1.5H4.5A.5.5 0 004 2v12a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V5.5L9 1.5zm0 1.2l2.3 2.3H9V2.7zM5 14V2.5h3.5V5a.5.5 0 00.5.5H12V14H5z"/><path d="M7.5 7.5V6H9v1.5h1.5V9H9v1.5H7.5V9H6V7.5h1.5z"/></svg>
		</button>
		<button class="tb-btn" id="btn-addImage" title="Add Image  ⌘⌥I">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M14 3H2a1 1 0 00-1 1v8a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1zm0 9H2V4h12v8z"/><circle cx="5" cy="6.5" r="1.1"/><path d="M2.5 12l3.5-4.5 2.5 3 2-2.5 3 4H2.5z"/></svg>
		</button>
		<div class="tb-sep"></div>
		<button class="tb-btn danger" id="btn-clear" title="Clear Context  ⌘⌥X">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3h3v1H2V3h3V2a1 1 0 011-1h3a1 1 0 011 1v1zm-5 0h4V2H5v1zm6 2H4.5l.5 8.5h6L11 5zm-5.5 1v6.5h1V6h-1zm2 0v6.5h1V6h-1zm2 0v6.5h1V6h-1z"/></svg>
		</button>
		<button class="tb-btn" id="btn-compact" title="Compact Context  ⌘⌥M">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5 4l3-3 3 3-1 1-2-2-2 2L5 4zm6 8l-3 3-3-3 1-1 2 2 2-2 1 1zM2 7h12v2H2z"/></svg>
		</button>
		<button class="tb-btn" id="btn-history" title="Session History  ⌘⌥H">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1a5 5 0 110 10A5 5 0 018 3zm-.5 2v4l3.5 1.8-.5.9L7 9.8V5h.5z"/></svg>
		</button>
		<div class="tb-sep"></div>
		<button class="tb-btn" id="btn-copy" title="Copy Last Response">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11 2H4a1 1 0 00-1 1v9h1V3h7V2zm2 2H6a1 1 0 00-1 1v9a1 1 0 001 1h7a1 1 0 001-1V5a1 1 0 00-1-1zm0 10H6V5h7v9z"/></svg>
		</button>
		<span id="model-badge"></span>
	</div>

	<script nonce="${nonce}" src="${uri('xterm.js')}"></script>
	<script nonce="${nonce}" src="${uri('xterm-addon-fit.js')}"></script>
	<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
