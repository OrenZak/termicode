/* Termicode webview – multi-session terminal panel */
(function () {
	'use strict';

	var vscode = acquireVsCodeApi();

	// ── STATE ──────────────────────────────────────────────────────────────
	// sessions[id] = { term, fitAddon, el, outputBuffer, pendingApply, codeBlockTimer }
	var sessions = {};
	var activeId = null;

	// ── THEME ──────────────────────────────────────────────────────────────
	function termFontFamily() {
		var s = getComputedStyle(document.body);
		var v = function (name) { return s.getPropertyValue(name).trim(); };
		return v('--vscode-terminal-fontFamily')
			|| v('--vscode-editor-font-family')
			|| '"Cascadia Code", "Cascadia Mono", Menlo, monospace';
	}

	function termTheme() {
		var s = getComputedStyle(document.body);
		var c = function (v) { return s.getPropertyValue(v).trim() || undefined; };
		return {
			background:    c('--vscode-terminal-background')       || '#1e1e1e',
			foreground:    c('--vscode-terminal-foreground')       || '#d4d4d4',
			cursor:        c('--vscode-terminalCursor-foreground') || '#aeafad',
			black:'#1e1e1e', red:'#f44747',  green:'#6a9955',  yellow:'#d7ba7d',
			blue:'#569cd6',  magenta:'#c586c0', cyan:'#9cdcfe', white:'#d4d4d4',
			brightBlack:'#808080', brightRed:'#f44747', brightGreen:'#b5cea8',
			brightYellow:'#dcdcaa', brightBlue:'#9cdcfe', brightMagenta:'#c586c0',
			brightCyan:'#4ec9b0',  brightWhite:'#ffffff',
		};
	}

	// ── SESSION LIFECYCLE ──────────────────────────────────────────────────
	function createSession(id, label, isWorktree) {
		// DOM element
		var el = document.createElement('div');
		el.className = 'term-instance';
		el.id = 'term-' + id;
		document.getElementById('terminal-wrap').appendChild(el);

		// xterm
		var term = new Terminal({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: termFontFamily(),
			theme: termTheme(),
			convertEol: true,
			scrollback: 5000,
		});
		var fitAddon = new FitAddon.FitAddon();
		term.loadAddon(fitAddon);

		// WebLinksAddon — makes URLs clickable; handler validated in extension host
		var webLinksAddon = new WebLinksAddon.WebLinksAddon(function (e, url) {
			vscode.postMessage({ type: 'openExternal', url: url });
		});
		term.loadAddon(webLinksAddon);

		term.open(el);
		fitAddon.fit();

		term.attachCustomKeyEventHandler(function (e) {
			if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
				e.preventDefault();
				if (e.type === 'keydown' && id === activeId) {
					vscode.postMessage({ type: 'input', data: '\x1b[200~\n\x1b[201~' });
				}
				return false;
			}
			// Cmd+L (Mac) / Ctrl+L (Win/Linux): forward to VS Code instead of sending \x0c to Claude.
			if (e.type === 'keydown' && e.key === 'l' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
				e.preventDefault();
				vscode.postMessage({ type: 'command', command: 'termicode.cmdL' });
				return false;
			}
			return true;
		});

		term.onData(function (data) {
			if (id !== activeId) { return; }

			if (data === '\r') {
				session.inputBuffer = '';
			} else if (data === '\x7f') {
				session.inputBuffer = session.inputBuffer.slice(0, -1);
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				session.inputBuffer += data;
				if (session.inputBuffer.endsWith('@terminal ')) {
					session.inputBuffer = session.inputBuffer.slice(0, -('@terminal '.length));
					vscode.postMessage({ type: 'resolveTerminalTag' });
					return;
				}
			}

			vscode.postMessage({ type: 'input', data: data });
		});

		var session = {
			id: id,
			label: label,
			term: term,
			fitAddon: fitAddon,
			el: el,
			outputBuffer: '',
			inputBuffer: '',
			pendingApply: null,
			codeBlockTimer: null,
		};
		sessions[id] = session;

		// Add tab button
		addTab(id, label, isWorktree);

		return session;
	}

	// ── TAB BAR ────────────────────────────────────────────────────────────
	function addTab(id, label, isWorktree) {
		var tabBar = document.getElementById('tab-bar');
		var newTabBtn = document.getElementById('btn-new-tab');

		var tab = document.createElement('button');
		tab.className = 'session-tab' + (isWorktree ? ' worktree-tab' : '');
		tab.dataset.id = id;

		var dot = document.createElement('span');
		dot.className = 'tab-dot';

		var lbl = document.createElement('span');
		lbl.className = 'tab-label';
		lbl.textContent = (isWorktree ? '⎇ ' : '') + label;

		var cls = document.createElement('button');
		cls.className = 'tab-close';
		cls.textContent = '×';
		cls.title = 'Close session';
		cls.addEventListener('click', function (e) {
			e.stopPropagation();
			vscode.postMessage({ type: 'closeTab', id: id });
			destroySession(id);
		});

		tab.appendChild(dot);
		tab.appendChild(lbl);
		tab.appendChild(cls);
		tab.addEventListener('click', function () { activateSession(id); });
		tab.addEventListener('contextmenu', function (e) {
			e.preventDefault();
			startRename(id);
		});

		tabBar.insertBefore(tab, newTabBtn);
		activateSession(id);
	}

	function startRename(id) {
		var tab = document.querySelector('.session-tab[data-id="' + id + '"]');
		if (!tab || tab.querySelector('.tab-rename-input')) { return; }
		var lbl = tab.querySelector('.tab-label');
		if (!lbl) { return; }

		var isWorktree = tab.classList.contains('worktree-tab');
		var current = lbl.textContent.replace(/^⎇\s*/, '');

		var input = document.createElement('input');
		input.type = 'text';
		input.className = 'tab-rename-input';
		input.value = current;
		lbl.replaceWith(input);
		input.focus();
		input.select();

		var committed = false;
		function confirm() {
			var newLabel = input.value.trim() || current;
			var newLbl = document.createElement('span');
			newLbl.className = 'tab-label';
			newLbl.textContent = (isWorktree ? '⎇ ' : '') + newLabel;
			input.replaceWith(newLbl);
			vscode.postMessage({ type: 'renameTab', id: id, label: newLabel });
		}
		function cancel() {
			var newLbl = document.createElement('span');
			newLbl.className = 'tab-label';
			newLbl.textContent = (isWorktree ? '⎇ ' : '') + current;
			input.replaceWith(newLbl);
		}
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter')  { e.preventDefault(); committed = true; confirm(); }
			if (e.key === 'Escape') { e.preventDefault(); committed = true; cancel(); }
		});
		input.addEventListener('blur', function () {
			if (!committed) { committed = true; confirm(); }
		});
	}

	function renameTab(id, label) {
		var tab = document.querySelector('.session-tab[data-id="' + id + '"]');
		if (!tab) { return; }
		var isWorktree = tab.classList.contains('worktree-tab');
		var lbl = tab.querySelector('.tab-label');
		if (lbl) { lbl.textContent = (isWorktree ? '⎇ ' : '') + label; }
	}

	function activateSession(id) {
		if (!sessions[id]) { return; }

		// deactivate current
		if (activeId && sessions[activeId]) {
			sessions[activeId].el.classList.remove('active');
			var oldTab = document.querySelector('.session-tab[data-id="' + activeId + '"]');
			if (oldTab) { oldTab.classList.remove('active'); }
		}

		activeId = id;
		var session = sessions[id];

		// show terminal
		session.el.classList.add('active');

		// update tab highlight
		var tab = document.querySelector('.session-tab[data-id="' + id + '"]');
		if (tab) { tab.classList.add('active'); }

		// refit after becoming visible, then sync PTY dimensions
		setTimeout(function () {
			session.fitAddon.fit();
			vscode.postMessage({ type: 'resize', cols: session.term.cols, rows: session.term.rows });
		}, 30);

		// tell extension which session is active
		vscode.postMessage({ type: 'switchTab', id: id });
	}

	function destroySession(id) {
		var session = sessions[id];
		if (!session) { return; }

		session.term.dispose();
		session.el.remove();

		var tab = document.querySelector('.session-tab[data-id="' + id + '"]');
		if (tab) { tab.remove(); }

		delete sessions[id];

		// switch to another session if this was active
		if (activeId === id) {
			activeId = null;
			var ids = Object.keys(sessions);
			if (ids.length > 0) {
				activateSession(ids[ids.length - 1]);
			} else {
				setStatus(false, '', '');
			}
		}
	}

	// ── RESIZE OBSERVER ────────────────────────────────────────────────────
	new ResizeObserver(function () {
		if (activeId && sessions[activeId]) {
			sessions[activeId].fitAddon.fit();
			var t = sessions[activeId].term;
			vscode.postMessage({ type: 'resize', cols: t.cols, rows: t.rows });
		}
	}).observe(document.getElementById('terminal-wrap'));

	// ── MESSAGE HANDLER ────────────────────────────────────────────────────
	window.addEventListener('message', function (event) {
		var msg = event.data;
		var session = msg.id ? sessions[msg.id] : null;

		switch (msg.type) {

			case 'newTab':
				createSession(msg.id, msg.label, msg.isWorktree);
				break;

			case 'worktreeMode':
				document.getElementById('btn-worktree').classList.toggle('active', msg.enabled);
				break;

			case 'activateTab':
				activateSession(msg.id);
				break;

			case 'renameTab':
				renameTab(msg.id, msg.label);
				break;

			case 'focus':
				if (activeId && sessions[activeId]) { sessions[activeId].term.focus(); }
				break;

			case 'resetTab':
				if (session) {
					session.term.reset();
					session.outputBuffer = '';
					session.pendingApply = null;
					hideApplyBar();
				}
				break;

			case 'write':
				if (session) {
					session.term.write(msg.data);
					session.outputBuffer += stripAnsi(msg.data);
					if (session.outputBuffer.length > 40000) {
						session.outputBuffer = session.outputBuffer.slice(-20000);
					}
					if (msg.id === activeId) {
						clearTimeout(session.codeBlockTimer);
						session.codeBlockTimer = setTimeout(function () {
							scanForCodeBlock(session);
						}, 1200);
					}
				}
				break;

			case 'sessionStarted':
				if (session) {
					var tab = document.querySelector('.session-tab[data-id="' + msg.id + '"]');
					if (tab) { tab.classList.add('running'); }
				}
				if (msg.id === activeId) {
					setStatus(true, '', msg.cwd || '');
				}
				break;

			case 'version':
				document.getElementById('tab-version').textContent = 'v' + msg.value;
				break;

			case 'mcpAuthWarning':
				var bar = document.getElementById('mcp-warn-bar');
				var txt = document.getElementById('mcp-warn-text');
				if (msg.servers && msg.servers.length > 0) {
					var shown = msg.servers.slice(0, 3).join(', ');
					var extra = msg.servers.length - 3;
					txt.textContent = 'MCP re-auth needed: ' + shown + (extra > 0 ? ' (+' + extra + ' more)' : '');
					bar.dataset.servers = JSON.stringify(msg.servers);
					bar.dataset.logTail = msg.logTail || '';
					bar.classList.add('visible');
				}
				break;


			case 'modelName':
				if (session) {
					var tab2 = document.querySelector('.session-tab[data-id="' + msg.id + '"] .tab-label');
					// optionally update tab label with short model
				}
				if (msg.id === activeId) {
					document.getElementById('model-badge').textContent = msg.name;
					document.getElementById('model-badge').classList.add('visible');
					document.getElementById('status-model').textContent = msg.name;
				}
				break;

			case 'sessionEnded':
				if (session) {
					var tab3 = document.querySelector('.session-tab[data-id="' + msg.id + '"]');
					if (tab3) { tab3.classList.remove('running'); }
				}
				if (msg.id === activeId) {
					document.getElementById('model-badge').classList.remove('visible');
					setStatus(false, '', '');
				}
				break;

			case 'terminalTagResolved':
				if (msg.error) {
					// No output available — forward the space we held back
					vscode.postMessage({ type: 'input', data: ' ' });
				} else {
					// Delete the 9 chars of '@terminal' already in the PTY, then inject the file reference
					var bs = new Array(10).join('\x7f');
					vscode.postMessage({ type: 'input', data: bs + '@' + msg.path + ' ' });
				}
				break;
		}
	});

	// ── STATUS BAR ─────────────────────────────────────────────────────────
	function setStatus(active, model, cwd) {
		var dot   = document.getElementById('status-dot');
		var label = document.getElementById('status-label');
		var sep   = document.getElementById('status-cwd-sep');
		var cwdEl = document.getElementById('status-cwd');
		if (active) {
			dot.classList.add('active');
			label.textContent = 'Active';
		} else {
			dot.classList.remove('active');
			label.textContent = 'No session';
			document.getElementById('status-model').textContent = '';
			document.getElementById('model-badge').classList.remove('visible');
		}
		cwdEl.textContent = cwd || '';
		sep.style.display = cwd ? '' : 'none';
	}

	// ── ANSI / OUTPUT BUFFER ───────────────────────────────────────────────
	function stripAnsi(s) {
		return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
	}

	// ── CODE BLOCK DETECTION ──────────────────────────────────────────────
	function scanForCodeBlock(session) {
		var tick = '\x60\x60\x60';
		var pattern = tick + '([\\w]*)\\n#\\s*([^\\n]+\\.[\\S]+)[^\\n]*\\n([\\s\\S]*?)' + tick;
		var re = new RegExp(pattern, 'g');
		var m, last;
		while ((m = re.exec(session.outputBuffer)) !== null) { last = m; }
		if (!last) { return; }
		var filepath = last[2].split(':')[0].trim();
		var code = last[3];
		if (!filepath || !code) { return; }
		session.pendingApply = { filepath: filepath, code: code };
		if (session.id === activeId) { showApplyBar(filepath); }
	}

	function showApplyBar(filepath) {
		document.getElementById('apply-file').textContent = filepath;
		document.getElementById('apply-bar').classList.add('visible');
	}

	function hideApplyBar() {
		document.getElementById('apply-bar').classList.remove('visible');
	}

	document.getElementById('btn-apply').addEventListener('click', function () {
		var session = activeId ? sessions[activeId] : null;
		if (session && session.pendingApply) {
			vscode.postMessage({ type: 'applyCode', filepath: session.pendingApply.filepath, code: session.pendingApply.code });
			hideApplyBar();
			session.pendingApply = null;
		}
	});

	document.getElementById('btn-apply-diff').addEventListener('click', function () {
		var session = activeId ? sessions[activeId] : null;
		if (session && session.pendingApply) {
			vscode.postMessage({ type: 'applyCode', filepath: session.pendingApply.filepath, code: session.pendingApply.code, diff: true });
			hideApplyBar();
			session.pendingApply = null;
		}
	});

	// ── APPLY BAR ──────────────────────────────────────────────────────────

	// ── EVENT BINDINGS ─────────────────────────────────────────────────────
	document.getElementById('btn-new-tab').addEventListener('click', function () {
		vscode.postMessage({ type: 'command', command: 'termicode.newSession' });
	});

	document.getElementById('mcp-warn-fix').addEventListener('click', function () {
		var bar = document.getElementById('mcp-warn-bar');
		bar.classList.remove('visible');
		var servers = JSON.parse(bar.dataset.servers || '[]');
		var logTail = bar.dataset.logTail || '';
		var prompt = 'The following MCP servers need re-authentication: ' + servers.join(', ') + '.\n' +
			'Please authenticate each one now using the available tools. Start with the ones you have authenticate tools for, then guide me through any remaining ones.\n';
		if (logTail) {
			prompt += '\nError log from the auth check script:\n```\n' + logTail + '\n```\n';
		}
		vscode.postMessage({ type: 'input', data: prompt + '\r' });
	});

	document.getElementById('mcp-warn-dismiss').addEventListener('click', function () {
		document.getElementById('mcp-warn-bar').classList.remove('visible');
	});

	// ── TOOLBAR BUTTONS ────────────────────────────────────────────────────
	var cmdMap = {
		'btn-addFile':  'termicode.addFile',
		'btn-addImage': 'termicode.addImage',
		'btn-clear':    'termicode.clearContext',
		'btn-compact':  'termicode.compactContext',
		'btn-history':  'termicode.history',
		'btn-copy':     'termicode.copyLastResponse',
	};
	Object.keys(cmdMap).forEach(function (id) {
		var el = document.getElementById(id);
		if (el) {
			el.addEventListener('click', function () {
				vscode.postMessage({ type: 'command', command: cmdMap[id] });
			});
		}
	});

	// ── WORKTREE TOGGLE ────────────────────────────────────────────────────
	document.getElementById('btn-worktree').addEventListener('click', function () {
		vscode.postMessage({ type: 'toggleWorktree' });
	});

	// ── IMAGE DRAG & DROP ──────────────────────────────────────────────────
	var termWrap = document.getElementById('terminal-wrap');
	var overlay  = document.getElementById('drag-overlay');
	var dragCounter = 0;

	termWrap.addEventListener('dragenter', function (e) {
		if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) {
			dragCounter++;
			overlay.classList.add('visible');
			e.preventDefault();
		}
	});
	termWrap.addEventListener('dragleave', function () {
		if (--dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('visible'); }
	});
	termWrap.addEventListener('dragover', function (e) { e.preventDefault(); });
	termWrap.addEventListener('drop', function (e) {
		e.preventDefault();
		dragCounter = 0;
		overlay.classList.remove('visible');
		var files = e.dataTransfer && e.dataTransfer.files;
		if (!files || !files[0]) { return; }
		var file = files[0];
		var reader = new FileReader();
		reader.onload = function (ev) {
			var dataUrl = ev.target.result;
			// dataUrl is "data:<mime>;base64,<data>" — strip the prefix
			var base64 = dataUrl.split(',')[1];
			vscode.postMessage({ type: 'dropImage', name: file.name, base64: base64 });
		};
		reader.readAsDataURL(file);
	});

	// ── BOOT ──────────────────────────────────────────────────────────────
	vscode.postMessage({ type: 'ready' });
})();
