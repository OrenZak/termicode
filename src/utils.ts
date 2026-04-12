import * as cp from 'child_process';

export function execPromise(cmd: string, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
			if (err) { reject(new Error(stderr.trim() || err.message)); }
			else { resolve(stdout.trim()); }
		});
	});
}

export function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

export function parseModelName(plain: string): string | null {
	const patterns = [
		/\b(claude-[a-z0-9-]+)/i,
		/\b(gpt-[a-z0-9.-]+(?:-codex[a-z0-9.-]*)?)/i,
		/\b(gemini-[a-z0-9.-]+)/i,
		/\b(claude|cursor|gemini|gpt|codex|composer)[\s-]+([a-z0-9.:-]+[^\s,\r\n]*)/i,
		/\b(sonnet|opus|haiku)[\s-]+([\d.]+[^\s,\r\n]*)/i,
		/model[:\s]+([^\n\r,]{4,50})/i,
	];
	for (const re of patterns) {
		const m = plain.match(re);
		if (m) { return m[0].replace(/\s+/g, ' ').trim().substring(0, 50); }
	}
	return null;
}

export function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
