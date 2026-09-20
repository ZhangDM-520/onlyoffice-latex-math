"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const core = require(path.join(__dirname, "..", "plugin", "scripts", "scan.js"));
const { findMathSpans, planReplacements, collectParagraphs } = core;

function latexOf(result) {
	return result.spans.map((span) => span.latex);
}

test("inline $...$ is detected and marked inline", () => {
	const result = findMathSpans("Given $x^2 + y^2 = z^2$ we are done.");
	assert.deepStrictEqual(latexOf(result), ["x^2 + y^2 = z^2"]);
	assert.strictEqual(result.spans[0].display, false);
	assert.strictEqual(result.spans[0].start, 6);
	assert.strictEqual(result.spans[0].raw, "$x^2 + y^2 = z^2$");
});

test("multiple inline spans are all detected in order", () => {
	const result = findMathSpans("Let $a$ and $b$ plus $c$.");
	assert.deepStrictEqual(latexOf(result), ["a", "b", "c"]);
});

test("$$...$$ is display math and may span lines", () => {
	const result = findMathSpans("Before\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$\nAfter");
	assert.deepStrictEqual(latexOf(result), ["\\int_0^1 x\\,dx = \\frac{1}{2}"]);
	assert.strictEqual(result.spans[0].display, true);
});

test("$$...$$ newlines collapse into spaces", () => {
	const result = findMathSpans("$$\na + b\n$$");
	assert.deepStrictEqual(latexOf(result), ["a + b"]);
});

test("$$ takes precedence over $ so nested content is not split", () => {
	const result = findMathSpans("$$\\sum_{i=0}^{n} a_i$$");
	assert.strictEqual(result.spans.length, 1);
	assert.strictEqual(result.spans[0].open, "$$");
	assert.strictEqual(result.spans[0].latex, "\\sum_{i=0}^{n} a_i");
});

test("\\(...\\) is inline math", () => {
	const result = findMathSpans("Area \\(\\pi r^2\\) grows fast.");
	assert.deepStrictEqual(latexOf(result), ["\\pi r^2"]);
	assert.strictEqual(result.spans[0].display, false);
});

test("\\[...\\] is display math", () => {
	const result = findMathSpans("Then\n\\[\\lim_{x\\to 0}\\frac{\\sin x}{x} = 1\\]\nDone");
	assert.deepStrictEqual(latexOf(result), ["\\lim_{x\\to 0}\\frac{\\sin x}{x} = 1"]);
	assert.strictEqual(result.spans[0].display, true);
});

test("escaped \\$ does not open a span", () => {
	const result = findMathSpans("Price is \\$5 for one \\$6 for two.");
	assert.deepStrictEqual(result.spans, []);
	assert.deepStrictEqual(result.warnings, []);
});

test("escaped dollar inside math stays inside the span", () => {
	const result = findMathSpans("Total $a\\$b$ ok.");
	assert.deepStrictEqual(latexOf(result), ["a\\$b"]);
});

test("doubled backslash before $ means a real delimiter", () => {
	const result = findMathSpans("Row \\\\$x$ end");
	assert.deepStrictEqual(latexOf(result), ["x"]);
});

test("currency amounts are not treated as math", () => {
	const text = "It costs $10 today, $20 tomorrow and $30 later.";
	const result = findMathSpans(text);
	assert.deepStrictEqual(result.spans, []);
});

test("a lone currency amount is skipped and reported as unterminated", () => {
	const result = findMathSpans("Pay $100 now.");
	assert.deepStrictEqual(result.spans, []);
	assert.deepStrictEqual(
		result.warnings.map((warning) => warning.code),
		["unterminated-inline-dollar"]
	);
});

test("dollar followed by whitespace is not an opener", () => {
	const result = findMathSpans("Cost $ 5 and 6$ total.");
	assert.deepStrictEqual(result.spans, []);
});

test("closing dollar preceded by whitespace is rejected", () => {
	const result = findMathSpans("$x + y $");
	assert.deepStrictEqual(result.spans, []);
});

test("inline math never spans a newline", () => {
	const result = findMathSpans("$x +\ny$");
	assert.deepStrictEqual(result.spans, []);
	assert.strictEqual(result.warnings.length, 1);
});

test("empty spans are rejected", () => {
	assert.deepStrictEqual(findMathSpans("$$$$").spans, []);
	assert.deepStrictEqual(findMathSpans("$$   $$").spans, []);
});

test("unterminated display delimiter reports a warning", () => {
	const result = findMathSpans("$$\\frac{1}{2}");
	assert.deepStrictEqual(result.spans, []);
	assert.strictEqual(result.warnings[0].code, "unterminated-display-dollar");
});

test("unterminated \\( reports a warning", () => {
	const result = findMathSpans("left \\(x + y");
	assert.deepStrictEqual(result.spans, []);
	assert.strictEqual(result.warnings[0].code, "unterminated-inline-paren");
});

test("an unterminated delimiter does not swallow later valid spans", () => {
	const result = findMathSpans("$ broken $ then $ok$");
	assert.deepStrictEqual(latexOf(result), ["ok"]);
});

test("disabled delimiters are ignored", () => {
	const text = "a $x$ b $$y$$ c \\(z\\) d \\[w\\]";
	assert.deepStrictEqual(latexOf(findMathSpans(text, { delimiters: { inlineDollar: false, displayDollar: false } })), [
		"z",
		"w"
	]);
	assert.deepStrictEqual(
		latexOf(findMathSpans(text, { delimiters: { inlineParen: false, displayBracket: false } })),
		["x", "y"]
	);
});

