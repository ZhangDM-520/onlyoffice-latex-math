"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const core = require(path.join(__dirname, "..", "plugin", "scripts", "scan.js"));
const commands = require(path.join(__dirname, "..", "plugin", "scripts", "commands.js"));
const { createEditor } = require(path.join(__dirname, "fake-editor.js"));
const { createHarness } = require(path.join(__dirname, "plugin-harness.js"));

const PLUGIN_DEFAULTS = {
	delimiters: { inlineDollar: true, displayDollar: true, inlineParen: true, displayBracket: true },
	currencyGuard: true
};

/*
 * Inside the editor page `Api` is a global, so the command functions resolve it
 * through `typeof Api`. These helpers expose the simulated document the same
 * way before invoking a command.
 */
function withEditorGlobals(editor, fn) {
	const previousApi = globalThis.Api;
	const previousWindow = globalThis.window;
	globalThis.Api = editor.apiDocument;
	globalThis.window = globalThis.window || {};
	if (editor.editorApi) {
		globalThis.window.editor = editor.editorApi;
	}
	try {
		return fn();
	} finally {
		if (previousApi === undefined) {
			delete globalThis.Api;
		} else {
			globalThis.Api = previousApi;
		}
		if (previousWindow === undefined) {
			if (globalThis.window && !globalThis.window.editor) {
				delete globalThis.window;
			}
		} else {
			globalThis.window = previousWindow;
		}
	}
}

function read(editor) {
	return withEditorGlobals(editor, function () {
		return JSON.parse(commands.readCommand({}));
	});
}

function apply(editor, plan, extra) {
	return withEditorGlobals(editor, function () {
		return JSON.parse(
			commands.applyCommand(Object.assign({ operations: plan.operations, createHistoryPoint: true }, extra || {}))
		);
	});
}

/** read -> plan -> apply, the exact sequence code.js performs. */
function convertAll(editor, options, filter) {
	const snapshot = read(editor);
	const collected = core.collectParagraphs(snapshot);
	const plan = core.planReplacements(collected.paragraphs, options || PLUGIN_DEFAULTS, filter || null);
	const result = apply(editor, plan);
	return { snapshot, collected, plan, result };
}

/**
 * Highlight everything, the way `Ctrl+A` does.
 *
 * There is one conversion and it acts on the selection, so "convert the whole
 * document" is a *selection over the whole document*: a test that wants every
 * span converted has to say so, exactly as the owner does. The end offset comes
 * from the snapshot rather than from `editor.text().length` - the two do not
 * agree (the mark is a position in one and two characters in the other), and the
 * document's own last position is what the editor would report.
 */
function selectAll(editor) {
	const end = read(editor).paragraphs.reduce(function (max, paragraph) {
		return paragraph.end === null ? max : Math.max(max, paragraph.end);
	}, 0);
	editor.state.selection = { start: 0, end: end };
	return editor;
}

test("read command reports paragraphs, offsets and alignment", () => {
	const editor = createEditor({ paragraphs: ["First $a$", "Second paragraph"] });
	const snapshot = read(editor);
	assert.strictEqual(snapshot.paragraphs.length, 2);
	// A paragraph's own range carries its trailing mark, as the host does, so the
	// reported text is longer than the content the offsets cover.
	assert.strictEqual(snapshot.paragraphs[0].text, "First $a$\r\n");
	assert.strictEqual(snapshot.paragraphs[0].start, 0);
	// Paragraph marks occupy one document offset, so paragraph two does not
	// start right after the first paragraph's text.
	assert.strictEqual(snapshot.paragraphs[1].start, "First $a$".length + 1);
	// The range span and the text length never agree (the mark is two characters in
	// the text and one position in the range), so nothing may compare them - the
	// snapshot does not even carry the comparison any more.
	assert.notStrictEqual(
		snapshot.paragraphs[0].end - snapshot.paragraphs[0].start,
		snapshot.paragraphs[0].text.length,
		"the length comparison would fail for ordinary prose too"
	);
	// With nothing highlighted the editor still reports a selection, collapsed at
	// the caret, which is why an empty range must never be used as a filter.
	assert.deepStrictEqual(snapshot.selection, { start: 0, end: 0 });
	assert.strictEqual(snapshot.hasHistoryApi, true);
});

