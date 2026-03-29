import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { execPromise } from './utils';

export interface Session {
	id: string;
	bridge?: cp.ChildProcess;
	startupBuffer: string;
	modelParsed: boolean;
	responseBuffer: string;
	cwd: string;
	label: string;
	worktreePath?: string;
	planMdPath?: string;
	planShown: boolean;
	planTimer?: ReturnType<typeof setTimeout>;
	cols?: number;
	rows?: number;
}

interface SavedSessionData {
	cwd: string;
	label: string;
	worktreePath?: string;
}

const SAVED_SESSIONS_KEY = 'termicode.savedSessions';

export class SessionManager {
	private sessions = new Map<string, Session>();
	private _activeSessionId: string | null = null;
	private sessionCounter = 0;
	private _worktreeMode = false;
	private termSized = false;
	private pendingStarts: Array<{ session: Session; extraArgs: string[] }> = [];

	constructor(
		private context: vscode.ExtensionContext,
		private postMessage: (msg: any) => void,
		private onSessionReady: (session: Session, extraArgs: string[]) => void,
	) { }

	get worktreeMode() { return this._worktreeMode; }

	activeSession(): Session | undefined {
		return this._activeSessionId ? this.sessions.get(this._activeSessionId) : undefined;
	}

	getSessions(): Map<string, Session> { return this.sessions; }

	setActiveSession(id: string): void {
		if (this.sessions.has(id)) { this._activeSessionId = id; }
	}

	/** Called on 'ready': restores previous tabs or starts a fresh session. */
	async initSessions(): Promise<void> {
		const saved = this.context.workspaceState.get<SavedSessionData[]>(SAVED_SESSIONS_KEY);
		if (saved && saved.length > 0) {
			for (const data of saved) {
				await this.restoreSession(data);
			}
		} else {
			await this.newSession();
		}
		// Fallback: if webview doesn't send a resize within 600ms, start with defaults
		setTimeout(() => this.flushPending(120, 40), 600);
	}

	private async restoreSession(data: SavedSessionData): Promise<void> {
		const id = String(++this.sessionCounter);
		const session: Session = {
			id, cwd: data.cwd, label: data.label,
			startupBuffer: '', modelParsed: false, responseBuffer: '',
			worktreePath: data.worktreePath,
			planShown: false,
		};
		this.sessions.set(id, session);
		this._activeSessionId = id;

		this.postMessage({ type: 'newTab', id, label: data.label, isWorktree: !!data.worktreePath });
		this.queueSession(session, ['--continue']);
	}

