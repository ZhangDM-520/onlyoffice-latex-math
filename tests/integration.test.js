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

test("read command reports paragraphs, offsets and alignment", () => {
	const editor = createEditor({ paragraphs: ["First $a$", "Second paragraph"] });
	const snapshot = read(editor);
	assert.strictEqual(snapshot.paragraphs.length, 2);
	assert.strictEqual(snapshot.paragraphs[0].text, "First $a$");
	assert.strictEqual(snapshot.paragraphs[0].start, 0);
	// Paragraph marks occupy one document offset, so paragraph two does not
	// start right after the first paragraph's text.
	assert.strictEqual(snapshot.paragraphs[1].start, "First $a$".length + 1);
	assert.strictEqual(snapshot.paragraphs[0].aligned, true);
	// With nothing highlighted the editor still reports a selection, collapsed at
	// the caret, which is why an empty range must never be used as a filter.
	assert.deepStrictEqual(snapshot.selection, { start: 0, end: 0 });
	assert.strictEqual(snapshot.hasHistoryApi, true);
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

test("selection can be forced into display math", () => {
	const editor = createEditor({ paragraphs: ["Inline $x$ here"] });
	editor.state.selection = { start: 0, end: "Inline $x$ here".length };

	const options = Object.assign({}, PLUGIN_DEFAULTS, { forceDisplay: true });
	convertAll(editor, options, editor.state.selection);

	assert.strictEqual(editor.maths().length, 1);
	assert.strictEqual(editor.maths()[0].display, true);
	assert.strictEqual(editor.state.displayConversions.length, 1);
});

test("paragraphs with unmappable offsets are skipped instead of corrupted", () => {
	const editor = createEditor({ paragraphs: ["ok $x$ here", "has image $y$ here"] });
	// Simulate a paragraph whose rendered text is longer than its content count.
	const segments = editor.segments();
	segments[1].unshift({ type: "image" });

	const snapshot = read(editor);
	const collected = core.collectParagraphs(snapshot);
	assert.strictEqual(collected.unusable, 1);
	assert.strictEqual(collected.paragraphs.length, 1);

	const plan = core.planReplacements(collected.paragraphs, PLUGIN_DEFAULTS, null);
	const result = apply(editor, plan);
	assert.strictEqual(result.applied.length, 1);
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["x"]);
	assert.ok(editor.text().includes("$y$"), "the unmappable paragraph keeps its source text");
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
	assert.strictEqual(result.paragraphs[0].text, "$w$");
});

test("the menus are withheld while the editor is still booting", async () => {
	// Regression: an AddToolbarMenuItem sent from `init` is dropped by the host,
	// so the ribbon tab never appeared. Publication waits for the editor.
	const editor = createEditor({ paragraphs: ["$d$"] });
	const harness = createHarness(editor, { editorReady: false });

	harness.initOnly();
	assert.strictEqual(harness.harness.toolbarRegistered, undefined, "not published from init alone");
	assert.strictEqual(harness.harness.roots.length, 0, "menus are not even built yet");
	assert.strictEqual(typeof harness.harness.events.onKeyDown, "function", "events are attached immediately");

	harness.translate();
	assert.strictEqual(harness.harness.toolbarRegistered, true, "onTranslate publishes the menus");
	assert.strictEqual(harness.harness.contextMenuRegistered, true);
	assert.ok(harness.harness.roots.length >= 1, "the toolbar root is built at publication");
});

// Regression: the host only copies a context-menu root into the menu when the
// live context type matches one of `showOnOptionsType`, or when a checker is
// "All". With no checker the "LaTeX math" submenu never appeared in the real
// document right-click menu (9.4.0.130-1).
test("the context menu root declares a checker so the host offers it", () => {
	const editor = createEditor({ paragraphs: ["$d$"] });
	const harness = createHarness(editor);
	harness.init();

	const root = harness.harness.roots.filter(function (item) {
		return (
			item.parent === null &&
			item.children.some(function (child) {
				return /Convert whole document/i.test(child.text);
			})
		);
	})[0];
	assert.ok(root, "the context menu root exists");
	assert.deepStrictEqual(root.showOnOptionsType, ["All"], "the root opts into every context type");
	assert.strictEqual(root.children.length, 2, "and keeps its two child items");
	// Clicking the parent row must do something: it runs the document-wide
	// conversion. A parent with no handler was dead in the real menu.
	assert.strictEqual(typeof root.onClick, "function", "the root row has a default action");
});

// The host recurses into `childs` through the same checker gate as the root, so
// a parent that passes the gate while its children carry no checker produces an
// EMPTY submenu: the entry is visible, and clicking it does nothing at all.
// Measured live against 9.4.0.130-1, in the document right-click menu.
test("every context menu item passes the host checker gate on its own", () => {
	const editor = createEditor({ paragraphs: ["$d$"] });
	const harness = createHarness(editor);
	harness.init();

	["Selection", "Target", "None"].forEach(function (contextType) {
		const composed = harness.harness.composeContextMenu(contextType);
		const root = composed.items[0];
		assert.ok(root, contextType + ": the LaTeX math entry reaches the host menu");
		assert.strictEqual(root.text, "LaTeX math", contextType + ": with its caption");
		assert.deepStrictEqual(
			root.items.map(function (item) {
				return item.text;
			}),
			["Convert selection", "Convert whole document"],
			contextType + ": and a populated submenu"
		);
	});

	// Each item must also carry its own click handler: the host only attaches a
	// click event for items that registered one.
	const root = harness.harness.roots.filter(function (item) {
		return item.itemType === "contextMenu" && item.parent === null;
	})[0];
	assert.ok(root, "the context menu root was created");
	[root].concat(root.children).forEach(function (item) {
		assert.strictEqual(typeof item.onClick, "function", item.text + " has a click handler");
	});
});

test("an editor round-trip publishes the menus even without onTranslate", () => {	const editor = createEditor({ paragraphs: ["$d$"] });
	const harness = createHarness(editor);
	harness.initOnly();

	// The probe command is answered synchronously by the simulated editor, so
	// the promise chain settles on the microtask queue.
	return Promise.resolve().then(() => {
		assert.strictEqual(harness.harness.toolbarRegistered, true);
	});
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
	const editor = createEditor({ paragraphs: ["$c$"] });
	const harness = createHarness(editor);
	harness.init();
	await harness.convert("document");

	const updates = harness.harness.toolbarUpdates;
	assert.ok(updates.length >= 1, "a menu refresh was sent");
	assert.strictEqual(updates[updates.length - 1].id, harness.harness.roots[0].id);
	assert.strictEqual(updates[updates.length - 1].caption, "LaTeX math");
});

test("the plugin initialises, registers menus and converts through the bridge", async () => {
	const editor = createEditor({
		paragraphs: ["Energy $E = mc^2$ and $a^2+b^2=c^2$.", "Keep $10 and $20."]
	});
	const harness = createHarness(editor);
	harness.init();

	const h = harness.harness;
	assert.strictEqual(h.toolbarRegistered, true);
	assert.strictEqual(h.contextMenuRegistered, true);
	assert.ok(h.roots.length >= 1, "a toolbar root was created");
	assert.ok(h.roots[0].children.length >= 6, "toolbar root has its menu items");
	assert.strictEqual(typeof h.events.onKeyDown, "function");

	const report = await harness.convert("document");

	assert.strictEqual(report.converted, 2);
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["E = mc^2", "a^2+b^2=c^2"]);
	assert.ok(editor.text().includes("$10 and $20."), editor.text());
	assert.strictEqual(h.windows.length, 1, "the report window was shown");
	assert.ok(
		decodeURIComponent(h.windows[0].variation.url).includes("Converted: 2 / 2"),
		decodeURIComponent(h.windows[0].variation.url)
	);
});

