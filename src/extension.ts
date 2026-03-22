import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Module-level provider reference so activate() can wire commands into it
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

	reg('termicode.newSession', () => provider?.restartSession());

	// addFile: accepts an optional fileUri (from explorer context menu) or uses active editor
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
			prompt: hasSelection
				? 'Ask Claude about the selected code'
				: 'Ask Claude',
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
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
			title: 'Select image to add to Claude',
		});
		if (uris?.[0]) {
			provider?.injectText(`${uris[0].fsPath} `);
			vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
		}
	});

	reg('termicode.clearContext',   () => provider?.injectText('/clear\r'));
	reg('termicode.compactContext', () => provider?.injectText('/compact\r'));
	reg('termicode.history',        () => provider?.injectText('/resume\r'));
	reg('termicode.copyLastResponse', () => provider?.copyLastResponse());

	// Cmd+L: attach selection + show panel, or toggle the secondary sidebar
	reg('termicode.cmdL', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor && !editor.selection.isEmpty) {
			// Has selection → inject code block then make sure panel is visible
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
		} else {
			// No selection → toggle the secondary sidebar (show/hide)
			vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
		}
	});
}

export function deactivate() {
	provider = undefined;
}

// ---------------------------------------------------------------------------

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'input'; data: string }
	| { type: 'resize'; cols: number; rows: number }
	| { type: 'command'; command: string }
	| { type: 'applyCode'; filepath: string; code: string }
	| { type: 'dropImage'; name: string };

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function parseModelName(plain: string): string | null {
	// Claude Code startup banner typically looks like:
	// "claude-sonnet-4-5" or "Sonnet 4.5 (1M context)" or "Using model: ..."
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
	private bridge?: cp.ChildProcess;

	// Model detection
	private startupBuffer = '';
	private modelParsed = false;

	// Copy-last-response buffer (raw, since last user submission)
	private responseBuffer = '';

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
					this.startSession();
					break;

				case 'input':
					if (msg.data) {
						// Reset response buffer when user submits (Enter = \r)
						if (msg.data.includes('\r')) { this.responseBuffer = ''; }
						this.bridge?.stdin?.write(msg.data);
					}
					break;

				case 'resize':
					if (msg.cols && msg.rows) {
						this.bridge?.stdin?.write(`\x1b[8;${msg.rows};${msg.cols}t`);
					}
					break;

				case 'command':
					if ((msg as any).command) {
						vscode.commands.executeCommand((msg as any).command);
					}
					break;

				case 'applyCode':
					if ((msg as any).filepath && (msg as any).code !== undefined) {
						await this.applyCodeToFile((msg as any).filepath, (msg as any).code);
					}
					break;

				case 'dropImage':
					if ((msg as any).name) {
						await this.resolveDroppedImage((msg as any).name);
					}
					break;
			}
		});

		webviewView.onDidDispose(() => {
			this.bridge?.kill();
			this.bridge = undefined;
		});
	}

	// -------------------------------------------------------------------------
	// Session management

	restartSession() {
		this.bridge?.kill();
		this.bridge = undefined;
		this.startupBuffer = '';
		this.modelParsed = false;
		this.responseBuffer = '';
		this.view?.webview.postMessage({ type: 'reset' });
		setTimeout(() => this.startSession(), 200);
	}

	private startSession() {
		if (this.bridge) { return; }

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const claudePath = this.resolveClaudePath();
		const bridgePath = path.join(this.context.extensionPath, 'media', 'pty_bridge.py');

		this.write(`\x1b[90mStarting Claude Code in ${cwd}...\x1b[0m\r\n`);

		this.bridge = cp.spawn('python3', [bridgePath, claudePath, '120', '40'], {
			cwd,
			env: { ...process.env },
		});

		this.bridge.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			this.write(text);
			this.responseBuffer += text;

			// Parse model name from startup banner
			if (!this.modelParsed) {
				this.startupBuffer += stripAnsi(text);
				if (this.startupBuffer.length > 4096) { this.modelParsed = true; }
				const name = parseModelName(this.startupBuffer);
				if (name) {
					this.modelParsed = true;
					this.view?.webview.postMessage({ type: 'modelName', name });
				}
			}
		});

		this.bridge.stderr?.on('data', (chunk: Buffer) => {
			this.write(chunk.toString('utf8'));
		});

		this.bridge.on('error', (err) => {
			this.write(`\r\n\x1b[31m[Failed to start: ${err.message}]\x1b[0m\r\n`);
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				this.write(`\x1b[33mMake sure "claude" is installed, or set termicode.claudePath in settings.\x1b[0m\r\n`);
			}
			this.bridge = undefined;
		});

		this.bridge.on('exit', (code) => {
			this.bridge = undefined;
			this.view?.webview.postMessage({ type: 'sessionEnded' });
			this.write(`\r\n\x1b[90m[Session ended (code ${code}). Press + to start a new session.]\x1b[0m\r\n`);
		});
	}

	// -------------------------------------------------------------------------
	// Public feature methods (called from activate() command handlers)

	injectText(text: string) {
		if (!this.bridge?.stdin) {
			vscode.window.showWarningMessage('Termicode: No active Claude session — start one first.');
			return;
		}
		this.bridge.stdin.write(text);
	}

	getRelativePath(fileUri?: vscode.Uri): string | undefined {
		const uri = fileUri ?? vscode.window.activeTextEditor?.document.uri;
		if (!uri) { return undefined; }
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		return folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
	}

	async copyLastResponse() {
		const plain = stripAnsi(this.responseBuffer).trim();
		if (!plain) {
			vscode.window.showInformationMessage('Termicode: No response to copy yet.');
			return;
		}
		await vscode.env.clipboard.writeText(plain);
		vscode.window.showInformationMessage('Termicode: Last response copied to clipboard.');
	}

	// -------------------------------------------------------------------------
	// Apply code block to file

	private async applyCodeToFile(filepath: string, code: string) {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const absPath = workspaceRoot
			? path.resolve(workspaceRoot, filepath)
			: path.resolve(filepath);

		const uri = vscode.Uri.file(absPath);

		const answer = await vscode.window.showInformationMessage(
			`Apply Claude's code to ${path.basename(filepath)}?`,
			{ modal: true },
			'Apply', 'Open Diff'
		);

		if (answer === 'Apply') {
			await vscode.workspace.fs.writeFile(uri, Buffer.from(code, 'utf8'));
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true });
			vscode.window.showInformationMessage(`Applied to ${path.basename(filepath)}`);
		} else if (answer === 'Open Diff') {
			let existingUri = uri;
			try { fs.accessSync(absPath); } catch { existingUri = vscode.Uri.parse('untitled:empty'); }
			const proposed = await vscode.workspace.openTextDocument({
				content: code,
				language: vscode.window.activeTextEditor?.document.languageId ?? 'plaintext',
			});
			await vscode.commands.executeCommand(
				'vscode.diff',
				existingUri,
				proposed.uri,
				`${path.basename(filepath)}: Current ↔ Claude`
			);
		}
	}

	// Resolve a dropped image filename to an absolute path
	private async resolveDroppedImage(name: string) {
		const matches = await vscode.workspace.findFiles(`**/${name}`, undefined, 5);
		if (matches.length === 1) {
			this.injectText(`${matches[0].fsPath} `);
		} else if (matches.length > 1) {
			const picked = await vscode.window.showQuickPick(
				matches.map(u => u.fsPath),
				{ title: `Multiple matches — pick the image: ${name}` }
			);
			if (picked) { this.injectText(`${picked} `); }
		} else {
			// Fallback: show file picker
			const uris = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectMany: false,
				filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
				title: `Locate dropped file: ${name}`,
			});
			if (uris?.[0]) { this.injectText(`${uris[0].fsPath} `); }
		}
	}

	// -------------------------------------------------------------------------
	// Helpers

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

	private write(data: string) {
		this.view?.webview.postMessage({ type: 'write', data });
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

		/* ── Toolbar ─────────────────────────────────────────── */
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
			width: 28px;
			height: 26px;
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
			width: 1px;
			height: 16px;
			background: var(--vscode-widget-border, #404040);
			margin: 0 3px;
			flex-shrink: 0;
			opacity: 0.6;
		}

		#model-badge {
			margin-left: auto;
			font-size: 10px;
			color: var(--vscode-descriptionForeground, #888);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			max-width: 140px;
			padding: 0 6px 0 4px;
			opacity: 0;
			transition: opacity 0.5s;
			letter-spacing: 0.01em;
		}
		#model-badge.visible { opacity: 1; }

		/* ── Terminal ─────────────────────────────────────────── */
		#terminal-wrap {
			flex: 1;
			min-height: 0;
			position: relative;
			overflow: hidden;
		}
		#terminal { width: 100%; height: 100%; }

		/* ── Apply bar ───────────────────────────────────────── */
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
			padding: 2px 10px;
			border: none;
			border-radius: 3px;
			background: var(--vscode-button-background, #0e639c);
			color: var(--vscode-button-foreground, #fff);
			cursor: pointer;
			font-size: 11px;
		}
		#btn-apply:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
		#btn-apply-diff {
			padding: 2px 8px;
			border: 1px solid var(--vscode-button-border, #555);
			border-radius: 3px;
			background: transparent;
			color: var(--vscode-foreground, #ccc);
			cursor: pointer;
			font-size: 11px;
		}
		#btn-apply-diff:hover { background: rgba(255,255,255,.1); }

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
	</style>
</head>
<body>
	<!-- Terminal -->
	<div id="terminal-wrap">
		<div id="terminal"></div>
		<div id="drag-overlay">Drop image to add to Claude</div>
	</div>

	<!-- Apply code bar (shown when a code block with a file path is detected) -->
	<div id="apply-bar">
		<span>Claude suggests changes to</span>
		<span id="apply-file"></span>
		<button id="btn-apply">Apply</button>
		<button id="btn-apply-diff">Diff</button>
	</div>

	<!-- Toolbar (bottom) -->
	<div id="toolbar">

		<!-- Add current file -->
		<button class="tb-btn" id="btn-addFile" title="Add Current File  ⌘⇧A">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
				<path d="M9 1.5H4.5A.5.5 0 004 2v12a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V5.5L9 1.5zm0 1.2l2.3 2.3H9V2.7zM5 14V2.5h3.5V5a.5.5 0 00.5.5H12V14H5z"/>
				<path d="M7.5 7.5V6H9v1.5h1.5V9H9v1.5H7.5V9H6V7.5h1.5z"/>
			</svg>
		</button>

		<!-- Add image -->
		<button class="tb-btn" id="btn-addImage" title="Add Image  ⌘⌥I">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
				<path d="M14 3H2a1 1 0 00-1 1v8a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1zm0 9H2V4h12v8z"/>
				<circle cx="5" cy="6.5" r="1.1"/>
				<path d="M2.5 12l3.5-4.5 2.5 3 2-2.5 3 4H2.5z"/>
			</svg>
		</button>

		<div class="tb-sep"></div>

		<!-- Clear context -->
		<button class="tb-btn danger" id="btn-clear" title="Clear Context  ⌘⌥X">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
				<path d="M10 3h3v1H2V3h3V2a1 1 0 011-1h3a1 1 0 011 1v1zm-5 0h4V2H5v1zm6 2H4.5l.5 8.5h6L11 5zm-5.5 1v6.5h1V6h-1zm2 0v6.5h1V6h-1zm2 0v6.5h1V6h-1z"/>
			</svg>
		</button>

		<!-- Compact context -->
		<button class="tb-btn" id="btn-compact" title="Compact Context  ⌘⌥M">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
				<path d="M5 4l3-3 3 3-1 1-2-2-2 2L5 4zm6 8l-3 3-3-3 1-1 2 2 2-2 1 1zM2 7h12v2H2z"/>
			</svg>
		</button>

		<!-- Session history -->
		<button class="tb-btn" id="btn-history" title="Session History  ⌘⌥H">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
				<path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1a5 5 0 110 10A5 5 0 018 3zm-.5 2v4l3.5 1.8-.5.9L7 9.8V5h.5z"/>
			</svg>
		</button>

		<div class="tb-sep"></div>

		<!-- Copy last response -->
		<button class="tb-btn" id="btn-copy" title="Copy Last Response">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
				<path d="M11 2H4a1 1 0 00-1 1v9h1V3h7V2zm2 2H6a1 1 0 00-1 1v9a1 1 0 001 1h7a1 1 0 001-1V5a1 1 0 00-1-1zm0 10H6V5h7v9z"/>
			</svg>
		</button>

		<!-- New session -->
		<button class="tb-btn" id="btn-new" title="New Session  ⌘⌥N">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
				<path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z"/>
			</svg>
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
