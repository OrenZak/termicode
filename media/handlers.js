/* Termicode input handlers — UMD so they can be unit-tested in Node.js */
(function (root, factory) {
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = factory();
	} else {
		root.TermicodeHandlers = factory();
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	/**
	 * Handle a keyboard event from xterm's attachCustomKeyEventHandler.
	 * Returns false to suppress xterm's default handling, true to allow it.
	 */
	function handleKeyEvent(e, isActive, postMessage) {
		// Shift+Enter — bracketed paste newline (inserts newline without submitting)
		if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			if (e.type === 'keydown' && isActive) {
				postMessage({ type: 'input', data: '\x1b[200~\n\x1b[201~' });
			}
			return false;
		}
		// Cmd+Z (Mac) / Ctrl+Z (Win/Linux) — undo; +Shift — redo
		if (e.type === 'keydown' && e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.altKey) {
			e.preventDefault();
			if (isActive) {
				postMessage({ type: 'input', data: e.shiftKey ? '\x1b\x1f' : '\x1f' });
			}
			return false;
		}
		// Ctrl+Y — redo (Windows convention)
		if (e.type === 'keydown' && e.key === 'y' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			e.preventDefault();
			if (isActive) {
				postMessage({ type: 'input', data: '\x1b\x1f' });
			}
			return false;
		}
		// Cmd+L (Mac) / Ctrl+L (Win/Linux) — forward to VS Code termicode.cmdL
		if (e.type === 'keydown' && e.key === 'l' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
			e.preventDefault();
			postMessage({ type: 'command', command: 'termicode.cmdL' });
			return false;
		}
		return true;
	}

	/**
	 * Handle a data event from xterm's onData.
	 * Mutates session.inputBuffer and session.terminalTagPath.
	 * Returns true if the caller should NOT forward data to the PTY (already handled),
	 * false if the caller should forward it.
	 */
	function handleTerminalData(data, session, postMessage) {
		if (data === '\r') {
			if (session.terminalTagPath && session.inputBuffer.indexOf('@terminal') !== -1) {
				var replaced = session.inputBuffer.replace('@terminal', '@' + session.terminalTagPath);
				var bs = new Array(session.inputBuffer.length + 1).join('\x7f');
				session.inputBuffer = '';
				session.terminalTagPath = null;
				postMessage({ type: 'input', data: bs + replaced + '\r' });
				return true;
			}
			session.inputBuffer = '';
		} else if (data === '\x7f') {
			session.inputBuffer = session.inputBuffer.slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			session.inputBuffer += data;
			if (session.inputBuffer.endsWith('@terminal ')) {
				postMessage({ type: 'resolveTerminalTag' });
			}
		}
		return false;
	}

	return { handleKeyEvent: handleKeyEvent, handleTerminalData: handleTerminalData };
}));
