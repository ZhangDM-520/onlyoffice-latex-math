/*
 * The Alt+L hotkey.
 *
 * There is no plugin shortcut API in this build, and the host's own key event is
 * not a shortcut channel: the word editor only calls
 * `g_asc_plugins.onPluginEvent2("onKeyDown", ...)` from the `isInputHelpersPresent`
 * branch of its key handler, i.e. while a form/content-control input helper owns
 * the keyboard, and only for navigation keys. So the plugin listens to the
 * editor's document itself, which it can reach because its frame is a child of
 * the editor's main frame (`parent.document`, plan section 2.2).
 *
 * The rule set below exists because of a measurement, not a guess (plan 2.3). A
 * REAL `Alt+L` - injected at the X11 level and logged from a capture-phase
 * listener - arrives as
 *
 *     Alt    keyCode 18  altKey TRUE      <- the modifier, on its own event
 *     l      keyCode 76  altKey FALSE     <- every modifier flag false
 *
 * and that `l` is then INSERTED INTO THE DOCUMENT as text. Chromium consumes the
 * modifiers on the way to the page. Two consequences:
 *
 *   1. a chord must be recognised from the modifier keydown that precedes it, and
 *      the modifier set must match the binding EXACTLY - a `keyCode === 76` test
 *      would fire on every `l` the user types, and an `event.altKey` test would
 *      never fire at all;
 *   2. a claimed key must be swallowed (`stopPropagation` + `preventDefault`), or
 *      every conversion leaves a stray letter behind.
 *
 * `pressAltChord` in the harness replays exactly that sequence.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { createEditor } = require(path.join(__dirname, "fake-editor.js"));
const { createHarness } = require(path.join(__dirname, "plugin-harness.js"));

const CHORD = { key: "l", code: "KeyL", keyCode: 76 };

/** Lets the promise chain a fired conversion runs on finish. */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function pressedChord(harness) {
	return harness.pressAltChord(CHORD.code, CHORD.key);
}

// ---------------------------------------------------------------------------
// The matcher on its own: the rule set, including the parts a DOM test cannot
// reach (the clock, and sequences a real keyboard cannot produce).
// ---------------------------------------------------------------------------

test("the matcher converts on Alt then L with every modifier flag false", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	const matcher = harness.createHotkeyMatcher();

	let now = 1000;
	assert.strictEqual(matcher.keydown({ key: "Alt", code: "AltLeft" }, now), null, "a modifier is never claimed");
	assert.strictEqual(matcher.keydown({ key: "l", code: "KeyL" }, (now += 50)), "selection");
});

test("the matcher uses the reported modifiers when the host sends them", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	const matcher = harness.createHotkeyMatcher();

	// A host that does not consume the modifier (a browser build, or CDP input).
	assert.strictEqual(matcher.keydown({ key: "l", code: "KeyL", altKey: true }, 1), "selection");
});

test("the matcher ignores a key with no modifier, and clears what was armed", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	const matcher = harness.createHotkeyMatcher();

	assert.strictEqual(matcher.keydown({ key: "l", code: "KeyL" }, 1), null, "a plain `l` is the user's");
	// The armed state is spent by the key that followed it.
	assert.strictEqual(matcher.keydown({ key: "Alt", code: "AltLeft" }, 2), null);
	assert.strictEqual(matcher.keydown({ key: "z", code: "KeyZ" }, 3), null, "an intervening key breaks the chord");
	assert.strictEqual(matcher.keydown({ key: "l", code: "KeyL" }, 4), null);
});

test("the matcher requires the modifier set to match exactly", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	const matcher = harness.createHotkeyMatcher();

	const cases = [
		{ key: "Control", code: "ControlLeft" }, // then l -> Ctrl+L must stay the editor's
		{ key: "Shift", code: "ShiftLeft" }, // then l -> Shift+Alt+L is not our binding
		{ key: "Meta", code: "MetaLeft" } // then l
	];
	cases.forEach((modifier) => {
		matcher.reset();
		matcher.keydown(modifier, 10);
		matcher.keydown({ key: "Alt", code: "AltLeft" }, 10);
		assert.strictEqual(
			matcher.keydown({ key: "l", code: "KeyL" }, 10),
			null,
			"Alt plus " + modifier.key + " is not Alt+L"
		);
	});
});