	async newSession(): Promise<void> {
		const id = String(++this.sessionCounter);
		const rootCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		let cwd = rootCwd;
		let label = path.basename(cwd);
		let worktreePath: string | undefined;

		if (this._worktreeMode) {
			try {
				await execPromise('git rev-parse --git-dir', rootCwd);
			} catch {
				vscode.window.showErrorMessage('Termicode: Not a git repository — worktree requires git.');
				return;
			}

			const branch = await vscode.window.showInputBox({
				prompt: 'Branch name for new worktree',
				placeHolder: 'feat/my-feature',
				validateInput: v => (v?.trim() ? undefined : 'Branch name is required'),
			});
			if (!branch) { return; }

			const safeBranch = branch.trim().replace(/[^a-zA-Z0-9_\-\/]/g, '-');
			const wtPath = path.join(os.tmpdir(), 'termicode-wt', safeBranch.replace(/\//g, '-'));

			try {
				await execPromise(`git worktree add "${wtPath}" -b "${safeBranch}"`, rootCwd);
			} catch {
				try {
					await execPromise(`git worktree add "${wtPath}" "${safeBranch}"`, rootCwd);
				} catch (err2) {
					vscode.window.showErrorMessage(`Termicode: Failed to create worktree: ${err2}`);
					return;
				}
			}

			cwd = wtPath;
			label = safeBranch.split('/').pop() ?? safeBranch;
			worktreePath = wtPath;
		}

		const session: Session = {
			id, cwd, label,
			startupBuffer: '', modelParsed: false, responseBuffer: '',
			worktreePath,
			planShown: false,
		};
		this.sessions.set(id, session);
		this._activeSessionId = id;

		this.postMessage({ type: 'newTab', id, label, isWorktree: !!worktreePath });
		this.queueSession(session, []);
		this.persistSessions();
	}

	restartSession(): void {
		const s = this.activeSession();
		if (s) {
			s.bridge?.kill();
			s.bridge = undefined;
			s.startupBuffer = '';
			s.modelParsed = false;
			s.responseBuffer = '';
			this.postMessage({ type: 'resetTab', id: s.id });
			setTimeout(() => this.onSessionReady(s, []), 200);
		} else {
			this.newSession();
		}
	}

	async closeSession(id: string): Promise<void> {
		const s = this.sessions.get(id);
		if (!s) { return; }
		s.bridge?.kill();
		this.sessions.delete(id);
		this.persistSessions();

		if (this._activeSessionId === id) {
			const remaining = [...this.sessions.keys()];
			this._activeSessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
			if (this._activeSessionId) {
				this.postMessage({ type: 'activateTab', id: this._activeSessionId });
			}
		}

		if (s.worktreePath) {
			const rootCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
			const answer = await vscode.window.showInformationMessage(
				`Remove worktree "${s.label}"?`,
				{ modal: false },
				'Remove', 'Keep'
			);
			if (answer === 'Remove') {
				try {
					await execPromise(`git worktree remove --force "${s.worktreePath}"`, rootCwd);
				} catch (err) {
					vscode.window.showWarningMessage(`Termicode: Could not remove worktree: ${err}`);
				}
			}
		}
	}

	handleInput(msg: { data: string }): void {
		if (msg.data) {
			const s = this.activeSession();
			if (s) {
				if (msg.data.includes('\r')) {
					s.responseBuffer = '';
					s.planShown = false;
					clearTimeout(s.planTimer);
				}
				s.bridge?.stdin?.write(msg.data);
			}
		}
	}

	private queueSession(session: Session, extraArgs: string[]): void {
		if (this.termSized) {
			this.onSessionReady(session, extraArgs);
		} else {
			this.pendingStarts.push({ session, extraArgs });
		}
	}

	private flushPending(cols: number, rows: number): void {
		if (this.termSized) { return; }
		this.termSized = true;
		const pending = this.pendingStarts.splice(0);
		for (const { session, extraArgs } of pending) {
			session.cols = cols;
			session.rows = rows;
			this.onSessionReady(session, extraArgs);
		}
	}

	handleResize(msg: { cols: number; rows: number }): void {
		if (msg.cols && msg.rows) {
			this.flushPending(msg.cols, msg.rows);
			for (const s of this.sessions.values()) {
				s.bridge?.stdin?.write(`\x1b[8;${msg.rows};${msg.cols}t`);
			}
		}
	}

	renameSession(id: string, label: string): void {
		const s = this.sessions.get(id);
		if (!s) { return; }
		s.label = label;
		this.persistSessions();
	}

	toggleWorktreeMode(): boolean {
		this._worktreeMode = !this._worktreeMode;
		return this._worktreeMode;
	}

	disposeAll(): void {
		for (const s of this.sessions.values()) { s.bridge?.kill(); }
		this.sessions.clear();
		this._activeSessionId = null;
		// intentionally do NOT clear workspaceState — sessions persist across reloads
	}

	private persistSessions(): void {
		const data: SavedSessionData[] = [...this.sessions.values()].map(s => ({
			cwd: s.cwd,
			label: s.label,
			worktreePath: s.worktreePath,
		}));
		this.context.workspaceState.update(SAVED_SESSIONS_KEY, data.length > 0 ? data : undefined);
	}
}