// ---------------------------------------------------------------------------
// The owner-reported bug: no paragraph survived the offset filter.
//
// Reported live as "Scanned: 0 paragraphs, 0 LaTeX spans found / Skipped
// paragraphs whose text offsets cannot be mapped: 3" for a document whose only
// content was `$$x=1$$`. The three paragraphs measured on onlyoffice-git
// 9.4.0.130 were:
//
//   "a=\u2592n_i" (legacy equation)  19 positions vs 11 characters
//   ""                                3 positions vs  2 characters
//   " $$x=1$$"                       11 positions vs 10 characters
//
// Every one of them fails `end - start === text.length`, so the gate rejected
// the whole document. Detection now scans every paragraph and the write path
// verifies each span against the live range.
// ---------------------------------------------------------------------------

test("a document where every paragraph fails the length comparison still converts", async () => {
	const editor = createEditor({
		mathRendersAsPlaceholder: true,
		paragraphs: ["a=", "", " $$x=1$$"]
	});
	// The legacy old-Format equation: one position, one placeholder character.
	editor.segments()[0].push({ type: "math", latex: "\\sum n_i" });

	const snapshot = read(editor);
	// Nothing in the snapshot compares offsets with lengths any more - and this is
	// why: every paragraph here would fail the comparison, the same way ordinary
	// prose does (the mark is two characters in `text` and one position in the
	// range).
	assert.deepStrictEqual(
		snapshot.paragraphs.map((paragraph) => paragraph.end - paragraph.start !== paragraph.text.length),
		[true, true, true],
		"every reported range is shorter than its own text"
	);

	const harness = createHarness(selectAll(editor));
	harness.init();
	const report = await harness.convertSelection();

	assert.deepStrictEqual(
		editor.maths().map((math) => math.latex),
		["\\sum n_i", "x=1"],
		"the legacy equation is untouched and the span is converted"
	);
	assert.ok(
		report.lines.some((line) => line.includes("Converted: 1 / 1")),
		JSON.stringify(report.lines)
	);
	assert.ok(
		report.lines.some((line) => line.includes("Scanned: 3")),
		"all three paragraphs are scanned: " + JSON.stringify(report.lines)
	);
	assert.ok(
		!report.lines.some((line) => line.includes("could not be read")),
		"nothing was unreadable: " + JSON.stringify(report.lines)
	);
});

test("a selection over a paragraph whose offsets cannot be proven still converts", async () => {
	// ` $$x=1$$` is the last paragraph: "a=" plus a placeholder equation occupies
	// offsets 0-3, the empty paragraph 4, so the text starts at 5. The span sits
	// at text index 1, i.e. offsets 6-13.
	const editor = createEditor({
		mathRendersAsPlaceholder: true,
		selection: { start: 5, end: 13 },
		paragraphs: ["a=", "", " $$x=1$$"]
	});
	editor.segments()[0].push({ type: "math", latex: "\\sum n_i" });

	const harness = createHarness(editor);
	harness.init();
	const report = await harness.convertSelection();

	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["\\sum n_i", "x=1"]);
	assert.ok(
		report.lines.some((line) => line.includes("Converted: 1 / 1")),
		JSON.stringify(report.lines)
	);
	assert.ok(
		!report.lines.some((line) => line.includes("Outside the selection")),
		JSON.stringify(report.lines)
	);
});

test("a paragraph that cannot be read is reported, not silently dropped", async () => {
	const editor = createEditor({ paragraphs: ["$broken$", "$ok$"] });
	const realGetAllParagraphs = editor.apiDocument.GetAllParagraphs;
	editor.apiDocument.GetAllParagraphs = function () {
		const paragraphs = realGetAllParagraphs.call(editor.apiDocument);
		paragraphs[0].GetRange = function () {
			return null;
		};
		return paragraphs;
	};

	const harness = createHarness(selectAll(editor));
	harness.init();
	const report = await harness.convertSelection();

	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["ok"]);
	assert.ok(
		report.lines.some((line) => line.includes("Paragraphs that could not be read: 1")),
		JSON.stringify(report.lines)
	);
});

