/*
 * Command builders for the `$...$` -> ONLYOFFICE math conversion.
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
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.OnlyOfficeLatexMathCommands = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
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
		// `aligned` is diagnostic only, never a gate: a range counts positions
		// (empty ones render as nothing, the paragraph mark renders as two
		// characters), so it is false for ordinary prose as well. What actually
		// guards the write is APPLY_BODY comparing each span's live range text.
		"	out.push({ start: start, end: end, text: text, aligned: (end - start) === text.length });",
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

	return {
		makeCommand: makeCommand,
		readCommand: makeCommand(READ_BODY),
		applyCommand: makeCommand(APPLY_BODY),
		PRELUDE: PRELUDE
	};
});
