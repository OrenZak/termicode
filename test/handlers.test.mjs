import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { handleKeyEvent, handleTerminalData } = require('../media/handlers.js');

// ── helpers ────────────────────────────────────────────────────────────────

function key(overrides) {
	return {
		type: 'keydown',
		key: '',
		shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
		_prevented: false,
		preventDefault() { this._prevented = true; },
		...overrides,
	};
}

function session(overrides) {
	return { inputBuffer: '', terminalTagPath: null, ...overrides };
}

function spy() {
	const calls = [];
	const fn = (...args) => calls.push(args);
	fn.calls = calls;
	fn.calledWith = (arg) => calls.some(c => JSON.stringify(c[0]) === JSON.stringify(arg));
	fn.callCount = () => calls.length;
	return fn;
}

// ── handleKeyEvent ─────────────────────────────────────────────────────────

describe('Shift+Enter — bracketed paste newline', () => {
	it('sends bracketed paste on keydown when active', () => {
		const post = spy();
		const e = key({ key: 'Enter', shiftKey: true });
		const result = handleKeyEvent(e, true, post);
		assert.equal(result, false);
		assert.ok(e._prevented, 'preventDefault should be called');
		assert.ok(post.calledWith({ type: 'input', data: '\x1b[200~\n\x1b[201~' }));
	});

	it('blocks but does not send on keypress', () => {
		const post = spy();
		const e = key({ key: 'Enter', shiftKey: true, type: 'keypress' });
		assert.equal(handleKeyEvent(e, true, post), false);
		assert.equal(post.callCount(), 0);
	});

	it('does not send when session is not active', () => {
		const post = spy();
		const e = key({ key: 'Enter', shiftKey: true });
		handleKeyEvent(e, false, post);
		assert.equal(post.callCount(), 0);
	});

	it('does not intercept plain Enter', () => {
		const post = spy();
		assert.equal(handleKeyEvent(key({ key: 'Enter' }), true, post), true);
		assert.equal(post.callCount(), 0);
	});
});

describe('Cmd+Z / Ctrl+Z — undo', () => {
	it('sends \\x1f for Cmd+Z', () => {
		const post = spy();
		assert.equal(handleKeyEvent(key({ key: 'z', metaKey: true }), true, post), false);
		assert.ok(post.calledWith({ type: 'input', data: '\x1f' }));
	});

	it('sends \\x1f for Ctrl+Z', () => {
		const post = spy();
		assert.equal(handleKeyEvent(key({ key: 'z', ctrlKey: true }), true, post), false);
		assert.ok(post.calledWith({ type: 'input', data: '\x1f' }));
	});

	it('does not send when not active', () => {
		const post = spy();
		handleKeyEvent(key({ key: 'z', metaKey: true }), false, post);
		assert.equal(post.callCount(), 0);
	});

	it('ignores keyup events', () => {
		const post = spy();
		assert.equal(handleKeyEvent(key({ key: 'z', metaKey: true, type: 'keyup' }), true, post), true);
	});
});

describe('Cmd+Shift+Z / Ctrl+Shift+Z — redo', () => {
	it('sends \\x1b\\x1f for Cmd+Shift+Z', () => {
		const post = spy();
		assert.equal(handleKeyEvent(key({ key: 'z', metaKey: true, shiftKey: true }), true, post), false);
		assert.ok(post.calledWith({ type: 'input', data: '\x1b\x1f' }));
	});

	it('sends \\x1b\\x1f for Ctrl+Shift+Z', () => {
		const post = spy();
		assert.equal(handleKeyEvent(key({ key: 'z', ctrlKey: true, shiftKey: true }), true, post), false);
		assert.ok(post.calledWith({ type: 'input', data: '\x1b\x1f' }));
	});
});

describe('Ctrl+Y — redo (Windows)', () => {
	it('sends \\x1b\\x1f for Ctrl+Y', () => {
		const post = spy();
		assert.equal(handleKeyEvent(key({ key: 'y', ctrlKey: true }), true, post), false);
		assert.ok(post.calledWith({ type: 'input', data: '\x1b\x1f' }));
	});

	it('does not intercept Ctrl+Shift+Y', () => {
		assert.equal(handleKeyEvent(key({ key: 'y', ctrlKey: true, shiftKey: true }), true, spy()), true);
	});

	it('does not intercept Cmd+Y', () => {
		assert.equal(handleKeyEvent(key({ key: 'y', metaKey: true }), true, spy()), true);
	});
});

