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
	| { type: 'renameTab'; id: string; label: string }
	| { type: 'openExternal'; url: string }
	| { type: 'resolveTerminalTag' };

export class ClaudeTerminalViewProvider implements vscode.WebviewViewProvider {

	private view?: vscode.WebviewView;
	private sessionManager: SessionManager;
	private bridgeManager: BridgeManager;
	private lastTerminalOutput = '';
	private readonly log = vscode.window.createOutputChannel('Termicode');

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
				case 'openExternal': {
					const url = msg.url;
					// Validate scheme before opening — only http/https allowed
					if (/^https?:\/\//i.test(url)) {
						vscode.env.openExternal(vscode.Uri.parse(url));
					}
					break;
				}
				case 'resolveTerminalTag': {
					this.log.appendLine(`[resolveTerminalTag] cached output length: ${this.lastTerminalOutput.length}`);
					this.log.appendLine(`[resolveTerminalTag] open terminals: ${vscode.window.terminals.length}, active: ${vscode.window.activeTerminal?.name ?? 'none'}`);
					this.log.appendLine(`[resolveTerminalTag] active terminal shell integration: ${vscode.window.activeTerminal?.shellIntegration ? 'yes' : 'no'}`);
					if (!this.lastTerminalOutput) {
						// Fallback: capture via clipboard from the active VS Code terminal
						try {
							const prev = await vscode.env.clipboard.readText();
							this.log.appendLine('[resolveTerminalTag] trying copyLastCommandOutput fallback');
							await vscode.commands.executeCommand('workbench.action.terminal.copyLastCommandOutput');
							const captured = (await vscode.env.clipboard.readText()).trim();
							await vscode.env.clipboard.writeText(prev);
							this.log.appendLine(`[resolveTerminalTag] clipboard captured ${captured.length} chars (prev was ${prev.length} chars)`);
							if (captured && captured !== prev.trim()) {
								this.lastTerminalOutput = captured.length > 5000 ? captured.slice(-5000) : captured;
								this.log.appendLine('[resolveTerminalTag] fallback succeeded');
							} else {
								this.log.appendLine('[resolveTerminalTag] clipboard unchanged — fallback got nothing new');
							}
						} catch (err) {
							this.log.appendLine(`[resolveTerminalTag] fallback error: ${err}`);
						}
					}
					if (!this.lastTerminalOutput) {
						this.log.appendLine('[resolveTerminalTag] no output — sending error to webview');
						this.log.show(true);
						webviewView.webview.postMessage({ type: 'terminalTagResolved', error: true });
						vscode.window.showWarningMessage('Termicode: No terminal output captured yet. Run a command in a VS Code terminal first.');
						break;
					}
					const tmpPath = path.join(os.tmpdir(), 'termicode_terminal.txt');
					fs.writeFileSync(tmpPath, this.lastTerminalOutput, 'utf8');
					this.log.appendLine(`[resolveTerminalTag] success — wrote ${this.lastTerminalOutput.length} chars to ${tmpPath}`);
					webviewView.webview.postMessage({ type: 'terminalTagResolved', path: tmpPath });
					break;
				}
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

	setLastTerminalOutput(text: string) { this.lastTerminalOutput = text; }
	logLine(msg: string) { this.log.appendLine(msg); }

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
			.replace('{{WEB_LINKS_ADDON_JS}}', uri('xterm-addon-web-links.js'))
			.replace('{{WEBVIEW_JS}}', uri('webview.js'));
	}
}