test("the hotkey converts only on Ctrl+Alt+M", async () => {
	const editor = createEditor({ paragraphs: ["$h$"] });
	const harness = createHarness(editor);
	harness.init();
	const onKeyDown = harness.harness.events.onKeyDown;

	await onKeyDown({ keyCode: 77, ctrlKey: false, altKey: false, shiftKey: false });
	await onKeyDown({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false });
	await onKeyDown({ keyCode: 65, ctrlKey: true, altKey: true, shiftKey: false });
	assert.strictEqual(editor.maths().length, 0, "only Ctrl+Alt+M may convert");

	await onKeyDown({ keyCode: 77, ctrlKey: true, altKey: true, shiftKey: false });
	assert.strictEqual(editor.maths().length, 1);
});

test("delimiter toggles persist and are honoured", async () => {
	const editor = createEditor({ paragraphs: ["$x$ and \\(y\\)"] });
	const harness = createHarness(editor);
	harness.init();

	const inlineDollarItem = harness.harness.roots[0].children.filter((item) => item.text.includes("$...$"))[0];
	assert.ok(inlineDollarItem, "the $...$ toggle exists");
	inlineDollarItem.click();

	const stored = JSON.parse(harness.window.localStorage.getItem("onlyoffice-latex-math.settings"));
	assert.strictEqual(stored.inlineDollar, false);

	await harness.convert("document");
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["y"]);
	assert.ok(editor.text().includes("$x$"), editor.text());
});

test("report window can be disabled through settings", async () => {
	const editor = createEditor({ paragraphs: ["$q$"] });
	const harness = createHarness(editor);
	harness.window.localStorage.setItem(
		"onlyoffice-latex-math.settings",
		JSON.stringify({ openReport: false })
	);
	harness.init();
	await harness.convert("document");
	assert.strictEqual(harness.harness.windows.length, 0);
	assert.strictEqual(editor.maths().length, 1, "conversion still happens");
});
