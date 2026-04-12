import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { stripAnsi, parseModelName } from './utils';
import type { Session } from './sessionManager';
import { extractProviderResumeToken, getProvider, type ProviderId } from './providers';

export interface ProviderExecutableResolution {
	commandPath?: string;
	configuredPath?: string;
	configuredPathValid: boolean;
}

export class BridgeManager {
	constructor(
		private context: vscode.ExtensionContext,
		private postMessage: (msg: any) => void,
		private onResumeToken: (sessionId: string, resumeToken: string) => void,
	) { }

	resolveProviderExecutable(providerId: ProviderId): ProviderExecutableResolution {
		const provider = getProvider(providerId);
		const configured = vscode.workspace.getConfiguration('termicode').get<string>(provider.settingKey, '');
		if (configured) {
			if (this.isExecutablePath(configured)) {
				return {
					commandPath: configured,
					configuredPath: configured,
					configuredPathValid: true,
				};
			}
		}
		for (const p of provider.candidates) {
			if (this.isExecutablePath(p)) {
				return {
					commandPath: p,
					configuredPath: configured || undefined,
					configuredPathValid: !configured || this.isExecutablePath(configured),
				};
			}
		}
		if (this.isExecutableCommand(provider.executableName)) {
			return {
				commandPath: provider.executableName,
				configuredPath: configured || undefined,
				configuredPathValid: !configured || this.isExecutablePath(configured),
			};
		}
		return {
			configuredPath: configured || undefined,
			configuredPathValid: !configured || this.isExecutablePath(configured),
		};
	}

	startBridge(session: Session, extraArgs: string[] = []): void {
		const provider = getProvider(session.providerId);
		const resolution = this.resolveProviderExecutable(session.providerId);
		const commandPath = resolution.commandPath;
		const bridgePath = path.join(this.context.extensionPath, 'media', 'pty_bridge.py');
		const shortCwd = session.cwd.replace(os.homedir(), '~');

		if (!commandPath) {
			const configHint = resolution.configuredPath && !resolution.configuredPathValid
				? `termicode.${provider.settingKey} points to a missing file.`
				: `Install "${provider.executableName}" or set termicode.${provider.settingKey}.`;
			this.postMessage({
				type: 'write',
				id: session.id,
				data: `\r\n\x1b[31m[${provider.label} is not available. ${configHint}]\x1b[0m\r\n`,
			});
			this.postMessage({ type: 'sessionEnded', id: session.id });
			return;
		}

		this.postMessage({
			type: 'write',
			id: session.id,
			data: `\x1b[90mStarting ${provider.startupLabel} in ${session.cwd}...\x1b[0m\r\n`,
		});
		this.postMessage({
			type: 'sessionStarted',
			id: session.id,
			cwd: shortCwd,
			providerLabel: provider.shortLabel,
		});

		const cols = String(session.cols ?? 120);
		const rows = String(session.rows ?? 40);
		session.bridge = cp.spawn('python3', [bridgePath, commandPath, cols, rows, ...extraArgs], {
			cwd: session.cwd,
			env: { ...process.env },
		});

		session.bridge.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8');

			// If --continue/--resume fails, restart as a fresh session
			const plain = stripAnsi(text);
			const resumeFailed =
				session.providerId === 'claude'
				&& (
					(extraArgs.includes('--continue') && plain.includes('No conversation found to continue')) ||
					(extraArgs.includes('--resume') && plain.includes('No conversation found'))
				);
			if (resumeFailed) {
				session.bridge?.kill();
				setTimeout(() => {
					session.bridge = undefined;
					session.startupBuffer = '';
					session.modelParsed = false;
					session.responseBuffer = '';
					this.postMessage({ type: 'resetTab', id: session.id });
					this.startBridge(
						session,
						extraArgs.filter(a => a !== '--continue' && a !== '--resume' && a !== session.resumeToken)
					);
				}, 100);
				return;
			}

			const resumeToken = extractProviderResumeToken(session.providerId, plain);
			if (resumeToken) {
				this.onResumeToken(session.id, resumeToken);
			}

			this.postMessage({ type: 'write', id: session.id, data: text });
			session.responseBuffer += text;

			if (!session.modelParsed) {
				session.startupBuffer += stripAnsi(text);
				if (session.startupBuffer.length > 4096) { session.modelParsed = true; }
				const name = parseModelName(session.startupBuffer);
				if (name) {
					session.modelParsed = true;
					this.postMessage({ type: 'modelName', id: session.id, name });
				}
			}

			});

		session.bridge.stderr?.on('data', (chunk: Buffer) => {
			this.postMessage({ type: 'write', id: session.id, data: chunk.toString('utf8') });
		});

		session.bridge.on('error', (err) => {
			this.postMessage({ type: 'write', id: session.id, data: `\r\n\x1b[31m[Failed to start: ${err.message}]\x1b[0m\r\n` });
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				this.postMessage({
					type: 'write',
					id: session.id,
					data: `\x1b[33mMake sure "${provider.executableName}" is installed or set termicode.${provider.settingKey}.\x1b[0m\r\n`,
				});
			}
			session.bridge = undefined;
		});

		session.bridge.on('exit', (code) => {
			session.bridge = undefined;
			this.postMessage({ type: 'sessionEnded', id: session.id });
			this.postMessage({ type: 'write', id: session.id, data: `\r\n\x1b[90m[Session ended (code ${code}). Press + to start a new session.]\x1b[0m\r\n` });
		});
	}

	private isExecutablePath(candidate: string): boolean {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	private isExecutableCommand(command: string): boolean {
		const result = cp.spawnSync(command, ['--version'], {
			env: { ...process.env },
			stdio: 'ignore',
		});
		if (result.error) {
			return (result.error as NodeJS.ErrnoException).code !== 'ENOENT';
		}
		return true;
	}
}