test("whole-document conversion replaces every delimiter run with a math object", () => {
	const editor = createEditor({
		// The fake renders an equation as a single placeholder character, which is
		// what the editor does, so "is the LaTeX source gone" is a real assertion.
		mathRendersAsPlaceholder: true,
		paragraphs: [
			"Euler: $e^{i\\pi} + 1 = 0$ holds.",
			"Display: $$\\int_0^1 x\\,dx = \\frac{1}{2}$$ and inline \\(\\alpha\\) plus \\[\\beta^2\\].",
			"Currency $10 and $20 stay untouched.",
			"Escaped \\$5 is not math, but $a\\$b$ is."
		]
	});

	const { result, plan } = convertAll(editor);

	assert.strictEqual(plan.operations.length, 5);
	assert.strictEqual(result.applied.length, 5);
	assert.strictEqual(result.skipped.length, 0);
	assert.strictEqual(result.historyPoint, true);
	assert.strictEqual(editor.state.historyPoints, 1);

	const maths = editor.maths().map((math) => math.latex);
	assert.deepStrictEqual(maths, [
		"e^{i\\pi} + 1 = 0",
		"\\int_0^1 x\\,dx = \\frac{1}{2}",
		"\\alpha",
		"\\beta^2",
		"a\\$b"
	]);

	assert.deepStrictEqual(
		editor.maths().map((math) => math.display),
		[false, true, false, true, false]
	);

	const text = editor.text();
	assert.ok(!text.includes("$$"), "display delimiters must be gone: " + text);
	assert.strictEqual(text.includes("\\int_0^1"), false, "latex source must be replaced by math objects");
	assert.ok(text.includes("$10 and $20"), "currency must survive: " + text);
	assert.ok(text.includes("\\$5"), "escaped dollars must survive: " + text);
});

test("display math is switched to display mode through the logic document", () => {
	const editor = createEditor({ paragraphs: ["$$x + y$$"] });
	convertAll(editor);
	assert.deepStrictEqual(editor.state.displayConversions, [{ isInline: false, via: "logic-document" }]);
	assert.strictEqual(editor.maths()[0].displayModeApplied, "logic-document");
});

test("reverse-order application keeps later offsets valid", () => {
	// Every span changes the length of its paragraph, so applying front-to-back
	// would corrupt the remaining offsets. The fake renders equations as their
	// LaTeX source, so the final text shows the equation bodies in place of the
	// delimited source.
	const editor = createEditor({ paragraphs: ["$a$ $bcdef$ $g$"] });
	const { result } = convertAll(editor);
	assert.strictEqual(result.applied.length, 3);
	assert.deepStrictEqual(
		editor.state.insertedMath.map((entry) => entry.latex),
		["g", "bcdef", "a"],
		"edits must be applied last span first"
	);
	// Document order is still left to right.
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["a", "bcdef", "g"]);
	assert.strictEqual(editor.text(), "a bcdef g");
});

test("the caret is moved before each insert so the equation lands inside its own span", () => {
	// Regression: ApiRange.Delete() restores the document state saved when it was
	// called, so the caret it leaves behind is the one from before the command
	// started - typically the very top of the document. AddMathEquation() inserts
	// *at the caret*, which used to drop every equation into paragraph one. The
	// caret must therefore be placed explicitly at the span start.
	const editor = createEditor({
		mathRendersAsPlaceholder: true,
		paragraphs: ["First $a$ here", "Second $b$ here"]
	});
	const { result } = convertAll(editor);

	assert.strictEqual(result.applied.length, 2);
	assert.strictEqual(result.skipped.length, 0);
	assert.deepStrictEqual(
		editor.state.cursorMoves,
		[
			22, 22, // "Second $b$ here" -> "$b$" starts at 22 (reverse order runs last first)
			6, 6 // "First $a$ here"  -> "$a$" starts at 6
		],
		"each operation places the caret at its span start, before and after the delete"
	);
	assert.strictEqual(editor.text(), "First \uFFFC here\nSecond \uFFFC here");
});

test("a build that cannot move the caret leaves the document untouched", () => {
	const editor = createEditor({
		mathRendersAsPlaceholder: true,
		hasMoveCursorApi: false,
		paragraphs: ["First $a$ here", "Second $b$ here"]
	});
	const before = editor.text();
	const { result } = convertAll(editor);

	assert.strictEqual(result.applied.length, 0);
	assert.strictEqual(result.skipped.length, 2);
	assert.deepStrictEqual(
		result.skipped.map((entry) => entry.reason),
		["cursor-unavailable", "cursor-unavailable"]
	);
	assert.strictEqual(editor.state.insertedMath.length, 0);
	assert.strictEqual(editor.text(), before, "nothing may be rewritten without a placed caret");
});

test("an insert that leaves its source text behind stops the run", () => {
	// The outcome check: if the LaTeX source survives inside its own paragraph the
	// equation went somewhere else, so the remaining spans must be left alone
	// instead of piling more damage onto the document.
	const editor = createEditor({
		mathRendersAsPlaceholder: true,
		paragraphs: ["$a$ and $b$ here", "later $c$"]
	});
	// A build whose ApiRange.Delete() does not actually remove the span.
	const realGetRange = editor.apiDocument.GetRange;
	editor.apiDocument.GetRange = function (start, end) {
		const range = realGetRange.call(editor.apiDocument, start, end);
		if (range) {
			range.Delete = function () {
				return true;
			};
		}
		return range;
	};

	const { result } = convertAll(editor);

	assert.deepStrictEqual(
		result.skipped.map((entry) => entry.reason),
		["misplaced-after-insert"]
	);
	assert.strictEqual(result.applied.length, 0);
	assert.strictEqual(
		editor.text().includes("$b$"),
		true,
		"the run must stop before touching any later span"
	);
});

