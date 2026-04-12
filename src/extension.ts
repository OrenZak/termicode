import * as vscode from 'vscode';
import { TermicodeViewProvider } from './provider';

let provider: TermicodeViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	provider = new TermicodeViewProvider(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'termicode.terminal',
			provider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	const reg = (id: string, fn: (...args: any[]) => any) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	const openAndFocus = () => {
		vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
		provider?.focusTerminal();
	};

	reg('termicode.open', () =>
		vscode.commands.executeCommand('workbench.view.extension.termicode-claude'));

	reg('termicode.newSession', async () => {
		const started = await provider?.newSession();
		if (started) {
			openAndFocus();
		}
	});

	reg('termicode.newProviderSession', async () => {
		const started = await provider?.newSessionWithPicker();
		if (started) {
			openAndFocus();
		}
	});

	reg('termicode.setDefaultProvider', () => provider?.chooseDefaultProvider());

	reg('termicode.addFile', (fileUri?: vscode.Uri) => {
		const rel = provider?.getRelativePath(fileUri);
		if (rel) {
			provider?.injectText(`@${rel} `);
			vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
			provider?.focusTerminal();
		} else {
			vscode.window.showWarningMessage('Termicode: No file to add (open a file first).');
		}
	});

	reg('termicode.addSelection', () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			vscode.window.showWarningMessage('Termicode: Select some code first.');
			return;
		}
		const sel = editor.selection;
		const rel = provider?.getRelativePath() ?? editor.document.uri.fsPath;
		const startLine = sel.start.line + 1;
		const endLine = sel.end.line + 1;
		const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
		provider?.injectText(`@${rel}:${lineRange} `);
		vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
		provider?.focusTerminal();
	});

	reg('termicode.askClaude', async () => {
		const editor = vscode.window.activeTextEditor;
		const hasSelection = editor && !editor.selection.isEmpty;
		const providerLabel = provider?.getActiveProviderLabel() ?? 'Agent';
		const question = await vscode.window.showInputBox({
			prompt: hasSelection ? `Ask ${providerLabel} about the selected code` : `Ask ${providerLabel}`,
			placeHolder: 'What does this do? How can I improve it?',
		});
		if (!question) { return; }
		let payload = '';
		if (hasSelection && editor) {
			const text = editor.document.getText(editor.selection);
			const rel = provider?.getRelativePath() ?? editor.document.uri.fsPath;
			const lang = editor.document.languageId;
			const line = editor.selection.start.line + 1;
			payload = `${question}\n\`\`\`${lang}\n# ${rel}:${line}\n${text}\n\`\`\`\r`;
		} else {
			payload = `${question}\r`;
		}
		provider?.injectText(payload);
		vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
	});

	reg('termicode.addImage', async () => {
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
			filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
			title: 'Select image to add to the active agent',
		});
		if (uris?.[0]) {
			provider?.injectText(`${uris[0].fsPath} `);
			vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
		}
	});

	reg('termicode.clearContext',     () => provider?.runProviderAction('clear'));
	reg('termicode.compactContext',   () => provider?.runProviderAction('compact'));
	reg('termicode.history',          () => provider?.runProviderAction('history'));
	reg('termicode.copyLastResponse', () => provider?.copyLastResponse());

	reg('termicode.cmdL', () => {
		const editor = vscode.window.activeTextEditor
			?? vscode.window.visibleTextEditors.find(e => !e.selection.isEmpty);
		if (editor && !editor.selection.isEmpty) {
			const sel = editor.selection;
			const rel = provider?.getRelativePath() ?? editor.document.uri.fsPath;
			const startLine = sel.start.line + 1;
			const endLine = sel.end.line + 1;
			const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
			provider?.injectText(`@${rel}:${lineRange} `);
			vscode.commands.executeCommand('workbench.view.extension.termicode-claude');
		} else {
			vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
		}
	});
}

export function deactivate() { provider = undefined; }