test("the matcher ignores a repeat, AltGraph, and a stale modifier", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	const matcher = harness.createHotkeyMatcher();

	matcher.keydown({ key: "Alt", code: "AltLeft" }, 1000);
	assert.strictEqual(matcher.keydown({ key: "l", code: "KeyL", repeat: true }, 1000), null, "auto-repeat");

	matcher.reset();
	matcher.keydown({ key: "Alt", code: "AltLeft" }, 1000);
	assert.strictEqual(
		matcher.keydown(
			{
				key: "l",
				code: "KeyL",
				// On layouts that type with AltGr, Chromium reports it as its own modifier
				// state - it must never be read as an Alt chord.
				getModifierState: function (name) {
					return name === "AltGraph";
				}
			},
			1000
		),
		null,
		"AltGr types characters on some layouts"
	);

	// A modifier keyup the plugin never saw must not leave a chord armed forever.
	matcher.reset();
	matcher.keydown({ key: "Alt", code: "AltLeft" }, 2000);
	assert.strictEqual(matcher.keydown({ key: "l", code: "KeyL" }, 2000 + 1501), null, "stale");
	assert.strictEqual(matcher.keydown({ key: "l", code: "KeyL" }, 5000), null);
});

test("the matcher disarms on the modifier keyup", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	const matcher = harness.createHotkeyMatcher();

	matcher.keydown({ key: "Alt", code: "AltLeft" }, 1);
	matcher.keyup({ key: "Alt", code: "AltLeft" });
	assert.strictEqual(matcher.armed(2).length, 0, "nothing is armed after the keyup");
	assert.strictEqual(matcher.keydown({ key: "l", code: "KeyL" }, 2), null);
});

// ---------------------------------------------------------------------------
// Through the document listener the plugin installs in the editor's frame.
// ---------------------------------------------------------------------------

test("the chord converts the selection and is swallowed before the editor sees it", async () => {
	const editor = createEditor({
		paragraphs: ["Keep $a$ and $b$ here."],
		selection: { start: 5, end: 8 }
	});
	const harness = createHarness(editor);
	harness.init();

	const { chord } = pressedChord(harness);
	await settle();

	assert.strictEqual(chord.stopped, true, "stopPropagation keeps the SDK from receiving the key");
	assert.strictEqual(chord.prevented, true, "preventDefault keeps it out of the document");
	assert.strictEqual(editor.maths().length, 1, "one equation");
	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["a"]);
	assert.ok(editor.text().includes("$b$"), "the span outside the selection is untouched");
	assert.ok(editor.text().includes("Keep " + "a" + " and"), editor.text());
});

test("a plain letter is never claimed, and never converted", async () => {
	const editor = createEditor({ paragraphs: ["$a$ and $b$"], selection: { start: 0, end: 3 } });
	const harness = createHarness(editor);
	harness.init();

	const keys = [
		{ key: "l", code: "KeyL", keyCode: 76 },
		{ key: "m", code: "KeyM", keyCode: 77 }
	];
	keys.forEach((key) => {
		const event = harness.pressKey(key);
		assert.strictEqual(event.stopped, false, key.key + " must reach the editor");
		assert.strictEqual(event.prevented, false, key.key + " must not be swallowed");
	});

	// Ctrl+L is the editor's own shortcut and must not be turned into a conversion.
	harness.pressKey({ key: "Control", code: "ControlLeft" });
	const ctrlL = harness.pressKey({ key: "l", code: "KeyL" });
	harness.releaseKey({ key: "Control", code: "ControlLeft" });
	assert.strictEqual(ctrlL.stopped, false, "Ctrl+L is not ours");

	// Ctrl+Alt+M used to be this plugin's binding, dead in this build; it is gone.
	harness.pressKey({ key: "Control", code: "ControlLeft" });
	harness.pressKey({ key: "Alt", code: "AltLeft" });
	const ctrlAltM = harness.pressKey({ key: "m", code: "KeyM" });
	harness.releaseKey({ key: "Alt", code: "AltLeft" });
	harness.releaseKey({ key: "Control", code: "ControlLeft" });
	assert.strictEqual(ctrlAltM.stopped, false, "the removed binding must not fire");

	await settle();
	assert.strictEqual(editor.maths().length, 0, "nothing converted");
	assert.deepStrictEqual(editor.state.insertedMath, []);
});