test("verification pass finds no remaining delimiters", () => {
	const editor = createEditor({ paragraphs: ["One $x^2$ two", "Three $$y_3$$ four"] });
	convertAll(editor);
	const after = core.collectParagraphs(read(editor));
	const remaining = core.planReplacements(after.paragraphs, PLUGIN_DEFAULTS, null);
	assert.deepStrictEqual(remaining.operations, []);
});

test("selection filter converts only the selected spans", () => {
	const editor = createEditor({ paragraphs: ["$a$ middle $b$ end $c$"] });
	const first = "$a$".length;
	const secondStart = first + " middle ".length;
	const secondEnd = secondStart + "$b$".length;
	editor.state.selection = { start: secondStart, end: secondEnd };

	const { result, plan } = convertAll(editor, PLUGIN_DEFAULTS, editor.state.selection);

	assert.strictEqual(plan.operations.length, 1);
	assert.strictEqual(plan.skipped.length, 2);
	assert.strictEqual(result.applied.length, 1);
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["b"]);
	assert.ok(editor.text().includes("$a$") && editor.text().includes("$c$"), editor.text());
});

test("display delimiters inside the selection still produce display math", () => {
	// There is no "convert the selection as display math" action any more: the
	// delimiters decide, and `$$`/`\[` mean display.
	const editor = createEditor({ paragraphs: ["Mix $a$ and $$b$$ here"] });
	selectAll(editor);

	const { result } = convertAll(editor, PLUGIN_DEFAULTS, editor.state.selection);

	assert.strictEqual(result.applied.length, 2);
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["a", "b"]);
	assert.deepStrictEqual(
		editor.maths().map((math) => math.display),
		[false, true],
		"only the $$ span is switched to display"
	);
	assert.deepStrictEqual(editor.state.displayConversions, [{ isInline: false, via: "logic-document" }]);
});

test("paragraphs with unprovable offsets are attempted and refused per span", () => {
	// Regression for the owner-reported bug: an offset that cannot be proven 1:1
	// used to discard the whole paragraph, which silently dropped ordinary prose
	// too (the host's `end - start` counts positions while GetText() returns
	// characters plus the paragraph mark). The paragraph is now scanned, and the
	// span whose positions drifted is refused by the apply-time text check
	// instead - a reported skip, not a corrupt document.
	const editor = createEditor({ paragraphs: ["ok $x$ here", "has image $y$ here"] });
	// Simulate a paragraph whose rendered text is longer than its content count.
	const segments = editor.segments();
	segments[1].unshift({ type: "image" });

	const snapshot = read(editor);
	const collected = core.collectParagraphs(snapshot);
	assert.strictEqual(collected.unusable, 0, "an unprovable offset must not discard the paragraph");
	assert.strictEqual(collected.paragraphs.length, 2);

	const plan = core.planReplacements(collected.paragraphs, PLUGIN_DEFAULTS, null);
	assert.strictEqual(plan.operations.length, 2, "both spans are planned; the write path decides");

	const result = apply(editor, plan);
	assert.strictEqual(result.applied.length, 1);
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["x"]);
	assert.strictEqual(result.skipped.length, 1);
	assert.strictEqual(result.skipped[0].reason, "text-mismatch");
	assert.ok(editor.text().includes("$y$"), "the drifted paragraph keeps its source text");
});

test("a stale plan is rejected by the text-mismatch guard", () => {
	const editor = createEditor({ paragraphs: ["Math $x$ tail"] });
	const snapshot = read(editor);
	const plan = core.planReplacements(core.collectParagraphs(snapshot).paragraphs, PLUGIN_DEFAULTS, null);

	// Someone edits the paragraph between planning and applying.
	editor.segments()[0][0].value = "Math  xy  tail";
	const result = apply(editor, plan);

	assert.strictEqual(result.applied.length, 0);
	assert.strictEqual(result.skipped.length, 1);
	assert.strictEqual(result.skipped[0].reason, "text-mismatch");
	assert.strictEqual(editor.maths().length, 0);
});