test("forceDisplay upgrades every span to display math", () => {
	const result = findMathSpans("a $x$ and $$y$$", { forceDisplay: true });
	assert.deepStrictEqual(
		result.spans.map((span) => span.display),
		[true, true]
	);
});

test("currencyGuard can be turned off", () => {
	const result = findMathSpans("$5 and $6", { currencyGuard: false });
	assert.deepStrictEqual(latexOf(result), []);
	// The closer is now accepted, but the span stays a single line and non-empty.
	const contiguous = findMathSpans("$5+$6", { currencyGuard: false });
	assert.deepStrictEqual(latexOf(contiguous), ["5+"]);
});

test("LaTeX with braces, subscripts and commands survives intact", () => {
	const latex = "\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i^{(k)}";
	const result = findMathSpans("Value $" + latex + "$ here.");
	assert.deepStrictEqual(latexOf(result), [latex]);
});

test("spans with unicode text around them keep correct offsets", () => {
	const text = "δ-ε 定义 $|x-a|<\\delta$ 结束";
	const result = findMathSpans(text);
	assert.strictEqual(result.spans.length, 1);
	assert.strictEqual(text.substring(result.spans[0].start, result.spans[0].end), "$|x-a|<\\delta$");
});

test("planReplacements maps paragraph offsets to document offsets", () => {
	const paragraphs = [
		{ start: 0, text: "Intro $a$ here." },
		{ start: 50, text: "Second $$b+c$$ line." }
	];
	const plan = planReplacements(paragraphs);
	assert.deepStrictEqual(
		plan.operations.map((op) => [op.start, op.end, op.latex, op.display]),
		[
			[57, 64, "b+c", true],
			[6, 9, "a", false]
		]
	);
});

test("planReplacements sorts operations in reverse document order", () => {
	const paragraphs = [
		{ start: 0, text: "$a$ $b$ $c$" }
	];
	const plan = planReplacements(paragraphs);
	const starts = plan.operations.map((op) => op.start);
	assert.deepStrictEqual(starts, [...starts].sort((a, b) => b - a));
});

test("planReplacements honours a selection filter and reports skipped spans", () => {
	const paragraphs = [{ start: 100, text: "$a$ middle $b$ end $c$" }];
	const plan = planReplacements(paragraphs, null, { start: 111, end: 114 });
	assert.deepStrictEqual(
		plan.operations.map((op) => op.latex),
		["b"]
	);
	assert.deepStrictEqual(
		plan.skipped.map((op) => op.reason),
		["outside-selection", "outside-selection"]
	);
});

test("planReplacements surfaces scanner warnings with absolute offsets", () => {
	const paragraphs = [{ start: 10, text: "bad $x" }];
	const plan = planReplacements(paragraphs);
	assert.strictEqual(plan.warnings.length, 1);
	assert.strictEqual(plan.warnings[0].absoluteIndex, 14);
	assert.strictEqual(plan.warnings[0].paragraphIndex, 0);
});

test("empty and non-string inputs are handled", () => {
	assert.deepStrictEqual(findMathSpans("").spans, []);
	assert.deepStrictEqual(findMathSpans(null).spans, []);
	assert.deepStrictEqual(findMathSpans(undefined).spans, []);
	assert.deepStrictEqual(planReplacements(null).operations, []);
});

test("scientific prose with stray dollars does not produce garbage spans", () => {
	const text = "Cost in USD ($) is fine, and 5$ off too.";
	const result = findMathSpans(text);
	assert.deepStrictEqual(result.spans, []);
});

// ---------------------------------------------------------------------------
// collectParagraphs: the offset filter that used to reject the whole document.
//
// The host counts positions in a paragraph range but returns characters from
// GetText(): empty/formatting positions render as nothing and the trailing
// paragraph mark renders as CRLF, so `end - start === text.length` is false for
// ordinary prose too. Gating on that comparison reported "Scanned: 0 paragraphs"
// for a document whose only content was `$$x=1$$`. Safety comes from the apply
// step re-reading each span (see integration.test.js), not from this filter.
// ---------------------------------------------------------------------------

test("collectParagraphs keeps a paragraph whose length comparison fails", () => {
	const snapshot = {
		paragraphs: [
			// Measured on onlyoffice-git 9.4.0.130: 8 content characters, 11
			// positions, and the mark in the text.
			{ start: 24, end: 35, text: " $$x=1$$\r\n", aligned: false }
		]
	};
	const collected = collectParagraphs(snapshot);
	assert.strictEqual(collected.unusable, 0);
	assert.deepStrictEqual(collected.paragraphs, [{ start: 24, text: " $$x=1$$\r\n" }]);
});

test("collectParagraphs still reports a paragraph that cannot be read", () => {
	const snapshot = {
		paragraphs: [{ start: null, end: null, text: "", aligned: false }, { start: 5, text: "$a$" }]
	};
	const collected = collectParagraphs(snapshot);
	assert.strictEqual(collected.unusable, 1);
	assert.strictEqual(collected.paragraphs.length, 1);
});

test("a paragraph with an unprovable offset still yields its spans", () => {
	const snapshot = { paragraphs: [{ start: 10, end: 40, text: "a $x$ b", aligned: false }] };
	const collected = collectParagraphs(snapshot);
	const plan = planReplacements(collected.paragraphs);
	assert.deepStrictEqual(
		plan.operations.map((op) => ({ start: op.start, end: op.end, latex: op.latex, expected: op.expected })),
		[{ start: 12, end: 15, latex: "x", expected: "$x$" }]
	);
});
