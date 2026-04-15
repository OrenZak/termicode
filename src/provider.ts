import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from './sessionManager';
import { BridgeManager } from './bridgeManager';
import { applyCodeToFile, copyLastResponse, resolveDroppedImage } from './features';
import { getNonce } from './utils';

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'input'; data: string }
	| { type: 'resize'; cols: number; rows: number }
	| { type: 'command'; command: string }
	| { type: 'switchTab'; id: string }
	| { type: 'closeTab'; id: string }
	| { type: 'applyCode'; filepath: string; code: string }
	| { type: 'dropImage'; name: string }
	| { type: 'toggleWorktree' }
	| { type: 'renameTab'; id: string; label: string };

export class ClaudeTerminalViewProvider implements vscode.WebviewViewProvider {

	private view?: vscode.WebviewView;
	private sessionManager: SessionManager;
	private bridgeManager: BridgeManager;

	constructor(private readonly context: vscode.ExtensionContext) {
		const postMessage = (msg: any) => this.view?.webview.postMessage(msg);
		this.bridgeManager = new BridgeManager(context, postMessage);
		this.sessionManager = new SessionManager(context, postMessage, (session, extraArgs) => this.bridgeManager.startBridge(session, extraArgs));
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_ctx: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this.view = webviewView;
		const version = this.context.extension.packageJSON.version as string;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
			switch (msg.type) {
				case 'ready':
					webviewView.webview.postMessage({ type: 'version', value: version });
					this.sendMcpAuthWarning(webviewView.webview);
					await this.sessionManager.initSessions();
					break;
				case 'input':
					this.sessionManager.handleInput(msg);
					break;
				case 'resize':
					this.sessionManager.handleResize(msg);
					break;
				case 'command':
					vscode.commands.executeCommand((msg as any).command);
					break;
				case 'switchTab':
					this.sessionManager.setActiveSession((msg as any).id);
					break;
				case 'closeTab':
					await this.sessionManager.closeSession((msg as any).id);
					break;
				case 'applyCode':
					await applyCodeToFile((msg as any).filepath, (msg as any).code);
					break;
				case 'dropImage': {
					const sessionCwd = this.sessionManager.activeSession()?.cwd;
					await resolveDroppedImage((msg as any).name, (text) => this.injectText(text), (msg as any).base64, sessionCwd);
					break;
				}
					break;
				case 'toggleWorktree': {
					const enabled = this.sessionManager.toggleWorktreeMode();
					this.view?.webview.postMessage({ type: 'worktreeMode', enabled });
					break;
				}
				case 'renameTab':
					this.sessionManager.renameSession(msg.id, msg.label);
					break;
			}
		});

		webviewView.onDidDispose(() => {
			this.sessionManager.disposeAll();
		});
	}

	// -------------------------------------------------------------------------
	// Public API (called from extension.ts commands)

	newSession() { return this.sessionManager.newSession(); }
	restartSession() { return this.sessionManager.restartSession(); }

	focusTerminal() {
		setTimeout(() => this.view?.webview.postMessage({ type: 'focus' }), 150);
	}

	injectText(text: string) {
		const s = this.sessionManager.activeSession();
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

	private sendMcpAuthWarning(webview: vscode.Webview): void {
		const statusFile = path.join(os.homedir(), '.claude', 'mcp-auth-status.json');
		const logFile = path.join(os.homedir(), '.claude', 'logs', 'mcp-auth-check.log');
		try {
			if (!fs.existsSync(statusFile)) { return; }
			const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
			const ageSeconds = Math.floor(Date.now() / 1000) - (status.timestamp ?? 0);
			if (ageSeconds < 3600 && Array.isArray(status.needs_auth) && status.needs_auth.length > 0) {
				// Include last 30 log lines for error context
				let logTail = '';
				try {
					if (fs.existsSync(logFile)) {
						const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
						logTail = lines.slice(-30).join('\n');
					}
				} catch { /* non-fatal */ }
				webview.postMessage({ type: 'mcpAuthWarning', servers: status.needs_auth, logTail });
			}
		} catch { /* non-fatal */ }
	}

	async copyLastResponse() {
		const s = this.sessionManager.activeSession();
		await copyLastResponse(s?.responseBuffer ?? '');
	}

	// -------------------------------------------------------------------------
	// HTML

	private getHtml(webview: vscode.Webview): string {
		const uri = (file: string) => webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', file)
		).toString();
		const nonce = getNonce();
		const template = fs.readFileSync(
			path.join(this.context.extensionPath, 'media', 'webview.html'), 'utf8'
		);
		return template
			.replace(/\{\{NONCE\}\}/g, nonce)
			.replace(/\{\{CSP_SOURCE\}\}/g, webview.cspSource)
			.replace('{{XTERM_CSS}}', uri('xterm.css'))
			.replace('{{XTERM_JS}}', uri('xterm.js'))
			.replace('{{FIT_ADDON_JS}}', uri('xterm-addon-fit.js'))
			.replace('{{WEBVIEW_JS}}', uri('webview.js'));
	}
}