test("latex rejected by the editor is reported instead of silently dropped", () => {
	const editor = createEditor({ paragraphs: ["$   $"] });
	// The scanner rejects empty spans, so plan by hand to test the command guard.
	const result = apply(editor, { operations: [] });
	assert.strictEqual(result.note, "nothing-to-do");

	const editor2 = createEditor({ paragraphs: ["$x$"] });
	const snapshot = read(editor2);
	const plan = core.planReplacements(core.collectParagraphs(snapshot).paragraphs, PLUGIN_DEFAULTS, null);
	plan.operations[0].latex = "   ";
	const result2 = apply(editor2, plan);
	assert.strictEqual(result2.applied.length, 0);
	assert.strictEqual(result2.skipped[0].reason, "latex-rejected");
});

test("display conversion falls back to the editor api when no current math is exposed", () => {
	const editor = createEditor({ paragraphs: ["$$z$$"] });
	editor.apiDocument.Document.GetCurrentMath = function () {
		return null;
	};
	const harness = createHarness(editor, { editorExposedAsWindowEditor: true });
	harness.init();

	// Swap in the harness document (identical fake, wrapped by the vm context).
	editor.apiDocument.Document.GetCurrentMath = function () {
		return null;
	};

	const snapshot = read(editor);
	const plan = core.planReplacements(core.collectParagraphs(snapshot).paragraphs, PLUGIN_DEFAULTS, null);
	const result = apply(editor, plan);
	assert.strictEqual(result.applied.length, 1);
});

test("command scope can arrive as a closure variable instead of an argument", () => {
	const editor = createEditor({ paragraphs: ["$k$"] });
	const snapshot = read(editor);
	const plan = core.planReplacements(core.collectParagraphs(snapshot).paragraphs, PLUGIN_DEFAULTS, null);

	// `Asc.plugin.callCommand` generates a wrapper that declares `var scope = ...`
	// and calls the command without arguments - reproduce that shape exactly.
	const invoke = new Function(
		"scope",
		"return (" + commands.applyCommand.toString() + ")(undefined);"
	);
	const result = JSON.parse(
		withEditorGlobals(editor, function () {
			return invoke({ operations: plan.operations });
		})
	);
	assert.strictEqual(result.applied.length, 1);
});

test("commands resolve the builder api through window.AscBuilder when Api is absent", () => {
	const editor = createEditor({ paragraphs: ["$w$"] });
	const context = vm.createContext({
		window: { AscBuilder: { Word: { Api: editor.apiDocument } } },
		console: console,
		JSON: JSON
	});
	const result = JSON.parse(
		vm.runInContext("(" + commands.readCommand.toString() + ")({})", context)
	);
	assert.strictEqual(result.paragraphs.length, 1);
	assert.strictEqual(result.paragraphs[0].text, "$w$\r\n");
});

test("the menus are withheld while the editor is still booting", async () => {
	// Regression: an AddToolbarMenuItem sent from `init` is dropped by the host,
	// so the ribbon tab never appeared. Publication waits for the editor.
	const editor = createEditor({ paragraphs: ["$d$"] });
	const harness = createHarness(editor, { editorReady: false });

	harness.initOnly();
	assert.strictEqual(harness.harness.toolbarRegistered, undefined, "not published from init alone");
	assert.strictEqual(harness.harness.roots.length, 0, "menus are not even built yet");
	assert.strictEqual(
		harness.getHotkeyStatus().attached,
		2,
		"the hotkey listeners are attached immediately, whatever the menus are waiting for"
	);

	harness.translate();
	assert.strictEqual(harness.harness.toolbarRegistered, true, "onTranslate publishes the menus");
	assert.strictEqual(harness.harness.contextMenuRegistered, true);
	assert.ok(harness.harness.roots.length >= 1, "the toolbar root is built at publication");
});

// Regression, then contract. The host only copies a context-menu root into the
// menu when the live context type matches one of `showOnOptionsType`, or when a
// checker is "All" - with no checker the entry never appeared in the real
// document right-click menu at all (9.4.0.130-1). It now has to pass that gate
// *and* be a single row that acts.
test("the right-click entry is one row that converts the selection", async () => {
	const editor = createEditor({ paragraphs: ["$a$ and $b$"], selection: { start: 0, end: 3 } });
	const harness = createHarness(editor);
	harness.init();

	const root = harness.harness.roots.filter(function (item) {
		return item.itemType === "contextMenu" && item.parent === null;
	})[0];
	assert.ok(root, "the context menu root exists");
	assert.strictEqual(root.text, "LaTeX math", "with its caption");
	assert.deepStrictEqual(root.showOnOptionsType, ["All"], "the root opts into every context type");
	assert.strictEqual(root.children.length, 0, "no submenu: the row itself is the action");
	assert.strictEqual(typeof root.onClick, "function", "and it has a handler, or it would be a dead row");

	const report = await root.click();

	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["a"]);
	assert.ok(editor.text().includes("$b$"), "only the selection is converted: " + editor.text());
	assert.ok(
		report.lines.some((line) => line.includes("Converted: 1 / 1")),
		JSON.stringify(report.lines)
	);
});

