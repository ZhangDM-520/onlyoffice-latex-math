"use strict";

/*
 * The placement seam: a span lives in character coordinates (scan.js); where it
 * lives in document-position coordinates - proven by the probe behind
 * `resolve`, or guessed by the arithmetic fallback - is locate.js's answer.
 *
 * These tests drive `locate.plan` with a stub resolver that resolves nothing,
 * i.e. the pure arithmetic path every offset takes when no probe proof exists.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const locate = require(path.join(__dirname, "..", "plugin", "scripts", "locate.js"));

const PLUGIN_DEFAULTS = {
	delimiters: { inlineDollar: true, displayDollar: true, inlineParen: true, displayBracket: true },
	currencyGuard: true
};

// The stub arithmetic resolver: answers the probe-shaped question with "no
// proof", so every placement falls back to `paragraph.start + charOffset`.
function arithmeticResolver() {
	return Promise.resolve([]);
}

function planOf(snapshot, filter, resolve) {
	return locate.plan(snapshot, PLUGIN_DEFAULTS, filter || null, resolve || arithmeticResolver);
}

test("plan maps paragraph offsets to document offsets", async () => {
	const snapshot = {
		paragraphs: [
			{ start: 0, text: "Intro $a$ here." },
			{ start: 50, text: "Second $$b+c$$ line." }
		]
	};
	const plan = await planOf(snapshot);
	assert.deepStrictEqual(
		plan.operations.map((op) => [op.start, op.end, op.latex, op.display]),
		[
			[57, 64, "b+c", true],
			[6, 9, "a", false]
		]
	);
});

test("plan sorts operations in reverse document order", async () => {
	const snapshot = { paragraphs: [{ start: 0, text: "$a$ $b$ $c$" }] };
	const plan = await planOf(snapshot);
	const starts = plan.operations.map((op) => op.start);
	assert.deepStrictEqual(starts, [...starts].sort((a, b) => b - a));
});

test("plan honours a selection filter and reports skipped spans", async () => {
	const snapshot = { paragraphs: [{ start: 100, text: "$a$ middle $b$ end $c$" }] };
	const plan = await planOf(snapshot, { start: 111, end: 114 });
	assert.deepStrictEqual(
		plan.operations.map((op) => op.latex),
		["b"]
	);
	assert.deepStrictEqual(
		plan.skipped.map((op) => op.reason),
		["outside-selection", "outside-selection"]
	);
});

test("plan surfaces scanner warnings with absolute offsets", async () => {
	const snapshot = { paragraphs: [{ start: 10, text: "bad $x" }] };
	const plan = await planOf(snapshot);
	assert.strictEqual(plan.warnings.length, 1);
	assert.strictEqual(plan.warnings[0].absoluteIndex, 14);
	assert.strictEqual(plan.warnings[0].paragraphIndex, 0);
});

test("empty and non-string inputs are handled", async () => {
	const plan = await planOf(null);
	assert.deepStrictEqual(plan.operations, []);
	assert.strictEqual(plan.unusable, 0);
});

// ---------------------------------------------------------------------------
// collectParagraphs, now folded into plan(): the offset filter that used to
// reject the whole document.
//
// The host counts positions in a paragraph range but returns characters from
// GetText(): empty/formatting positions render as nothing and the trailing
// paragraph mark renders as CRLF, so `end - start === text.length` is false for
// ordinary prose too. Gating on that comparison reported "Scanned: 0 paragraphs"
// for a document whose only content was `$$x=1$$`. Safety comes from the apply
// step re-reads each span (see integration.test.js), not from this filter.
// ---------------------------------------------------------------------------

test("plan keeps a paragraph whose length comparison fails and probes within its range", async () => {
	const snapshot = {
		paragraphs: [
			// Measured on onlyoffice-git 9.4.0.130: 8 content characters, 11
			// positions, and the mark in the text.
			{ start: 24, end: 35, text: " $$x=1$$\r\n" }
		]
	};
	const specs = [];
	const plan = await planOf(snapshot, null, (sent) => {
		specs.push(...sent);
		return Promise.resolve([]);
	});
	assert.strictEqual(plan.unusable, 0);
	assert.strictEqual(plan.operations.length, 1, "the paragraph is still scanned");
	// `end` travels to the probe as its walk bound (`span`), and the offsets the
	// probe must resolve are the span's own char offsets.
	assert.deepStrictEqual(specs, [
		{ index: 0, start: 24, span: 11, text: " $$x=1$$\r\n", need: [1, 8] }
	]);
});

test("plan still reports a paragraph that cannot be read", async () => {
	const snapshot = {
		paragraphs: [{ start: null, end: null, text: "" }, { start: 5, text: "$a$" }]
	};
	const plan = await planOf(snapshot);
	assert.strictEqual(plan.unusable, 1);
	assert.strictEqual(plan.operations.length, 1, "the readable paragraph is kept");
});

test("a paragraph with an unprovable offset still yields its spans", async () => {
	const snapshot = { paragraphs: [{ start: 10, end: 40, text: "a $x$ b" }] };
	const plan = await planOf(snapshot);
	assert.deepStrictEqual(
		plan.operations.map((op) => ({ start: op.start, end: op.end, latex: op.latex, expected: op.expected })),
		[{ start: 12, end: 15, latex: "x", expected: "$x$" }]
	);
});

// ---------------------------------------------------------------------------
// The seam itself: what the probe proves, what falls back, and what counts as
// proof. REPRO row 2's lesson is that a wrong "proven" position is worse than a
// labelled guess - it places the caret on faith - so every map the probe hands
// over is verified before it is believed (see locate.js verifiedPositions).
// ---------------------------------------------------------------------------

// Two spans in one paragraph: `$a$` at char offsets 9..12, `$b$` at 13..16. The
// paragraph's own range is 100..120, so the arithmetic would put them at
// 109..112 and 113..116; a drifted geometry (content items costing extra
// positions) is what the probe map reports instead.
const DRIFTED = { paragraphs: [{ start: 100, end: 120, text: "xxxxxxxxx$a$ $b$" }] };

test("a failing probe falls back to arithmetic instead of refusing to plan", async () => {
	const snapshot = { paragraphs: [{ start: 10, end: 40, text: "a $x$ b" }] };
	const expectations = [{ start: 12, end: 15, placement: "arithmetic" }];

	const rejected = await locate.plan(snapshot, PLUGIN_DEFAULTS, null, () =>
		Promise.reject(new Error("probe-unavailable"))
	);
	assert.deepStrictEqual(
		rejected.operations.map((op) => ({ start: op.start, end: op.end, placement: op.placement })),
		expectations
	);

	const thrown = await locate.plan(snapshot, PLUGIN_DEFAULTS, null, () => {
		throw new Error("probe-unavailable");
	});
	assert.deepStrictEqual(
		thrown.operations.map((op) => ({ start: op.start, end: op.end, placement: op.placement })),
		expectations
	);
});

test("partial resolution: offset 12 proven, 13 not - proven boundaries win, the label stays honest", async () => {
	// The probe proves `$a$`'s whole span (offsets 9 and 12 -> positions 112 and
	// 115) but nothing about `$b$`'s start (offset 13). Each boundary resolves
	// independently: the proven one is used, the other falls back to the
	// arithmetic - and because one boundary is still a guess, the operation is
	// labelled `arithmetic` even where its own start was proven.
	const plan = await locate.plan(DRIFTED, PLUGIN_DEFAULTS, null, () =>
		Promise.resolve([{ index: 0, positions: { 9: 112, 12: 115 } }])
	);
	assert.deepStrictEqual(
		plan.operations.map((op) => [op.latex, op.start, op.end, op.placement]),
		[
			["b", 113, 116, "arithmetic"],
			["a", 112, 115, "probed"]
		]
	);
});

test("a fully proven span is labelled probed", async () => {
	const plan = await locate.plan(DRIFTED, PLUGIN_DEFAULTS, null, () =>
		Promise.resolve([{ index: 0, positions: { 9: 112, 12: 115, 13: 116, 16: 119 } }])
	);
	assert.deepStrictEqual(
		plan.operations.map((op) => [op.latex, op.start, op.end, op.placement]),
		[
			["b", 116, 119, "probed"],
			["a", 112, 115, "probed"]
		]
	);
});

// A map that cannot be true on its own terms discards the whole map: the
// paragraph then plans at the arithmetic positions, labelled as such.
async function plannedAtArithmetic(positions) {
	const plan = await locate.plan(DRIFTED, PLUGIN_DEFAULTS, null, () =>
		Promise.resolve([{ index: 0, positions }])
	);
	return plan.operations.map((op) => [op.latex, op.start, op.end, op.placement]);
}

const ARITHMETIC_ROWS = [
	["b", 113, 116, "arithmetic"],
	["a", 109, 112, "arithmetic"]
];

test("a map with a non-number position is not proof", async () => {
	assert.deepStrictEqual(await plannedAtArithmetic({ 9: "112", 12: 115 }), ARITHMETIC_ROWS);
	assert.deepStrictEqual(await plannedAtArithmetic({ 9: 112, 12: NaN }), ARITHMETIC_ROWS);
});

test("a map pointing outside the paragraph's own range is not proof", async () => {
	// Out of range value: a position in a foreign paragraph.
	assert.deepStrictEqual(await plannedAtArithmetic({ 9: 112, 12: 500 }), ARITHMETIC_ROWS);
	// Out of range key: a char offset the paragraph's text does not have.
	assert.deepStrictEqual(await plannedAtArithmetic({ 50: 112 }), ARITHMETIC_ROWS);
	assert.deepStrictEqual(await plannedAtArithmetic({ 1.5: 112 }), ARITHMETIC_ROWS);
});

test("a non-monotonic map is not proof", async () => {
	assert.deepStrictEqual(await plannedAtArithmetic({ 9: 115, 12: 112 }), ARITHMETIC_ROWS);
	assert.deepStrictEqual(await plannedAtArithmetic({ 9: 112, 12: 112 }), ARITHMETIC_ROWS);
});

test("a non-object map is not proof", async () => {
	assert.deepStrictEqual(await plannedAtArithmetic([112, 115]), ARITHMETIC_ROWS);
});

test("a map from a foreign paragraph is not proof", async () => {
	const plan = await locate.plan(DRIFTED, PLUGIN_DEFAULTS, null, () =>
		Promise.resolve([{ index: 3, positions: { 9: 112, 12: 115, 13: 116, 16: 119 } }])
	);
	assert.deepStrictEqual(
		plan.operations.map((op) => [op.latex, op.start, op.end, op.placement]),
		ARITHMETIC_ROWS
	);
});

test("a paragraph with no range end can carry no proof and falls back", async () => {
	// `end` is the probe's walk bound *and* the only range a position can be
	// checked against: without it the map is unverifiable even when a pushy
	// adapter hands one over.
	const snapshot = { paragraphs: [{ start: 10, text: "a $x$ b" }] };
	const plan = await locate.plan(snapshot, PLUGIN_DEFAULTS, null, () =>
		Promise.resolve([{ index: 0, positions: { 2: 22, 5: 25 } }])
	);
	assert.deepStrictEqual(
		plan.operations.map((op) => [op.start, op.end, op.placement]),
		[[12, 15, "arithmetic"]]
	);
});

test("a plan with nothing to verify never reaches the probe", async () => {
	// verify()'s budget: re-reading the document already costs a round trip, and
	// a plan without spans has nothing the probe could place.
	let calls = 0;
	const plan = await locate.plan({ paragraphs: [{ start: 0, text: "plain prose" }] }, PLUGIN_DEFAULTS, null, () => {
		calls++;
		return Promise.resolve([]);
	});
	assert.strictEqual(calls, 0);
	assert.deepStrictEqual(plan.operations, []);
	assert.deepStrictEqual(plan.warnings, []);
	assert.strictEqual(plan.unusable, 0);
});
