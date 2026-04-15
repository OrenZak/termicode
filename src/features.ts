import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { stripAnsi } from './utils';

export async function copyLastResponse(responseBuffer: string): Promise<void> {
	const plain = stripAnsi(responseBuffer).trim();
	if (!plain) {
		vscode.window.showInformationMessage('Termicode: No response to copy yet.');
		return;
	}
	await vscode.env.clipboard.writeText(plain);
	vscode.window.showInformationMessage('Termicode: Last response copied to clipboard.');
}

export async function applyCodeToFile(filepath: string, code: string): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const absPath = root ? path.resolve(root, filepath) : path.resolve(filepath);
	const uri = vscode.Uri.file(absPath);
	const answer = await vscode.window.showInformationMessage(
		`Apply Claude's code to ${path.basename(filepath)}?`,
		{ modal: true }, 'Apply', 'Open Diff'
	);
	if (answer === 'Apply') {
		await vscode.workspace.fs.writeFile(uri, Buffer.from(code, 'utf8'));
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: true });
	} else if (answer === 'Open Diff') {
		let existingUri = uri;
		try { fs.accessSync(absPath); } catch { existingUri = vscode.Uri.parse('untitled:empty'); }
		const proposed = await vscode.workspace.openTextDocument({ content: code });
		await vscode.commands.executeCommand('vscode.diff', existingUri, proposed.uri, `${path.basename(filepath)}: Current ↔ Claude`);
	}
}

export async function resolveDroppedImage(name: string, inject: (text: string) => void, base64?: string, sessionCwd?: string): Promise<void> {
	// If we have the file content, write it to a temp dir inside the session's cwd.
	// This avoids Claude Code's read-permission prompts since the session already
	// has implicit access to its working directory.
	if (base64) {
		const baseDir = sessionCwd ?? os.tmpdir();
		const tmpDir = path.join(baseDir, '.termicode-images');
		fs.mkdirSync(tmpDir, { recursive: true });
		const tmpPath = path.join(tmpDir, name);
		fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
		inject(`${tmpPath} `);
		return;
	}

	// Fallback: search workspace (for files dragged from the explorer)
	const matches = await vscode.workspace.findFiles(`**/${name}`, undefined, 5);
	if (matches.length === 1) {
		inject(`${matches[0].fsPath} `);
	} else if (matches.length > 1) {
		const picked = await vscode.window.showQuickPick(matches.map(u => u.fsPath));
		if (picked) { inject(`${picked} `); }
	} else {
		const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'] } });
		if (uris?.[0]) { inject(`${uris[0].fsPath} `); }
	}
}
