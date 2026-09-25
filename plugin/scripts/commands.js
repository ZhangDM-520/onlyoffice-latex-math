/*
 * The whole "run this in the editor page" seam for the `$...$` -> ONLYOFFICE
 * math conversion: the command bodies, and `run`, the one way the plugin
 * frame puts one of them into the editor page and gets an answer back.
 *
 * `Asc.plugin.callCommand` stringifies the function it is given and evaluates it
 * inside the *editor page*, so a command function cannot close over anything
 * from this file. `makeCommand` therefore composes a self-contained function
 * body from a shared prelude: the prelude is prepended to each command source
 * and the result is compiled with `new Function`, which keeps every helper
 * inside the stringified function.
 *
 * Every command returns a JSON string, because `Asc.checkReturnCommand` drops
 * complex objects on the way back to the plugin iframe.
 *
 * Callers of this module know only: a command name, a JSON payload, the parsed
 * result and the error taxonomy (`timeout`, `unparsable-command-result`,
 * `clobbered`, `callCommand-unavailable`, `callCommand-threw: …`). Out of the
 * interface: the prelude and its helpers, the `Asc.scope` payload slot, and the
 * backstop timer - all seam internals.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(root);
	} else {
		root.OnlyOfficeLatexMathCommands = factory(root);
	}
})(typeof self !== "undefined" ? self : this, function (root) {
	"use strict";

	// Helpers shared by every editor-page command.
	var PRELUDE = [
		"function resolveApi() {",
		"	if (typeof Api !== 'undefined' && Api && typeof Api.GetDocument === 'function') return Api;",
		"	if (typeof window === 'undefined') return null;",
		"	var ab = window.AscBuilder;",
		"	if (ab && ab.Word && ab.Word.Api && typeof ab.Word.Api.GetDocument === 'function') return ab.Word.Api;",
		"	if (ab && ab.Api && typeof ab.Api.GetDocument === 'function') return ab.Api;",
		"	return null;",
		"}",
		"function logicDocument() {",
		"	var A = resolveApi();",
		"	if (!A) return null;",
		"	var doc = A.GetDocument();",
		"	return doc ? doc.Document : null;",
		"}",
		"function editorApi() {",
		"	if (typeof window === 'undefined') return null;",
		"	if (window.editor && typeof window.editor.asc_ConvertMathDisplayMode === 'function') return window.editor;",
		"	if (window.Asc && window.Asc.editor && typeof window.Asc.editor.asc_ConvertMathDisplayMode === 'function') return window.Asc.editor;",
		"	return null;",
		"}",
		"function scopeOf(scopeArg) {",
		"	if (scopeArg) return scopeArg;",
		"	try { if (typeof scope !== 'undefined' && scope) return scope; } catch (e) {}",
		"	return {};",
		"}",
		"function errorText(e) {",
		"	return (e && e.message) ? String(e.message) : String(e);",
		"}",
		// Places the text caret (a collapsed selection). AddMathEquation() inserts at
		// the caret rather than into a range, so the caret is the only way to say
		// *where* the equation goes. The return value is only used to detect a
		// position that cannot be resolved at all; the caret itself cannot be read
		// back reliably (ApiRange.GetRangeBySelect() does not track it).
		"function moveCursorTo(pos) {",
		"	var A = resolveApi();",
		"	if (!A) return false;",
		"	var doc = A.GetDocument();",
		"	if (!doc || typeof doc.MoveCursorToPos !== 'function') return false;",
		"	try {",
		"		return doc.MoveCursorToPos(pos) !== false;",
		"	} catch (e) {",
		"		return false;",
		"	}",
		"}",
		// Reads back the text of one paragraph by index, for the outcome check that
		// follows an insert.
		"function paragraphText(doc, index) {",
		"	if (typeof index !== 'number' || index < 0) return null;",
		"	try {",
		"		var paragraphs = doc.GetAllParagraphs();",
		"		if (!paragraphs || !paragraphs[index]) return null;",
		"		var t = paragraphs[index].GetText();",
		"		return typeof t === 'string' ? t : null;",
		"	} catch (e) {",
		"		return null;",
		"	}",
		"}",
		"function makeDisplay() {",
		"	var ld = logicDocument();",
		"	if (ld && typeof ld.GetCurrentMath === 'function' && typeof ld.ConvertMathDisplayMode === 'function') {",
		"		var math = null;",
		"		try { math = ld.GetCurrentMath(); } catch (e) { math = null; }",
		"		if (math) { ld.ConvertMathDisplayMode(false); return 'logic-document'; }",
		"	}",
		"	var ed = editorApi();",
		"	if (ed) { ed.asc_ConvertMathDisplayMode(false); return 'editor-api'; }",
		"	return null;",
		"}"
	].join("\n");

	function makeCommand(bodySource) {
		// eslint-disable-next-line no-new-func
		return new Function("return function (scopeArg) {\n" + PRELUDE + "\n" + bodySource + "\n};")();
	}

	// The editor answers callCommand asynchronously; without a backstop a
	// dropped callback would leave the UI waiting forever. `run`'s third
	// argument overrides it, which is how the timeout paths are tested without
	// waiting 30 s.
	var COMMAND_TIMEOUT_MS = 30000;

	// Every command answers with a JSON string. A string that does not parse is
	// named (`unparsable-command-result`) and kept raw for the report; a
	// callback that carries nothing at all, or no callback, is the "no
	// response" this seam has always reported and the taxonomy names `timeout`.
	function parseCommandResult(result) {
		if (typeof result === "string" && result !== "") {
			try {
				return JSON.parse(result);
			} catch (e) {
				return { error: "unparsable-command-result", raw: result };
			}
		}
		if (result && typeof result === "object") {
			return result;
		}
		return null;
	}

	var READ_BODY = [
		"var A = resolveApi();",
		"if (!A) return JSON.stringify({ error: 'api-unavailable' });",
		"var doc = A.GetDocument();",
		"if (!doc) return JSON.stringify({ error: 'no-document' });",
		"var paragraphs = [];",
		"try { paragraphs = doc.GetAllParagraphs() || []; } catch (e) { return JSON.stringify({ error: 'paragraphs-failed: ' + errorText(e) }); }",
		"var out = [];",
		"for (var i = 0; i < paragraphs.length; i++) {",
		"	var range = null;",
		"	try { range = paragraphs[i].GetRange(); } catch (e) { range = null; }",
		"	if (!range) { out.push({ start: null, end: null, text: '' }); continue; }",
		"	var start = null, end = null, text = '';",
		"	try { start = range.GetStartPos(); end = range.GetEndPos(); text = range.GetText(); } catch (e) { /* keep nulls */ }",
		"	if (start === null || end === null || typeof text !== 'string') { out.push({ start: null, end: null, text: '' }); continue; }",
		// Only `start`, `end` and `text` travel back. A range counts positions
		// (interior ones render as empty text, the paragraph mark renders as two
		// characters), so a range span never equals the text length and any
		// comparison between them is meaningless - the write path does not gate on
		// offsets at all (see locate.js collectParagraphs and APPLY_BODY's
		// text-mismatch guard).
		"	out.push({ start: start, end: end, text: text });",
		"}",
		"var selection = null;",
		"try {",
		"	var sel = doc.GetRangeBySelect();",
		"	if (sel) selection = { start: sel.GetStartPos(), end: sel.GetEndPos() };",
		"} catch (e) { selection = null; }",
		"return JSON.stringify({",
		"	paragraphs: out,",
		"	selection: selection,",
		"	hasHistoryApi: typeof doc.CreateNewHistoryPoint === 'function',",
		"	hasDisplayApi: !!editorApi() || !!(logicDocument() && logicDocument().ConvertMathDisplayMode)",
		"});"
	].join("\n");

	var APPLY_BODY = [
		"var S = scopeOf(scopeArg);",
		"var operations = S.operations || [];",
		"var applied = [];",
		"var skipped = [];",
		"var displayMode = null;",
		"var A = resolveApi();",
		"if (!A) return JSON.stringify({ error: 'api-unavailable' });",
		"var doc = A.GetDocument();",
		"if (!doc) return JSON.stringify({ error: 'no-document' });",
		"if (!operations.length) return JSON.stringify({ applied: applied, skipped: skipped, note: 'nothing-to-do' });",
		"var history = false;",
		"if (S.createHistoryPoint !== false && typeof doc.CreateNewHistoryPoint === 'function') {",
		"	try { doc.CreateNewHistoryPoint(); history = true; } catch (e) { history = false; }",
		"}",
		"for (var i = 0; i < operations.length; i++) {",
		"	var op = operations[i];",
		// Get the caret into position *before* deleting. ApiRange.Delete() saves the
		// document state when it starts and loads it back when it finishes, so the
		// caret it leaves behind is the one that existed beforehand. Doing it first
		// also means a position that cannot be resolved is reported while the
		// document is still intact.
		"	if (!moveCursorTo(op.start)) { skipped.push({ start: op.start, end: op.end, reason: 'cursor-unavailable' }); continue; }",
		"	var range = null;",
		"	try { range = doc.GetRange(op.start, op.end); } catch (e) { range = null; }",
		"	if (!range) { skipped.push({ start: op.start, end: op.end, reason: 'range-unavailable' }); continue; }",
		"	var actual = null;",
		"	try { actual = range.GetText(); } catch (e) { actual = null; }",
		"	if (actual !== op.expected) {",
		"		skipped.push({ start: op.start, end: op.end, reason: 'text-mismatch', expected: op.expected, actual: actual });",
		"		continue;",
		"}",
		"	try { range.Delete(); } catch (e) { skipped.push({ start: op.start, end: op.end, reason: 'delete-failed: ' + errorText(e) }); continue; }",
		// ApiRange.Delete() restores the state saved above, which is that caret; a
		// build that restores something else must not silently misplace the math.
		"moveCursorTo(op.start);",
		"var inserted = false;",
		"	try { inserted = doc.AddMathEquation(op.latex, 'latex'); } catch (e) { skipped.push({ start: op.start, end: op.end, reason: 'insert-failed: ' + errorText(e) }); continue; }",
		"	if (inserted === false) { skipped.push({ start: op.start, end: op.end, reason: 'latex-rejected' }); continue; }",
		// Outcome check: the source text of this span must be gone from its own
		// paragraph. If it survived, the equation was inserted somewhere else and
		// the run has to stop instead of piling more damage on the document.
		"var leftover = paragraphText(doc, op.paragraphIndex);",
		"if (leftover !== null && op.expected && leftover.indexOf(op.expected) >= 0) {",
		"	skipped.push({ start: op.start, end: op.end, reason: 'misplaced-after-insert' });",
		"	break;",
		"}",
		"var mode = null;",
		"if (op.display) { mode = makeDisplay(); displayMode = displayMode || mode; }",
		"applied.push({ start: op.start, end: op.end, latex: op.latex, display: !!op.display, displayApplied: mode });",
		"}",
		"return JSON.stringify({ applied: applied, skipped: skipped, historyPoint: history, displayMode: displayMode });"
	].join("\n");

	// Resolves char offsets inside a paragraph to real document positions. A
	// content item can cost more positions than the characters it renders (an
	// inline equation counts 3 positions for the 1 character its text shows), so
	// `paragraph.start + span.start` drifts, APPLY_BODY refuses the span as
	// `text-mismatch`, and the conversion silently does nothing - live repro
	// row 2, measured as `Skipped (text-mismatch) @10 expected="$y$"`. The probe
	// walks the paragraph's range and keeps the first position whose GetText()
	// equals the requested prefix exactly; an offset that never matches (a span
	// boundary inside a multi-character render) stays unresolved, planning falls
	// back to the best-effort arithmetic, and the apply-time guard still
	// protects the document behind both.
	var RESOLVE_BODY = [
		"var S = scopeOf(scopeArg);",
		"var A = resolveApi();",
		"if (!A) return JSON.stringify({ error: 'api-unavailable' });",
		"var doc = A.GetDocument();",
		"if (!doc) return JSON.stringify({ error: 'no-document' });",
		"var out = [];",
		"var specs = S.paragraphs || [];",
		"for (var i = 0; i < specs.length; i++) {",
		"	var spec = specs[i];",
		"	var text = typeof spec.text === 'string' ? spec.text : '';",
		// Paragraph text carries its mark as `\r\n`; no range ever does.
		"	var content = text.slice(-2) === '\\r\\n' ? text.slice(0, -2) : text;",
		"	var base = typeof spec.start === 'number' ? spec.start : -1;",
		"	var span = typeof spec.span === 'number' ? spec.span : -1;",
		"	var positions = {};",
		"	var need = spec.need || [];",
		"	if (base >= 0 && span >= 0) {",
		"		for (var n = 0; n < need.length; n++) {",
		// Offset 0 is the paragraph's own start: GetRange(base, base) is empty
		// text by definition, and probing would otherwise match it one position
		// late on a paragraph whose first content item renders as nothing.
		"			if (need[n] === 0) positions[0] = base;",
		"		}",
		"		var previous = '';",
		"		for (var q = 1; q <= span; q++) {",
		"			var range = null;",
		"			try { range = doc.GetRange(base, base + q); } catch (e) { range = null; }",
		"			if (!range) break;",
		"			var current = null;",
		"			try { current = range.GetText(); } catch (e) { current = null; }",
		// Rendered text must grow as a prefix; anything else means this walk
		// cannot be trusted and the remaining offsets stay unresolved.
		"			if (typeof current !== 'string' || current.indexOf(previous) !== 0) break;",
		"			previous = current;",
		"			for (var k = 0; k < need.length; k++) {",
		"				var offset = need[k];",
		"				if (positions[offset] === undefined && content.slice(0, offset) === current) {",
		"					positions[offset] = base + q;",
		"				}",
		"			}",
		"			if (current === content) break;",
		"		}",
		"	}",
		"	out.push({ index: spec.index, positions: positions });",
		"}",
		"return JSON.stringify({ paragraphs: out });"
	].join("\n");

	// A trivial command that only the live editor can answer; its answer proves
	// the document is loaded (code.js uses it as the menu-publication signal).
	var PROBE_BODY = ["return JSON.stringify({ latexMathProbe: true });"].join("\n");

	var RUNNERS = {
		read: makeCommand(READ_BODY),
		apply: makeCommand(APPLY_BODY),
		resolve: makeCommand(RESOLVE_BODY),
		probe: makeCommand(PROBE_BODY)
	};

	// Runs are serialised: one command is in flight and later runs queue
	// behind it. The payload rides ONE shared slot (`Asc.scope`), so two
	// commands in flight at once swap payloads - measured live (two overlapping
	// conversions answered `unparsable-command-result` / `no response from
	// editor`). Queueing keeps every answer paired with the payload its own
	// run put in the slot. The alternative is fail-fast supersede (a new run
	// displaces the in-flight one, which settles `clobbered`): a fresh click
	// would start immediately instead of waiting, but the displaced caller
	// gets an error and the displaced command may still read the superseding
	// run's payload. Queueing chooses "every caller keeps its own answer" over
	// "the newest run starts now" - a run queued behind a hung one waits out
	// that run's timeout before its own round trip begins.
	var inFlight = null;
	var waiting = [];

	/**
	 * Run one command in the editor page. Resolves with the parsed JSON result,
	 * or `{error: …}` from the seam's taxonomy. `timeoutMs` overrides the
	 * backstop for tests.
	 */
	function run(name, payload, timeoutMs) {
		var command = RUNNERS[name];
		if (!command) {
			// A caller-side programming error, not a seam failure: there is no
			// honest error code for asking the editor something unknowable.
			throw new Error("unknown editor command: " + name);
		}
		return new Promise(function (resolve) {
			waiting.push({
				command: command,
				payload: payload || {},
				timeoutMs: typeof timeoutMs === "number" ? timeoutMs : COMMAND_TIMEOUT_MS,
				resolve: resolve,
				settled: false,
				timer: null
			});
			pump();
		});
	}

	function pump() {
		if (inFlight || waiting.length === 0) {
			return;
		}
		var entry = waiting.shift();
		inFlight = entry;
		dispatch(entry);
	}

	function dispatch(entry) {
		// The UMD root is the plugin frame's `window` (or `self`) wherever this
		// module is loaded; the host bridge lives there.
		var plugin = root.Asc && root.Asc.plugin;
		if (!plugin || typeof plugin.callCommand !== "function") {
			finish(entry, { error: "callCommand-unavailable" });
			return;
		}
		try {
			// The generated command wrapper reads the payload from Asc.scope.
			root.Asc.scope = entry.payload;
			// Arm the backstop before dispatching: a host that answers
			// synchronously would otherwise leave the timer orphaned.
			entry.timer = root.setTimeout(function () {
				finish(entry, { error: "timeout" });
			}, entry.timeoutMs);
			plugin.callCommand(entry.command, false, true, function (value) {
				if (entry.settled) {
					// A superseded or duplicated late callback settles as
					// `clobbered` and is discarded: the guard in `finish` is
					// what drops it, so a late answer can neither revive a
					// finished run nor leak into the run that owns the slot
					// now. Under the queueing policy above no caller ever
					// observes `clobbered`; it is the displaced run's answer
					// under the fail-fast alternative.
					finish(entry, { error: "clobbered" });
					return;
				}
				finish(entry, parseCommandResult(value) || { error: "timeout" });
			});
		} catch (e) {
			finish(entry, { error: "callCommand-threw: " + (e && e.message) });
		}
	}

	function finish(entry, result) {
		if (entry.settled) {
			return;
		}
		entry.settled = true;
		if (entry.timer !== null) {
			root.clearTimeout(entry.timer);
			entry.timer = null;
		}
		inFlight = null;
		entry.resolve(result);
		pump();
	}

	return {
		run: run,
		// The compiled commands stay exported for tests that drive one body
		// directly (the VM-recompile tests wrap `toString()` themselves).
		// Plugin code goes through `run`.
		readCommand: RUNNERS.read,
		applyCommand: RUNNERS.apply,
		resolveCommand: RUNNERS.resolve,
		probeCommand: RUNNERS.probe
	};
});