test("one physical chord converts exactly once", async () => {
	const editor = createEditor({ paragraphs: ["$a$"], selection: { start: 0, end: 3 } });
	const harness = createHarness(editor);
	harness.init();

	pressedChord(harness);
	// A held key auto-repeats: the letters keep arriving with no new modifier.
	harness.pressKey({ key: "l", code: "KeyL", keyCode: 76, repeat: true });
	harness.pressKey({ key: "l", code: "KeyL", keyCode: 76, repeat: true });
	await settle();

	assert.strictEqual(editor.state.insertedMath.length, 1, editor.state.insertedMath.length + " conversions");
	assert.strictEqual(harness.getLastReport().converted, 1);
});

test("Alt+L with a collapsed selection converts nothing", async () => {
	// The owner's decision: no fallback to the whole document. `Ctrl+A` then the
	// chord is the whole-document route (asserted below).
	const editor = createEditor({ paragraphs: ["$a$ and $b$"] });
	const harness = createHarness(editor);
	harness.init();

	const { chord } = pressedChord(harness);
	await settle();

	assert.strictEqual(chord.stopped, true, "the chord is still claimed, or the `l` would be typed");
	assert.strictEqual(editor.maths().length, 0);
	assert.ok(editor.text().includes("$a$"), editor.text());
	assert.ok(
		harness
			.getLastReport()
			.lines.some((line) => line.includes("Select the text to convert first")),
		JSON.stringify(harness.getLastReport().lines)
	);
});

test("Ctrl+A then the chord converts the whole document", async () => {
	const body = "One $x$ two $y$ three";
	const editor = createEditor({ paragraphs: [body] });
	const harness = createHarness(editor);
	harness.init();

	// What the editor reports after a real select-all: a selection over everything.
	editor.state.selection = { start: 0, end: body.length };
	pressedChord(harness);
	await settle();

	assert.deepStrictEqual(editor.maths().map((math) => math.latex), ["x", "y"]);
	assert.ok(!editor.text().includes("$"), editor.text());
});

test("the hotkey respects the silent-report setting", async () => {
	const editor = createEditor({ paragraphs: ["$a$"], selection: { start: 0, end: 3 } });
	const silent = createHarness(editor);
	silent.init();
	pressedChord(silent);
	await settle();
	assert.strictEqual(silent.harness.windows.length, 0, "silent by default");

	const loudEditor = createEditor({ paragraphs: ["$a$"], selection: { start: 0, end: 3 } });
	const loud = createHarness(loudEditor);
	loud.window.localStorage.setItem("onlyoffice-latex-math.settings", JSON.stringify({ version: 2, openReport: true }));
	loud.init();
	pressedChord(loud);
	await settle();
	assert.strictEqual(loud.harness.windows.length, 1, "the menu toggle brings the report back");
	assert.ok(decodeURIComponent(loud.harness.windows[0].variation.url).includes("Converted: 1 / 1"));
});

test("the listener is attached once per document, however often init runs", async () => {
	const editor = createEditor({ paragraphs: ["$a$"], selection: { start: 0, end: 3 } });
	const harness = createHarness(editor);
	harness.init();
	const after = harness.listenerCounts();

	harness.init(); // the host can send init again
	harness.attachHotkeys(); // and the console can re-run the attach
	assert.deepStrictEqual(harness.listenerCounts(), after);
	assert.strictEqual(harness.getHotkeyStatus().attached, 2, "editor frame and its parent, once each");
	assert.deepStrictEqual(
		after.map((entry) => entry.label + ":" + entry.keydown),
		["editor:1", "api:1"],
		"the walk reaches the editor frame and the frame above it"
	);

	pressedChord(harness);
	await settle();
	assert.strictEqual(editor.state.insertedMath.length, 1, "one chord, one conversion");
});

test("a host that blocks the parent frame degrades instead of breaking", () => {
	const editor = createEditor({ paragraphs: ["$a$"] });
	const harness = createHarness(editor, { parentAccessThrows: true });

	harness.init();

	const status = harness.getHotkeyStatus();
	assert.strictEqual(status.attached, 0, "nothing could be reached");
	assert.strictEqual(JSON.stringify(status.chords), '["Alt+L"]', "the binding is still declared");
	// Everything else still works.
	assert.strictEqual(harness.harness.toolbarRegistered, true, "the menus are published anyway");
	assert.strictEqual(harness.harness.contextMenuRegistered, true);
	assert.ok(harness.harness.roots.length >= 1);
	// And there is no listener to press.
	assert.strictEqual(harness.pressKey({ key: "l", code: "KeyL" }).stopped, false);
});
