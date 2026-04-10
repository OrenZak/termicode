import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { stripAnsi, parseModelName } from './utils';
import type { Session } from './sessionManager';

export class BridgeManager {
	constructor(
		private context: vscode.ExtensionContext,
		private postMessage: (msg: any) => void,
	) { }

	resolveClaudePath(): string {
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

	startBridge(session: Session, extraArgs: string[] = []): void {
		const claudePath = this.resolveClaudePath();
		const bridgePath = path.join(this.context.extensionPath, 'media', 'pty_bridge.py');
		const shortCwd = session.cwd.replace(os.homedir(), '~');

		this.postMessage({ type: 'write', id: session.id, data: `\x1b[90mStarting Claude Code in ${session.cwd}...\x1b[0m\r\n` });
		this.postMessage({ type: 'sessionStarted', id: session.id, cwd: shortCwd });

		const cols = String(session.cols ?? 120);
		const rows = String(session.rows ?? 40);
		session.bridge = cp.spawn('python3', [bridgePath, claudePath, cols, rows, ...extraArgs], {
			cwd: session.cwd,
			env: { ...process.env },
		});

		session.bridge.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8');

			// If --continue/--resume fails, restart as a fresh session
			const plain = stripAnsi(text);
			const resumeFailed =
				(extraArgs.includes('--continue') && plain.includes('No conversation found to continue')) ||
				(extraArgs.includes('--resume') && plain.includes('No conversation found'));
			if (resumeFailed) {
				session.bridge?.kill();
				setTimeout(() => {
					session.bridge = undefined;
					session.startupBuffer = '';
					session.modelParsed = false;
					session.responseBuffer = '';
					this.postMessage({ type: 'resetTab', id: session.id });
					this.startBridge(session, extraArgs.filter(a => a !== '--continue' && a !== '--resume' && a !== session.claudeSessionId));
				}, 100);
				return;
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
				this.postMessage({ type: 'write', id: session.id, data: `\x1b[33mMake sure "claude" is installed or set termicode.claudePath.\x1b[0m\r\n` });
			}
			session.bridge = undefined;
		});

		session.bridge.on('exit', (code) => {
			session.bridge = undefined;
			this.postMessage({ type: 'sessionEnded', id: session.id });
			this.postMessage({ type: 'write', id: session.id, data: `\r\n\x1b[90m[Session ended (code ${code}). Press + to start a new session.]\x1b[0m\r\n` });
		});
	}
}
