import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';

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
			provider.restartSession();
		})
	);
}

export function deactivate() { }

// ---------------------------------------------------------------------------

class ClaudeTerminalViewProvider implements vscode.WebviewViewProvider {

	private view?: vscode.WebviewView;
	private pty?: cp.ChildProcess;

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

		webviewView.webview.onDidReceiveMessage((msg: { type: string; data?: string }) => {
			if (msg.type === 'ready') {
				this.startSession();
			} else if (msg.type === 'input' && msg.data) {
				this.pty?.stdin?.write(msg.data);
			}
		});

		webviewView.onDidDispose(() => {
			this.pty?.kill();
			this.pty = undefined;
		});
	}

	restartSession() {
		this.pty?.kill();
		this.pty = undefined;
		this.view?.webview.postMessage({ type: 'reset' });
		setTimeout(() => this.startSession(), 200);
	}

	private startSession() {
		if (this.pty) {
			return;
		}

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const claudePath = vscode.workspace.getConfiguration('termicode').get<string>('claudePath', 'claude');

		this.write(`\x1b[90mStarting Claude Code in ${cwd}...\x1b[0m\r\n`);

		// Use `script` on macOS/Linux to allocate a pty so claude gets full terminal behaviour
		const [cmd, args] = process.platform === 'win32'
			? [claudePath, []]
			: ['script', ['-q', '/dev/null', claudePath]];

		this.pty = cp.spawn(cmd, args, {
			cwd,
			env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
			shell: process.platform === 'win32',
		});

		this.pty.stdout?.on('data', (chunk: Buffer) => this.write(chunk.toString('utf8')));
		this.pty.stderr?.on('data', (chunk: Buffer) => this.write(chunk.toString('utf8')));

		this.pty.on('error', (err) => {
			this.write(`\r\n\x1b[31m[Failed to start claude: ${err.message}]\x1b[0m\r\n`);
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				this.write(`\x1b[33mMake sure "claude" is installed and on your PATH.\x1b[0m\r\n`);
				this.write(`\x1b[33mOr set "termicode.claudePath" in settings.\x1b[0m\r\n`);
			}
			this.pty = undefined;
		});

		this.pty.on('exit', (code) => {
			this.pty = undefined;
			this.write(`\r\n\x1b[90m[Session ended (code ${code}). Press + to start a new session.]\x1b[0m\r\n`);
		});
	}

	private write(data: string) {
		this.view?.webview.postMessage({ type: 'write', data });
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
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${uri('xterm.css')}">
	<style>
		html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-terminal-background, #1e1e1e); }
		#terminal { width: 100%; height: 100%; }
	</style>
</head>
<body>
	<div id="terminal"></div>
	<script nonce="${nonce}" src="${uri('xterm.js')}"></script>
	<script nonce="${nonce}" src="${uri('xterm-addon-fit.js')}"></script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		const term = new Terminal({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: 'var(--vscode-editor-font-family, "Cascadia Code", Menlo, monospace)',
			theme: {
				background:    getComputedStyle(document.body).getPropertyValue('--vscode-terminal-background').trim()    || '#1e1e1e',
				foreground:    getComputedStyle(document.body).getPropertyValue('--vscode-terminal-foreground').trim()    || '#d4d4d4',
				cursor:        getComputedStyle(document.body).getPropertyValue('--vscode-terminalCursor-foreground').trim() || '#aeafad',
				black:         '#1e1e1e', red:     '#f44747', green:   '#6a9955', yellow:  '#d7ba7d',
				blue:          '#569cd6', magenta: '#c586c0', cyan:    '#9cdcfe', white:   '#d4d4d4',
				brightBlack:   '#808080', brightRed: '#f44747', brightGreen: '#b5cea8', brightYellow: '#dcdcaa',
				brightBlue:    '#9cdcfe', brightMagenta: '#c586c0', brightCyan: '#4ec9b0', brightWhite: '#ffffff',
			},
			convertEol: true,
			scrollback: 5000,
		});

		const fitAddon = new FitAddon.FitAddon();
		term.loadAddon(fitAddon);
		term.open(document.getElementById('terminal'));
		fitAddon.fit();

		term.onData(data => vscode.postMessage({ type: 'input', data }));

		new ResizeObserver(() => fitAddon.fit()).observe(document.getElementById('terminal'));

		window.addEventListener('message', ({ data: msg }) => {
			if (msg.type === 'write') { term.write(msg.data); }
			else if (msg.type === 'reset') { term.reset(); }
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
