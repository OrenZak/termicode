import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';

const SETUP_VERSION_KEY = 'termicode.mcpAuthSetupVersion';
const HOOK_MARKER = 'mcp-auth-check.sh';

/**
 * Called on extension activation. Copies the bundled mcp-auth-check.sh to
 * ~/.claude/scripts/, wires the SessionStart hook in ~/.claude/settings.json,
 * and installs the launchd agent (macOS) for twice-daily checks.
 * Idempotent: only re-runs when the extension version changes.
 */
export async function setupMcpAuthCheck(context: vscode.ExtensionContext): Promise<void> {
	// Always run — resets on reboot so must re-apply every activation
	if (process.platform === 'darwin') { ensureNodeInMacOSPath(); }

	const version = context.extension.packageJSON.version as string;
	if (context.globalState.get<string>(SETUP_VERSION_KEY) === version) { return; }

	try {
		const scriptPath = installScript(context);
		mergeHook(scriptPath);
		if (process.platform === 'darwin') {
			installLaunchd(scriptPath);
		}
		await context.globalState.update(SETUP_VERSION_KEY, version);
	} catch (err) {
		// Non-fatal: don't break extension activation if setup fails
		console.error('Termicode: MCP auth check setup failed:', err);
	}
}

function installScript(context: vscode.ExtensionContext): string {
	const src = path.join(context.extensionPath, 'scripts', 'mcp-auth-check.sh');
	const destDir = path.join(os.homedir(), '.claude', 'scripts');
	const dest = path.join(destDir, 'mcp-auth-check.sh');

	fs.mkdirSync(destDir, { recursive: true });
	fs.copyFileSync(src, dest);
	fs.chmodSync(dest, 0o755);
	return dest;
}

function mergeHook(scriptPath: string): void {
	const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
	let settings: any = {};

	if (fs.existsSync(settingsPath)) {
		try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
		catch { settings = {}; }
	}

	if (!settings.hooks) { settings.hooks = {}; }
	if (!Array.isArray(settings.hooks.SessionStart)) { settings.hooks.SessionStart = []; }

	// Remove any existing termicode mcp-auth entry to avoid duplicates
	settings.hooks.SessionStart = (settings.hooks.SessionStart as any[]).filter(
		(entry: any) => !entry.hooks?.some((h: any) => (h.command ?? '').includes(HOOK_MARKER))
	);

	settings.hooks.SessionStart.push({
		hooks: [{
			type: 'command',
			command: `bash "${scriptPath}" --mode=session-start`,
			timeout: 30,
		}],
	});

	const tmp = settingsPath + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
	fs.renameSync(tmp, settingsPath);
}

function ensureNodeInMacOSPath(): void {
	try {
		// Resolve node binary dir by sourcing nvm in a bash subshell
		const nodeBin = cp.execSync(
			'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; dirname "$(which node)"',
			{ shell: '/bin/bash', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
		).trim();

		if (!nodeBin || !fs.existsSync(nodeBin)) { return; }

		// Check the current macOS GUI environment PATH
		const currentPath = cp.execSync('launchctl getenv PATH', {
			encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
		}).trim();

		if (currentPath.includes(nodeBin)) { return; }

		const newPath = `${nodeBin}:${currentPath || '/usr/local/bin:/usr/bin:/bin'}`;
		cp.execSync(`launchctl setenv PATH "${newPath}"`, { stdio: 'ignore' });
	} catch { /* non-fatal */ }
}

function installLaunchd(scriptPath: string): void {
	const logsDir = path.join(os.homedir(), '.claude', 'logs');
	const plistPath = path.join(
		os.homedir(), 'Library', 'LaunchAgents', 'com.claudecode.mcp-auth-check.plist'
	);

	fs.mkdirSync(logsDir, { recursive: true });

	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.claudecode.mcp-auth-check</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/bash</string>
\t\t<string>${scriptPath}</string>
\t\t<string>--mode=cron</string>
\t</array>
\t<key>StartCalendarInterval</key>
\t<array>
\t\t<dict>
\t\t\t<key>Hour</key><integer>9</integer>
\t\t\t<key>Minute</key><integer>0</integer>
\t\t</dict>
\t\t<dict>
\t\t\t<key>Hour</key><integer>14</integer>
\t\t\t<key>Minute</key><integer>0</integer>
\t\t</dict>
\t</array>
\t<key>StandardOutPath</key>
\t<string>${path.join(logsDir, 'mcp-auth-launchd.log')}</string>
\t<key>StandardErrorPath</key>
\t<string>${path.join(logsDir, 'mcp-auth-launchd-error.log')}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
\t\t<key>HOME</key>
\t\t<string>${os.homedir()}</string>
\t</dict>
</dict>
</plist>`;

	// Unload previous version before overwriting
	try {
		cp.execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' });
	} catch { /* not loaded yet, ignore */ }

	fs.writeFileSync(plistPath, plist);

	try {
		cp.execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
	} catch (err) {
		console.error('Termicode: Failed to load launchd agent:', err);
	}
}