// `items` present-but-empty is what the owner used to get: an entry that opens a
// submenu. An item with no children emits no `items` at all, which is the shape
// the host renders as a plain, immediately clickable row.
test("the composed right-click entry carries no submenu, whatever the context type", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$d$"] }));
	harness.init();

	["Selection", "Target", "None"].forEach(function (contextType) {
		const composed = harness.harness.composeContextMenu(contextType);
		assert.strictEqual(composed.items.length, 1, contextType + ": exactly one entry");
		const root = composed.items[0];
		assert.strictEqual(root.text, "LaTeX math");
		assert.strictEqual("items" in root, false, contextType + ": it is a row, not a submenu");
	});
});

// The contract at the top of this phase: the plugin respects the owner's
// discretion. With nothing highlighted there is nothing to convert, and the one
// conversion must not quietly fall back to the whole document.
test("the right-click row converts nothing when nothing is selected", async () => {
	const editor = createEditor({ paragraphs: ["$a$ and $b$"] });
	const harness = createHarness(editor);
	harness.init();

	const root = harness.harness.roots.filter(function (item) {
		return item.itemType === "contextMenu" && item.parent === null;
	})[0];
	await root.click();
	const report = harness.getLastReport();

	assert.strictEqual(editor.maths().length, 0, "nothing was converted");
	assert.strictEqual(report.converted, 0);
	assert.ok(editor.text().includes("$a$ and $b$"), editor.text());
	assert.ok(
		report.lines.some((line) => line.includes("Select the text to convert first")),
		JSON.stringify(report.lines)
	);
});

test("an editor round-trip publishes the menus even without onTranslate", () => {
	const editor = createEditor({ paragraphs: ["$d$"] });
	const harness = createHarness(editor);
	harness.initOnly();

	// The probe command is answered synchronously by the simulated editor, so
	// the promise chain settles on the microtask queue.
	return Promise.resolve().then(() => {
		assert.strictEqual(harness.harness.toolbarRegistered, true);
	});
});

// A host that says `init` and then `onThemeChanged` is the case the readiness
// pair exists for: `init` and `theme` are both *host* signals, and the editor
// half needs `onTranslate` (or a round-trip). A theme-only host therefore still
// waits for the backstop - that is what the backstop is for, and this pins the
// behaviour rather than leaving it to be rediscovered.
test("a theme-only host still waits for the backstop", async () => {
	const harness = createHarness(createEditor({ paragraphs: ["$d$"] }), { editorReady: false });
	harness.Asc.plugin.onThemeChanged("dark");
	assert.strictEqual(
		harness.harness.toolbarRegistered,
		undefined,
		"a host signal alone does not mean the editor is answering"
	);

	await new Promise((resolve) => setTimeout(resolve, 1700));
	assert.strictEqual(harness.harness.toolbarRegistered, true, "the backstop publishes anyway");
});

test("a host that never confirms readiness still gets the menus", async () => {
	const editor = createEditor({ paragraphs: ["$d$"] });
	const harness = createHarness(editor, { editorReady: false });
	harness.initOnly();
	assert.strictEqual(harness.harness.toolbarRegistered, undefined);

	// The backstop is a real timer; waiting it out is the point of the test.
	await new Promise((resolve) => setTimeout(resolve, 1700));
	assert.strictEqual(harness.harness.toolbarRegistered, true, "the backstop published the menus");
});

test("a menu refresh keeps the ribbon tab caption", async () => {
	// Regression: updateToolbarMenu was fed `menuRoot.name`, which does not
	// exist on a ButtonToolbar, blanking the tab caption on every conversion.
	const editor = selectAll(createEditor({ paragraphs: ["$c$"] }));
	const harness = createHarness(editor);
	harness.init();
	await harness.convertSelection();

	const updates = harness.harness.toolbarUpdates;
	assert.ok(updates.length >= 1, "a menu refresh was sent");
	assert.strictEqual(updates[updates.length - 1].id, harness.harness.roots[0].id);
	assert.strictEqual(updates[updates.length - 1].caption, "LaTeX math");
});

