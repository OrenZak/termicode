/* Termicode webview – runs inside VS Code's sandboxed webview context */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	// ── xterm setup ────────────────────────────────────────────────────────
	const term = new Terminal({
		cursorBlink: true,
		fontSize: 13,
		fontFamily: 'var(--vscode-editor-font-family, "Cascadia Code", Menlo, monospace)',
		theme: {
			background:      computed('--vscode-terminal-background')      || '#1e1e1e',
			foreground:      computed('--vscode-terminal-foreground')      || '#d4d4d4',
			cursor:          computed('--vscode-terminalCursor-foreground') || '#aeafad',
			black:    '#1e1e1e', red:     '#f44747', green:   '#6a9955', yellow:  '#d7ba7d',
			blue:     '#569cd6', magenta: '#c586c0', cyan:    '#9cdcfe', white:   '#d4d4d4',
			brightBlack:   '#808080', brightRed:    '#f44747', brightGreen:   '#b5cea8',
			brightYellow:  '#dcdcaa', brightBlue:   '#9cdcfe', brightMagenta: '#c586c0',
			brightCyan:    '#4ec9b0', brightWhite:  '#ffffff',
		},
		convertEol: true,
		scrollback: 5000,
	});

	const fitAddon = new FitAddon.FitAddon();
	term.loadAddon(fitAddon);
	term.open(document.getElementById('terminal'));
	fitAddon.fit();

	term.onData(data => vscode.postMessage({ type: 'input', data }));

	new ResizeObserver(() => {
		fitAddon.fit();
		vscode.postMessage({ type: 'resize', cols: term.cols, rows: term.rows });
	}).observe(document.getElementById('terminal'));

	function computed(varName) {
		return getComputedStyle(document.body).getPropertyValue(varName).trim();
	}

	// ── Messages from extension ────────────────────────────────────────────
	let outputBuffer = '';
	let pendingApply = null;
	let codeBlockTimer = null;

	window.addEventListener('message', function (event) {
		var msg = event.data;
		switch (msg.type) {
			case 'write':
				term.write(msg.data);
				outputBuffer += stripAnsi(msg.data);
				if (outputBuffer.length > 40000) { outputBuffer = outputBuffer.slice(-20000); }
				clearTimeout(codeBlockTimer);
				codeBlockTimer = setTimeout(scanForCodeBlock, 1200);
				break;

			case 'reset':
				term.reset();
				outputBuffer = '';
				pendingApply = null;
				hideApplyBar();
				break;

			case 'modelName':
				var badge = document.getElementById('model-badge');
				badge.textContent = msg.name;
				badge.classList.add('visible');
				break;

			case 'sessionEnded':
				document.getElementById('model-badge').classList.remove('visible');
				break;
		}
	});

	// ── ANSI strip ─────────────────────────────────────────────────────────
	function stripAnsi(s) {
		// eslint-disable-next-line no-control-regex
		return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
	}

	// ── Code block detection ───────────────────────────────────────────────
	// Detects fenced code blocks that carry a file reference in their first comment line:
	//   ```lang
	//   # path/to/file.ts:42
	//   <code>
	//   ```
	function scanForCodeBlock() {
		var tick = '\x60\x60\x60'; // three backticks
		var pattern = tick + '([\\w]*)\\n#\\s*([^\\n]+\\.[\\S]+)[^\\n]*\\n([\\s\\S]*?)' + tick;
		var re = new RegExp(pattern, 'g');
		var m, last;
		while ((m = re.exec(outputBuffer)) !== null) { last = m; }
		if (!last) { return; }
		var filepath = last[2].split(':')[0].trim();
		var code = last[3];
		if (!filepath || !code) { return; }
		pendingApply = { filepath: filepath, code: code };
		showApplyBar(filepath);
	}

	function showApplyBar(filepath) {
		document.getElementById('apply-file').textContent = filepath;
		document.getElementById('apply-bar').classList.add('visible');
	}

	function hideApplyBar() {
		document.getElementById('apply-bar').classList.remove('visible');
	}

	document.getElementById('btn-apply').addEventListener('click', function () {
		if (pendingApply) {
			vscode.postMessage({ type: 'applyCode', filepath: pendingApply.filepath, code: pendingApply.code });
			hideApplyBar();
			pendingApply = null;
		}
	});

	document.getElementById('btn-apply-diff').addEventListener('click', function () {
		if (pendingApply) {
			vscode.postMessage({ type: 'applyCode', filepath: pendingApply.filepath, code: pendingApply.code, diff: true });
			hideApplyBar();
			pendingApply = null;
		}
	});

	// ── Toolbar → VS Code command ──────────────────────────────────────────
	var cmdMap = {
		'btn-addFile':  'termicode.addFile',
		'btn-addImage': 'termicode.addImage',
		'btn-clear':    'termicode.clearContext',
		'btn-compact':  'termicode.compactContext',
		'btn-history':  'termicode.history',
		'btn-copy':     'termicode.copyLastResponse',
		'btn-new':      'termicode.newSession',
	};
	Object.keys(cmdMap).forEach(function (id) {
		var el = document.getElementById(id);
		if (el) {
			el.addEventListener('click', function () {
				vscode.postMessage({ type: 'command', command: cmdMap[id] });
			});
		}
	});

	// ── Image drag & drop ──────────────────────────────────────────────────
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
		dragCounter--;
		if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('visible'); }
	});
	termWrap.addEventListener('dragover', function (e) { e.preventDefault(); });
	termWrap.addEventListener('drop', function (e) {
		e.preventDefault();
		dragCounter = 0;
		overlay.classList.remove('visible');
		var files = e.dataTransfer && e.dataTransfer.files;
		if (files && files[0]) {
			vscode.postMessage({ type: 'dropImage', name: files[0].name });
		}
	});

	// ── Boot ──────────────────────────────────────────────────────────────
	vscode.postMessage({ type: 'ready' });
})();
