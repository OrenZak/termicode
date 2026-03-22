import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	const provider = new ClaudeTerminalViewProvider(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'termicode.terminal',
			provider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('termicode.open', () => {
			vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('termicode.newSession', () => {
			provider.newSession();
		})
	);

	// When a terminal closes, notify the webview
	context.subscriptions.push(
		vscode.window.onDidCloseTerminal(terminal => {
			provider.onTerminalClosed(terminal);
		})
	);
}

export function deactivate() { }

// ---------------------------------------------------------------------------

class ClaudeTerminalViewProvider implements vscode.WebviewViewProvider {

	private view?: vscode.WebviewView;
	private terminal?: vscode.Terminal;

	constructor(private readonly context: vscode.ExtensionContext) { }

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((msg: { type: string }) => {
			if (msg.type === 'newSession') {
				this.newSession();
			} else if (msg.type === 'focusTerminal') {
				this.terminal?.show(false);
			}
		});
	}

	newSession() {
		// Kill existing session if any
		if (this.terminal) {
			this.terminal.dispose();
			this.terminal = undefined;
		}

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const claudePath = this.resolveClaudePath();

		this.terminal = vscode.window.createTerminal({
			name: 'Claude Code',
			shellPath: claudePath,
			cwd,
			env: {
				TERM: 'xterm-256color',
				COLORTERM: 'truecolor',
			},
			// Open as an editor tab — user can drag to secondary sidebar
			location: vscode.TerminalLocation.Editor,
			isTransient: false,
		});

		this.terminal.show(false); // false = don't steal focus
		this.view?.webview.postMessage({ type: 'sessionStarted', cwd });
	}

	onTerminalClosed(terminal: vscode.Terminal) {
		if (terminal === this.terminal) {
			this.terminal = undefined;
			this.view?.webview.postMessage({ type: 'sessionEnded' });
		}
	}

	private resolveClaudePath(): string {
		const configured = vscode.workspace.getConfiguration('termicode').get<string>('claudePath', '');
		if (configured) { return configured; }

		// Search common install locations
		const candidates = [
			path.join(os.homedir(), '.local', 'bin', 'claude'),
			path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
			'/usr/local/bin/claude',
			'/opt/homebrew/bin/claude',
			'claude', // fallback to PATH lookup
		];

		const fs = require('fs') as typeof import('fs');
		for (const p of candidates) {
			try {
				fs.accessSync(p, fs.constants.X_OK);
				return p;
			} catch { }
		}
		return 'claude';
	}

	private getHtml(webview: vscode.Webview): string {
		const uri = (file: string) => webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', file)
		);
		const nonce = getNonce();

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
			height: 100vh;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 16px;
			padding: 24px;
			text-align: center;
		}

		.logo {
			width: 48px;
			height: 48px;
			border-radius: 10px;
			background: #CC785C;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 28px;
			font-weight: bold;
			color: white;
			font-family: monospace;
		}

		h2 {
			font-size: 15px;
			font-weight: 600;
			color: var(--vscode-foreground);
		}

		p {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			line-height: 1.5;
		}

		button {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 4px;
			padding: 7px 14px;
			font-size: 13px;
			cursor: pointer;
			width: 100%;
			max-width: 200px;
		}

		button:hover { background: var(--vscode-button-hoverBackground); }

		button.secondary {
			background: var(--vscode-button-secondaryBackground, transparent);
			color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
			border: 1px solid var(--vscode-button-border, var(--vscode-widget-border));
		}

		.status {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
		}

		.running { color: var(--vscode-testing-iconPassed, #4caf50); }

		#session-controls { display: none; flex-direction: column; gap: 8px; align-items: center; width: 100%; }
		#start-controls { display: flex; flex-direction: column; gap: 8px; align-items: center; width: 100%; }
	</style>
</head>
<body>
	<div class="logo">C</div>
	<h2>Claude Code</h2>

	<div id="start-controls">
		<p>Opens a full Claude Code terminal as an editor tab. You can drag it to the secondary sidebar.</p>
		<button id="btn-start">Start Claude Session</button>
	</div>

	<div id="session-controls">
		<p class="status running">● Session running</p>
		<p id="session-cwd" class="status"></p>
		<button id="btn-focus" class="secondary">Focus Terminal</button>
		<button id="btn-new">New Session</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const startControls = document.getElementById('start-controls');
		const sessionControls = document.getElementById('session-controls');
		const cwdLabel = document.getElementById('session-cwd');

		document.getElementById('btn-start').onclick = () => vscode.postMessage({ type: 'newSession' });
		document.getElementById('btn-focus').onclick = () => vscode.postMessage({ type: 'focusTerminal' });
		document.getElementById('btn-new').onclick = () => vscode.postMessage({ type: 'newSession' });

		window.addEventListener('message', ({ data }) => {
			if (data.type === 'sessionStarted') {
				startControls.style.display = 'none';
				sessionControls.style.display = 'flex';
				cwdLabel.textContent = data.cwd || '';
			} else if (data.type === 'sessionEnded') {
				startControls.style.display = 'flex';
				sessionControls.style.display = 'none';
			}
		});
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