test("the plugin initialises, registers menus and converts through the bridge", async () => {
	const editor = createEditor({
		paragraphs: ["Energy $E = mc^2$ and $a^2+b^2=c^2$.", "Keep $10 and $20."]
	});
	const harness = createHarness(selectAll(editor));
	harness.init();

	const h = harness.harness;
	assert.strictEqual(h.toolbarRegistered, true);
	assert.strictEqual(h.contextMenuRegistered, true);
	assert.ok(h.roots.length >= 1, "a toolbar root was created");
	// The ribbon tab is a settings surface now: the report entry and the five
	// toggles, and nothing that converts (the selection is the unit of work).
	assert.deepStrictEqual(
		h.roots[0].children.map((item) => item.text),
		[
			"Show last report",
			"\u2713 $...$",
			"\u2713 $$...$$",
			"\u2713 \\(...\\)",
			"\u2713 \\[...\\]",
			// Reports are silent by default, so the toggle starts off.
			"\u2717 Report window"
		]
	);
	// The host's plugin key event is not a shortcut channel in this build; the
	// DOM listener is, and this is what proves it was installed.
	assert.strictEqual(h.events.onKeyDown, undefined, "no onKeyDown registration is made");
	assert.strictEqual(JSON.stringify(harness.getHotkeyStatus().chords), '["Alt+L"]');
	assert.strictEqual(harness.getHotkeyStatus().attached, 2, "editor frame and its parent");

	const report = await harness.convertSelection();

	assert.strictEqual(report.converted, 2);
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["E = mc^2", "a^2+b^2=c^2"]);
	assert.ok(editor.text().includes("$10 and $20."), editor.text());
	// Reports are silent by default (SETTINGS_VERSION 2), so a conversion opens
	// nothing; the numbers are kept and reachable from the menu.
	assert.strictEqual(h.windows.length, 0, "no report window on a silent conversion");
	assert.strictEqual(
		harness.getLastReport().converted,
		2,
		"the report is still kept, which is what Show last report shows"
	);

	harness.openReport();
	assert.strictEqual(h.windows.length, 1, "Show last report opens the window");
	assert.ok(
		decodeURIComponent(h.windows[0].variation.url).includes("Converted: 2 / 2"),
		decodeURIComponent(h.windows[0].variation.url)
	);
});

// The hotkey itself (matcher rules, the DOM listener and the real `Alt+L`
// sequence) lives in `tests/hotkey.test.js`, next to the measurement notes.

test("delimiter toggles persist and are honoured", async () => {
	const editor = selectAll(createEditor({ paragraphs: ["$x$ and \\(y\\)"] }));
	const harness = createHarness(editor);
	harness.init();

	const inlineDollarItem = harness.harness.roots[0].children.filter((item) => item.text.includes("$...$"))[0];
	assert.ok(inlineDollarItem, "the $...$ toggle exists");
	inlineDollarItem.click();

	const stored = JSON.parse(harness.window.localStorage.getItem("onlyoffice-latex-math.settings"));
	assert.strictEqual(stored.inlineDollar, false);

	await harness.convertSelection();
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["y"]);
	assert.ok(editor.text().includes("$x$"), editor.text());
});

test("report window can be disabled through settings", async () => {
	const editor = selectAll(createEditor({ paragraphs: ["$q$"] }));
	const harness = createHarness(editor);
	harness.window.localStorage.setItem(
		"onlyoffice-latex-math.settings",
		JSON.stringify({ openReport: false })
	);
	harness.init();
	await harness.convertSelection();
	assert.strictEqual(harness.harness.windows.length, 0);
	assert.strictEqual(editor.maths().length, 1, "conversion still happens");
});

// ---------------------------------------------------------------------------
// The report window.
//
// Closing it needs `Asc.plugin.button`. The host's injected router
// (sdkjs/word/sdk-all.js, the plugin_onMessage blob) handles a dialog button like
// this:
//
//     case "button":
//       Asc.plugin.button || (-1 !== k) || n !== g.buttonWindowId
//           ? Asc.plugin.button(k, g.buttonWindowId)   // throws when undefined
//           : Asc.plugin.executeCommand("close", "");
//
// The click is posted to the plugin frame, whose id is never the window id, so
// the first branch is always taken. Without the hook, clicking the header X threw
// a TypeError inside the handler and the window could not be closed at all.
// ---------------------------------------------------------------------------

test("the plugin defines Asc.plugin.button, which is what closes a window", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();

	assert.strictEqual(
		typeof harness.Asc.plugin.button,
		"function",
		"without this hook the host's router throws on every dialog button"
	);
});

