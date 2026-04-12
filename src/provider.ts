import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from './sessionManager';
import { BridgeManager } from './bridgeManager';
import { applyCodeToFile, copyLastResponse, resolveDroppedImage } from './features';
import { getNonce } from './utils';
import {
	getProvider,
	getProviderActionCommand,
	isProviderId,
	listProviders,
	type ProviderAction,
	type ProviderId,
} from './providers';

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

export class TermicodeViewProvider implements vscode.WebviewViewProvider {

	private view?: vscode.WebviewView;
	private sessionManager: SessionManager;
	private bridgeManager: BridgeManager;
	private readonly outputChannel: vscode.OutputChannel;

	constructor(private readonly context: vscode.ExtensionContext) {
		const postMessage = (msg: any) => this.view?.webview.postMessage(msg);
		this.outputChannel = vscode.window.createOutputChannel('Termicode');
		this.context.subscriptions.push(this.outputChannel);
		this.bridgeManager = new BridgeManager(
			context,
			postMessage,
			(sessionId, resumeToken) => this.sessionManager.setResumeToken(sessionId, resumeToken),
		);
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

	async newSession(): Promise<boolean> {
		const providerId = this.getDefaultProviderId() ?? await this.pickProvider();
		if (!providerId) { return false; }
		if (!await this.ensureProviderAvailable(providerId)) { return false; }
		await this.sessionManager.newSession(providerId);
		return true;
	}

	async newSessionWithPicker(): Promise<boolean> {
		const providerId = await this.pickProvider();
		if (!providerId) { return false; }
		if (!await this.ensureProviderAvailable(providerId)) { return false; }
		await this.sessionManager.newSession(providerId);
		return true;
	}

	async newSessionWithProvider(providerId: ProviderId): Promise<boolean> {
		if (!await this.ensureProviderAvailable(providerId)) { return false; }
		await this.sessionManager.newSession(providerId);
		return true;
	}

	async chooseDefaultProvider(): Promise<void> {
		const current = this.getConfiguredDefaultProviderRaw();
		const items = [
			{
				label: 'Always Ask',
				description: 'Show the provider picker for every new session',
				value: 'prompt',
			},
			...listProviders().map((provider) => ({
				label: provider.shortLabel,
				description: provider.label,
				detail: `Use ${provider.shortLabel} for the + button and new-session shortcut`,
				value: provider.id,
			})),
		];
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Choose the default provider for new sessions',
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) { return; }

		await vscode.workspace.getConfiguration('termicode').update(
			'defaultProvider',
			picked.value,
			vscode.ConfigurationTarget.Global,
		);

		const label = picked.value === 'prompt' ? 'Always Ask' : getProvider(picked.value as ProviderId).label;
		vscode.window.showInformationMessage(`Termicode: Default provider set to ${label}.`);
	}

	restartSession() { return this.sessionManager.restartSession(); }

	focusTerminal() {
		setTimeout(() => this.view?.webview.postMessage({ type: 'focus' }), 150);
	}

	injectText(text: string) {
		const s = this.sessionManager.activeSession();
		if (!s?.bridge?.stdin) {
			vscode.window.showWarningMessage('Termicode: No active session.');
			return;
		}
		s.bridge.stdin.write(text);
	}

	runProviderAction(action: ProviderAction): void {
		const session = this.sessionManager.activeSession();
		if (!session) {
			vscode.window.showWarningMessage('Termicode: No active session.');
			return;
		}

		const command = getProviderActionCommand(session.providerId, action);
		if (!command) {
			const provider = getProvider(session.providerId);
			vscode.window.showInformationMessage(
				`Termicode: ${provider.label} does not expose a ${action} action in the panel yet.`
			);
			return;
		}

		this.injectText(command);
	}

	getActiveProviderLabel(): string | undefined {
		const session = this.sessionManager.activeSession();
		return session ? getProvider(session.providerId).shortLabel : undefined;
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

	private async pickProvider(): Promise<ProviderId | undefined> {
		const items = listProviders().map((provider) => ({
			label: provider.shortLabel,
			description: provider.label,
			detail: `Run ${provider.executableName} in a dedicated Termicode tab`,
			providerId: provider.id,
		}));
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Choose an AI coding agent for the new session',
			matchOnDescription: true,
			matchOnDetail: true,
		});
		return picked?.providerId;
	}

	private getDefaultProviderId(): ProviderId | undefined {
		const value = this.getConfiguredDefaultProviderRaw();
		return isProviderId(value) ? value : undefined;
	}

	private getConfiguredDefaultProviderRaw(): string {
		return vscode.workspace.getConfiguration('termicode').get<string>('defaultProvider', 'prompt');
	}

	private async ensureProviderAvailable(providerId: ProviderId): Promise<boolean> {
		const provider = getProvider(providerId);
		const resolution = this.bridgeManager.resolveProviderExecutable(providerId);
		if (resolution.commandPath) {
			return true;
		}

		const settingName = `termicode.${provider.settingKey}`;
		const message = resolution.configuredPath && !resolution.configuredPathValid
			? `${provider.label} is configured to use "${resolution.configuredPath}", but that file does not exist. Install ${provider.shortLabel} now?`
			: `${provider.label} is not installed. Install it now before opening the session?`;
		const choice = await vscode.window.showWarningMessage(
			message,
			{ modal: true },
			'Install',
			'Open Settings',
			'Open Docs',
		);

		if (choice === 'Open Settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', settingName);
			return false;
		}

		if (choice === 'Open Docs') {
			await vscode.env.openExternal(vscode.Uri.parse(provider.docsUrl));
			return false;
		}

		if (choice !== 'Install') {
			return false;
		}

		const installed = await this.installProvider(providerId);
		if (!installed) {
			return false;
		}

		const updatedResolution = this.bridgeManager.resolveProviderExecutable(providerId);
		if (!updatedResolution.commandPath) {
			vscode.window.showErrorMessage(
				`Termicode: ${provider.label} still isn't available after install. Check ${settingName} or your PATH.`
			);
			return false;
		}

		return true;
	}

	private async installProvider(providerId: ProviderId): Promise<boolean> {
		const provider = getProvider(providerId);
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		this.outputChannel.clear();
		this.outputChannel.show(true);
		this.outputChannel.appendLine(`Installing ${provider.label}...`);
		this.outputChannel.appendLine(`$ ${provider.installCommand}`);

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Installing ${provider.label}`,
				},
				() => this.runShellCommand(provider.installCommand, cwd),
			);
			vscode.window.showInformationMessage(`Termicode: ${provider.label} installed successfully.`);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.outputChannel.appendLine('');
			this.outputChannel.appendLine(`Install failed: ${message}`);
			const choice = await vscode.window.showErrorMessage(
				`Termicode: Failed to install ${provider.label}. See the Termicode output for details.`,
				'Open Output',
				'Open Docs',
			);
			if (choice === 'Open Output') {
				this.outputChannel.show(true);
			} else if (choice === 'Open Docs') {
				await vscode.env.openExternal(vscode.Uri.parse(provider.docsUrl));
			}
			return false;
		}
	}

	private runShellCommand(command: string, cwd: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = cp.exec(command, {
				cwd,
				env: { ...process.env },
				maxBuffer: 10 * 1024 * 1024,
			});

			child.stdout?.on('data', (chunk: string | Buffer) => {
				this.outputChannel.append(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
			});
			child.stderr?.on('data', (chunk: string | Buffer) => {
				this.outputChannel.append(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
			});

			child.on('error', reject);
			child.on('exit', (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`Command exited with code ${code}`));
				}
			});
		});
	}
}
