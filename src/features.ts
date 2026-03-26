import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { stripAnsi } from './utils';

export function looksLikePlan(responseBuffer: string): boolean {
	const plain = stripAnsi(responseBuffer);
	if (plain.length < 200) { return false; }
	const hasNumberedSteps = (plain.match(/^\s*\d+[.)]\s+\S/mg) || []).length >= 2;
	const hasPlanKeyword = /\b(here'?s?\s+(my\s+)?plan|i\s+(will|'?ll)\s+|steps?\s+to\s+)/i.test(plain);
	return hasNumberedSteps || hasPlanKeyword;
}

export function writePlanMd(responseBuffer: string, sessionId: string): vscode.Uri | null {
	const plain = stripAnsi(responseBuffer)
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.trim();
	if (!plain) { return null; }
	const mdPath = path.join(os.tmpdir(), `termicode-plan-${sessionId}.md`);
	fs.writeFileSync(mdPath, plain, 'utf8');
	return vscode.Uri.file(mdPath);
}

export async function openPlanPreview(responseBuffer: string, sessionId: string): Promise<void> {
	const uri = writePlanMd(responseBuffer, sessionId);
	if (uri) { await vscode.commands.executeCommand('markdown.showPreview', uri); }
}

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

export async function resolveDroppedImage(name: string, inject: (text: string) => void): Promise<void> {
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
