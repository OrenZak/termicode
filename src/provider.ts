import * as vscode from 'vscode';
import * as fs from 'fs';
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
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
			switch (msg.type) {
				case 'ready':
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
				case 'dropImage':
					await resolveDroppedImage((msg as any).name, (text) => this.injectText(text));
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