describe('Cmd+L / Ctrl+L — termicode.cmdL', () => {
	it('posts command for Cmd+L', () => {
		const post = spy();
		assert.equal(handleKeyEvent(key({ key: 'l', metaKey: true }), true, post), false);
		assert.ok(post.calledWith({ type: 'command', command: 'termicode.cmdL' }));
	});

	it('posts command for Ctrl+L', () => {
		const post = spy();
		assert.equal(handleKeyEvent(key({ key: 'l', ctrlKey: true }), true, post), false);
		assert.ok(post.calledWith({ type: 'command', command: 'termicode.cmdL' }));
	});

	it('does not intercept Cmd+Shift+L', () => {
		assert.equal(handleKeyEvent(key({ key: 'l', metaKey: true, shiftKey: true }), true, spy()), true);
	});

	it('posts command even when session is not active', () => {
		const post = spy();
		handleKeyEvent(key({ key: 'l', metaKey: true }), false, post);
		assert.ok(post.calledWith({ type: 'command', command: 'termicode.cmdL' }));
	});
});

describe('Unrelated keys — pass through', () => {
	it('returns true for regular character keys', () => {
		assert.equal(handleKeyEvent(key({ key: 'a' }), true, spy()), true);
	});

	it('returns true for arrow keys', () => {
		assert.equal(handleKeyEvent(key({ key: 'ArrowUp' }), true, spy()), true);
	});
});

// ── handleTerminalData ─────────────────────────────────────────────────────

describe('handleTerminalData — input buffer tracking', () => {
	it('appends printable characters to inputBuffer', () => {
		const s = session();
		handleTerminalData('h', s, spy());
		handleTerminalData('i', s, spy());
		assert.equal(s.inputBuffer, 'hi');
	});

	it('removes last char on backspace', () => {
		const s = session({ inputBuffer: 'hello' });
		handleTerminalData('\x7f', s, spy());
		assert.equal(s.inputBuffer, 'hell');
	});

	it('clears buffer on Enter', () => {
		const s = session({ inputBuffer: 'hello' });
		handleTerminalData('\r', s, spy());
		assert.equal(s.inputBuffer, '');
	});

	it('ignores control chars (< 32) other than backspace and CR', () => {
		const s = session({ inputBuffer: 'abc' });
		handleTerminalData('\x01', s, spy());
		assert.equal(s.inputBuffer, 'abc');
	});

	it('does not consume regular characters', () => {
		assert.equal(handleTerminalData('a', session(), spy()), false);
	});
});

describe('handleTerminalData — @terminal tag detection', () => {
	it('posts resolveTerminalTag when @terminal<space> is typed', () => {
		const post = spy();
		const s = session();
		for (const ch of '@terminal ') handleTerminalData(ch, s, post);
		assert.ok(post.calledWith({ type: 'resolveTerminalTag' }));
	});

	it('does not trigger without trailing space', () => {
		const post = spy();
		const s = session();
		for (const ch of '@terminal') handleTerminalData(ch, s, post);
		assert.equal(post.callCount(), 0);
	});

	it('does not consume the space — returns false', () => {
		const s = session({ inputBuffer: '@terminal' });
		assert.equal(handleTerminalData(' ', s, spy()), false);
	});
});

describe('handleTerminalData — @terminal replacement on Enter', () => {
	it('replaces @terminal with file path on Enter and returns true', () => {
		const post = spy();
		const s = session({
			inputBuffer: '@terminal what happened?',
			terminalTagPath: '/tmp/termicode_terminal.txt',
		});
		const consumed = handleTerminalData('\r', s, post);
		assert.equal(consumed, true);
		assert.equal(post.callCount(), 1);
		const sent = post.calls[0][0];
		assert.equal(sent.type, 'input');
		const expected = '\x7f'.repeat('@terminal what happened?'.length)
			+ '@/tmp/termicode_terminal.txt what happened?\r';
		assert.equal(sent.data, expected);
	});

	it('clears terminalTagPath and inputBuffer after replacement', () => {
		const s = session({ inputBuffer: '@terminal fix this', terminalTagPath: '/tmp/tc.txt' });
		handleTerminalData('\r', s, spy());
		assert.equal(s.terminalTagPath, null);
		assert.equal(s.inputBuffer, '');
	});

	it('does not replace when inputBuffer has no @terminal', () => {
		const post = spy();
		const s = session({ inputBuffer: 'what happened?', terminalTagPath: '/tmp/tc.txt' });
		assert.equal(handleTerminalData('\r', s, post), false);
		assert.equal(post.callCount(), 0);
	});

	it('does not replace when terminalTagPath is null', () => {
		const s = session({ inputBuffer: '@terminal fix this', terminalTagPath: null });
		assert.equal(handleTerminalData('\r', s, spy()), false);
	});
});
