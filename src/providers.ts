import * as os from 'os';
import * as path from 'path';

export type ProviderId = 'claude' | 'codex' | 'cursor' | 'gemini';
export type ProviderAction = 'clear' | 'compact' | 'history';

export interface ProviderDefinition {
	id: ProviderId;
	label: string;
	shortLabel: string;
	executableName: string;
	settingKey: string;
	candidates: string[];
	startupLabel: string;
	actionCommands: Partial<Record<ProviderAction, string>>;
	supportsPersistentResume: boolean;
	installCommand: string;
	docsUrl: string;
}

const home = os.homedir();

export const PROVIDERS: ProviderDefinition[] = [
	{
		id: 'claude',
		label: 'Claude Code',
		shortLabel: 'Claude',
		executableName: 'claude',
		settingKey: 'claudePath',
		candidates: [
			path.join(home, '.local', 'bin', 'claude'),
			path.join(home, '.npm-global', 'bin', 'claude'),
			'/usr/local/bin/claude',
			'/opt/homebrew/bin/claude',
		],
		startupLabel: 'Claude Code',
		actionCommands: {
			clear: '/clear\r',
			compact: '/compact\r',
			history: '/resume\r',
		},
		supportsPersistentResume: true,
		installCommand: 'npm install -g @anthropic-ai/claude-code',
		docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/quickstart',
	},
	{
		id: 'codex',
		label: 'OpenAI Codex',
		shortLabel: 'Codex',
		executableName: 'codex',
		settingKey: 'codexPath',
		candidates: [
			path.join(home, '.local', 'bin', 'codex'),
			path.join(home, '.npm-global', 'bin', 'codex'),
			'/usr/local/bin/codex',
			'/opt/homebrew/bin/codex',
		],
		startupLabel: 'OpenAI Codex',
		actionCommands: {
			clear: '/clear\r',
			compact: '/compact\r',
		},
		supportsPersistentResume: true,
		installCommand: 'npm install -g @openai/codex',
		docsUrl: 'https://github.com/openai/codex',
	},
	{
		id: 'cursor',
		label: 'Cursor Agent',
		shortLabel: 'Cursor',
		executableName: 'cursor-agent',
		settingKey: 'cursorAgentPath',
		candidates: [
			path.join(home, '.cursor', 'bin', 'cursor-agent'),
			path.join(home, '.local', 'bin', 'cursor-agent'),
			path.join(home, '.npm-global', 'bin', 'cursor-agent'),
			'/usr/local/bin/cursor-agent',
			'/opt/homebrew/bin/cursor-agent',
		],
		startupLabel: 'Cursor Agent',
		actionCommands: {
			compact: '/compress\r',
		},
		supportsPersistentResume: true,
		installCommand: 'curl https://cursor.com/install -fsS | bash',
		docsUrl: 'https://docs.cursor.com/en/cli/installation',
	},
	{
		id: 'gemini',
		label: 'Gemini CLI',
		shortLabel: 'Gemini',
		executableName: 'gemini',
		settingKey: 'geminiPath',
		candidates: [
			path.join(home, '.local', 'bin', 'gemini'),
			path.join(home, '.npm-global', 'bin', 'gemini'),
			'/usr/local/bin/gemini',
			'/opt/homebrew/bin/gemini',
		],
		startupLabel: 'Gemini CLI',
		actionCommands: {
			compact: '/compress\r',
		},
		supportsPersistentResume: false,
		installCommand: 'npm install -g @google/gemini-cli',
		docsUrl: 'https://google-gemini.github.io/gemini-cli/docs/get-started/',
	},
];

const providerMap = new Map<ProviderId, ProviderDefinition>(
	PROVIDERS.map((provider) => [provider.id, provider])
);

export function isProviderId(value: string | undefined): value is ProviderId {
	return value === 'claude' || value === 'codex' || value === 'cursor' || value === 'gemini';
}

export function getProvider(providerId: ProviderId): ProviderDefinition {
	return providerMap.get(providerId) ?? providerMap.get('claude')!;
}

export function listProviders(): ProviderDefinition[] {
	return PROVIDERS.slice();
}

export function getProviderActionCommand(
	providerId: ProviderId,
	action: ProviderAction,
): string | undefined {
	return getProvider(providerId).actionCommands[action];
}

export function buildProviderRestoreArgs(
	providerId: ProviderId,
	resumeToken?: string,
): string[] {
	switch (providerId) {
		case 'claude':
			return resumeToken ? ['--resume', resumeToken] : ['--continue'];
		case 'codex':
			return resumeToken ? ['resume', resumeToken] : [];
		case 'cursor':
			return resumeToken ? [`--resume=${resumeToken}`] : [];
		case 'gemini':
			return [];
	}
}

export function buildProviderNewSessionArgs(
	providerId: ProviderId,
	resumeToken?: string,
): string[] {
	switch (providerId) {
		case 'claude':
			return resumeToken ? ['--session-id', resumeToken] : [];
		case 'codex':
		case 'cursor':
		case 'gemini':
			return [];
	}
}

export function extractProviderResumeToken(
	providerId: ProviderId,
	plainText: string,
): string | undefined {
	const patterns: RegExp[] = [];

	if (providerId === 'codex') {
		patterns.push(
			/\bcodex\s+resume\s+([0-9a-f-]{8,})\b/i,
			/\bresume(?:\s+session)?[:\s]+([0-9a-f-]{8,})\b/i,
		);
	}

	if (providerId === 'cursor') {
		patterns.push(
			/--resume(?:=|\s+)"?([a-z0-9-]{8,})"?/i,
			/\bchat(?:\s+id)?[:\s]+([a-z0-9-]{8,})\b/i,
		);
	}

	for (const pattern of patterns) {
		const match = plainText.match(pattern);
		if (match?.[1]) {
			return match[1];
		}
	}

	return undefined;
}