test("the footer Close button and the header X both close the report window", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	harness.openReport();

	const h = harness.harness;
	assert.strictEqual(h.windows.length, 1, "the report opened");
	const id = h.windows[0].id;

	// 0 is the footer Close button, -1 is the dialog's header X.
	harness.pressWindowButton(0, id);
	assert.deepStrictEqual(h.windowCloses, [id], "the footer Close button closed it");

	harness.openReport();
	harness.pressWindowButton(-1, harness.harness.windows[1].id);
	assert.deepStrictEqual(h.windowCloses, [id, "window-1"], "so did the header X");
});

test("a button for another window is ignored", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	harness.openReport();

	// The editor's own window id, and a stray id, must not close the report.
	harness.pressWindowButton(-1, "editor_1");
	harness.pressWindowButton(0, "");
	assert.deepStrictEqual(harness.harness.windowCloses, [], "nothing was closed");
});

test("the report window advertises a Close button to the host", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	harness.openReport();

	const variation = harness.harness.windows[0].variation;
	// An empty `buttons` array is what the host reads as "no footer", which left
	// the header X as the only way out - and that one was broken.
	assert.ok(Array.isArray(variation.buttons) && variation.buttons.length === 1, "one footer button");
	assert.strictEqual(variation.buttons[0].text, "Close");
	assert.strictEqual(variation.buttons[0].primary, true);
	assert.ok(variation.isVisual, "it is a visual window");
	assert.strictEqual(variation.isModal, false);
	assert.ok(!("isViewer" in variation), "isViewer is an API-plugin flag, not a window one");
});

test("a second report is a fresh window, not the stale first one", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();

	harness.openReport();
	const first = harness.harness.windows[0].id;
	harness.openReport();

	const h = harness.harness;
	assert.strictEqual(h.windows.length, 2, "a second window was opened");
	assert.notStrictEqual(h.windows[1].id, first, "with its own frame id");
	// The host ignores a repeat frame id, which is why the old code showed the
	// previous numbers for a second report.
	assert.deepStrictEqual(h.windowCloses, [first], "and the first one was closed");
});

test("reports are silent by default, and an explicit request still opens one", async () => {
	const editor = selectAll(createEditor({ paragraphs: ["$q$"] }));
	const harness = createHarness(editor);
	harness.init();

	await harness.convertSelection();
	assert.strictEqual(harness.harness.windows.length, 0, "a conversion shows no window");
	assert.strictEqual(editor.maths().length, 1, "but it still converts");

	harness.openReport();
	assert.strictEqual(harness.harness.windows.length, 1, "Show last report opens one anyway");
});

test("the ribbon has a Report window toggle, and it is off", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();

	const toggle = harness.harness.roots[0].children.filter((item) => /Report window/.test(item.text))[0];
	assert.ok(toggle, "the toggle exists");
	assert.ok(/^\u2717/.test(toggle.text), "and starts off: " + toggle.text);
	assert.match(toggle.icons, /report-off/, "with the eye-off glyph");

	toggle.click();
	assert.ok(/^\u2713/.test(toggle.text), "clicking turns it on: " + toggle.text);
	assert.match(toggle.icons, /report-on/, "and switches to the eye glyph");
	assert.strictEqual(
		JSON.parse(harness.window.localStorage.getItem("onlyoffice-latex-math.settings")).openReport,
		true
	);
});

test("a settings record from before the silence cannot keep the old behaviour", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	// What a v1 profile holds: no version, and reports explicitly on.
	harness.window.localStorage.setItem(
		"onlyoffice-latex-math.settings",
		JSON.stringify({ inlineDollar: false, openReport: true })
	);
	harness.init();

	const settings = harness.getSettings();
	assert.strictEqual(settings.openReport, false, "the new default wins");
	assert.strictEqual(settings.inlineDollar, false, "the owner's delimiter choice is kept");
});

test("a settings record written after the upgrade is honoured", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.window.localStorage.setItem(
		"onlyoffice-latex-math.settings",
		JSON.stringify({ version: 2, openReport: true })
	);
	harness.init();
	assert.strictEqual(harness.getSettings().openReport, true, "an explicit choice is respected");

	// And the save path stamps the version, so the next load keeps it.
	harness.harness.roots[0].children.filter((item) => /\$\.\.\.\$/.test(item.text))[0].click();
	const stored = JSON.parse(harness.window.localStorage.getItem("onlyoffice-latex-math.settings"));
	assert.strictEqual(stored.version, 2);
	assert.strictEqual(stored.openReport, true);
});
