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

// rule: DP-refused-canStart — the refused `$` is re-read only when it can start
// math. Here it sits at end of line, so `canStartInlineMath` refuses and the
// step-past stands (kept for intent: the loop lands in the same place either way).
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

// The blank-line rule is stated in the README ("spans across a blank line are
// left untouched"), so it is enforced rather than merely claimed: a display span
// may wrap a soft line break, never an empty line.
test("a display span survives a soft line break but not a blank line", () => {
	assert.deepStrictEqual(latexOf(findMathSpans("$$\na + b\n$$")), ["a + b"]);

	const blank = findMathSpans("$$a\n\nb$$");
	assert.deepStrictEqual(blank.spans, []);
	assert.strictEqual(blank.warnings[0].code, "unterminated-display-dollar");
});

test("\\(...\\) is inline, so it never spans a line either", () => {
	const result = findMathSpans("left \\(x +\ny\\) right");
	assert.deepStrictEqual(result.spans, []);
	assert.strictEqual(result.warnings[0].code, "unterminated-inline-paren");
});

// An empty body is a malformed span on *every* delimiter; reporting it on only
// one of the four left three silent no-ops in the document.
// rule: DP-closer-0 — the inline `$$x$` case below is where the pairing rule's
// non-empty-body condition keeps `empty-span` as the accurate diagnosis.
test("an empty body is reported on every delimiter", () => {
	assert.ok(findMathSpans("$$$$").warnings.some((w) => w.code === "empty-span"));
	assert.deepStrictEqual(
		findMathSpans("\\(\\)").warnings.map((w) => w.code),
		["empty-span"]
	);
	assert.deepStrictEqual(
		findMathSpans("\\[\\]").warnings.map((w) => w.code),
		["empty-span"]
	);
	// And on the inline path: with `$$` switched off the second dollar opens an
	// inline span whose first closer is the one it is sitting on.
	const inline = findMathSpans("$$x$", { delimiters: { displayDollar: false } });
	assert.strictEqual(inline.warnings[0].code, "empty-span");
	assert.deepStrictEqual(latexOf(inline), ["x"]);
});

// Guards for the decisions in `docs/NOTE.md`: the currency guard is deliberately
// *not* relaxed, and a rejected closer must not poison the rest of the line.
test("a currency run cannot drag a later real span into math", () => {
	assert.deepStrictEqual(latexOf(findMathSpans("Costs $5 and $6 plus $x$ here.")), ["x"]);
});

test("a whitespace-preceded closer abandons its opener without poisoning the line", () => {
	assert.deepStrictEqual(latexOf(findMathSpans("The price $x + y $ and $z$ here.")), ["z"]);
});

// The shape a real paragraph arrives in: a leading space and a trailing CRLF
// paragraph mark (see the `$$x=1$$` incident in docs/NOTE.md).
test("a paragraph's trailing CRLF does not hide its display span", () => {
	const result = findMathSpans(" $$x=1$$\r\n");
	assert.deepStrictEqual(latexOf(result), ["x=1"]);
	assert.strictEqual(result.spans[0].display, true);
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
			{ start: 24, end: 35, text: " $$x=1$$\r\n" }
		]
	};
	const collected = collectParagraphs(snapshot);
	assert.strictEqual(collected.unusable, 0);
	// `end` now travels too: it is the bound for the char -> position probe
	// (REPRO row 2), and the paragraph itself is still kept.
	assert.deepStrictEqual(collected.paragraphs, [{ start: 24, end: 35, text: " $$x=1$$\r\n" }]);
});

test("collectParagraphs still reports a paragraph that cannot be read", () => {
	const snapshot = {
		paragraphs: [{ start: null, end: null, text: "" }, { start: 5, text: "$a$" }]
	};
	const collected = collectParagraphs(snapshot);
	assert.strictEqual(collected.unusable, 1);
	assert.strictEqual(collected.paragraphs.length, 1);
});

test("a paragraph with an unprovable offset still yields its spans", () => {
	const snapshot = { paragraphs: [{ start: 10, end: 40, text: "a $x$ b" }] };
	const collected = collectParagraphs(snapshot);
	const plan = planReplacements(collected.paragraphs);
	assert.deepStrictEqual(
		plan.operations.map((op) => ({ start: op.start, end: op.end, latex: op.latex, expected: op.expected })),
		[{ start: 12, end: 15, latex: "x", expected: "$x$" }]
	);
});

// ---------------------------------------------------------------------------
// The opener blacklist, recorded rather than left implicit.
//
// `CANNOT_START_MATH` keeps prose like "Cost in USD ($) is fine" from becoming a
// span, and `canStartInlineMath` additionally refuses whitespace right after the
// opener. Both are deliberately *not* extended further: the project's rule is that
// nothing downstream catches a mistake (see docs/NOTE.md §1.8), so the two
// decisions below were taken with the measured behaviour in hand and are pinned
// here so a later change has to face them.
// ---------------------------------------------------------------------------

// rule: DP-closer-a — pins `canStartInlineMath`, the predicate the pairing rule
// reuses for a candidate closer: a `$` followed by punctuation has nothing to open.
test("punctuation right after an opener is not math, but a bracket is fine", () => {
	// The blacklist. Every one of these is a `$` doing duty as a currency symbol
	// or a stray character, not a delimiter.
	["Cost in USD ($) is fine.", "Total ($): 5", "See $, then", "Ends with $.", 'A $"quote$', "Is it $?"].forEach(
		function (text) {
			assert.deepStrictEqual(findMathSpans(text).spans, [], JSON.stringify(text));
		}
	);

	// A bracket *open* after the opener is still math: "Note($i$)" reads as a
	// parenthesised symbol, and rejecting it would cost real recall.
	assert.deepStrictEqual(latexOf(findMathSpans("Note($i$) matters.")), ["i"]);
});

test("whitespace right after an opener is never math", () => {
	assert.deepStrictEqual(findMathSpans("Cost $ 5 and 6$ total.").spans, []);
	assert.deepStrictEqual(findMathSpans("Prices in $ USD fall.").spans, []);
});

// Measured, and deliberately left as-is. An opener has no rule about the
// character *before* it, so `x$y$z` is read as math. Adding one would also reject
// `text=$x$`, which is a plausible thing for an author to write; the guard is
// therefore not extended without a demonstrated failure.
test("an opener with no context rule is accepted, and that is deliberate", () => {
	assert.deepStrictEqual(latexOf(findMathSpans("x$y$z")), ["y"]);
	assert.deepStrictEqual(latexOf(findMathSpans("f(x)$=y$ holds.")), ["=y"]);
	// The counter-example the rule would have to keep: no space before the opener.
	assert.deepStrictEqual(latexOf(findMathSpans("the value is$x$ here.")), ["x"]);
});

test("a guard rejection is reported as guarded, not as a malformed delimiter", () => {
	// "Pay $100 now." has a single `$` and no closer at all, so it really is
	// unterminated and stays in the malformed bucket.
	assert.deepStrictEqual(
		findMathSpans("Pay $100 now.").warnings.map((w) => w.code),
		["unterminated-inline-dollar"]
	);

	// A *pair* the currency guard refused is the guard working: an author should
	// not be told their LaTeX is broken when their document contains prices.
	const prices = findMathSpans("Cost $5, save $2, math $x$ here.");
	assert.deepStrictEqual(latexOf(prices), ["x"]);
	assert.ok(
		prices.warnings.every((w) => w.code === "guarded-inline-dollar"),
		JSON.stringify(prices.warnings)
	);

	const amounts = findMathSpans("Amount: $10-$20 total.");
	assert.deepStrictEqual(amounts.spans, []);
	assert.ok(
		amounts.warnings.every((w) => w.code === "guarded-inline-dollar"),
		JSON.stringify(amounts.warnings)
	);
});

test("a closer after a trailing space is guarded, not unterminated", () => {
	const result = findMathSpans("The price $x + y $ and $z$ here.");
	assert.deepStrictEqual(latexOf(result), ["z"]);
	assert.strictEqual(result.warnings[0].code, "guarded-inline-dollar");
});

// ---------------------------------------------------------------------------
// The stolen opener. Reported by a reader of ONLYOFFICE/DesktopEditors#2062:
// a price earlier in the sentence can steal the *opening* `$` of a real
// expression that follows. The closer guards only ever inspected the candidate
// itself, never the `$` being taken from someone else, so `value=$x$` was
// destroyed with no warning at all — worse than the false positives above,
// because this one eats correct math.
// ---------------------------------------------------------------------------

// rule: DP-closer-c (the nested close is what lets the rule fire and save `x`)
// rule: DP-closer-w/rej-spaceless-body — counter-example `value=$x$`: the steal
// has a whitespace-bearing body, so "require a spaceless body" would miss it.
test("an unmatched $ does not steal the opener of a real expression", () => {
	[
		["price $5 and$x$ here", ["x"]],
		["It costs $5, and the value=$x$ here.", ["x"]],
		["Cost $5, and result=$x+1$ holds.", ["x+1"]]
	].forEach(([text, expected]) => {
		const result = findMathSpans(text);
		assert.deepStrictEqual(latexOf(result), expected, text);
		assert.deepStrictEqual(
			result.warnings.map((warning) => warning.code),
			["guarded-inline-dollar"],
			text
		);
	});
});

// Parity is what makes the rule fire at all, and this is the case it exists to
// protect: from the candidate closer the remainder is 3, so that `$` *is* the
// current opener's partner. Reinterpreting would cost two real spans to make one
// bogus one.
// rule: DP-closer-b
test("an odd remainder from the candidate keeps both real spans", () => {
	const result = findMathSpans("$a$and$b$");
	assert.deepStrictEqual(latexOf(result), ["a", "b"]);
	assert.deepStrictEqual(result.warnings, []);
});

// Both alternatives the rule was rejected for, pinned from the other side: a
// digit-opened span and a spaced body inside one are legitimate math, so neither
// may be used as a currency heuristic.
// rule: DP-closer-b/rej-digit-opened — the counter-examples `$5$` and `$2 + 3$`.
test("digit-opened and space-containing bodies are still math", () => {
	assert.deepStrictEqual(latexOf(findMathSpans("Compare $5$ vs $6$.")), ["5", "6"]);
	const spaced = findMathSpans("If $2 + 3$ then.");
	assert.deepStrictEqual(latexOf(spaced), ["2 + 3"]);
	assert.deepStrictEqual(spaced.warnings, []);
});

// ---------------------------------------------------------------------------
// A price that comes first swallows the expression that follows it.
//
// `cost $5, that will be $x+5$` reports one guarded warning and converts
// nothing: the guarded arm of the inline branch sets `i = closeInline.index + 1`,
// landing past the `$` that opens `$x+5$`. Isolating the expression into its own
// paragraph "fixes" it only because the price is then not in the scan.
//
// Two conditions separate this from the invariant the step-past exists for:
// which guard fired, and whether the refused `$` really closes. See
// `refusedDollarIsAnOpener` in plugin/scripts/scan.js.
// ---------------------------------------------------------------------------

// rule: DP-refused-nested
test("REPRO: a leading price must not swallow space-separated math", () => {
	const text = "cost $5, that will be $x+5$";
	const result = findMathSpans(text);
	assert.deepStrictEqual(
		result.spans.map((span) => span.raw),
		["$x+5$"],
		"the real expression must survive a price earlier in the sentence"
	);
	assert.deepStrictEqual(
		result.warnings.map((warning) => warning.code),
		["guarded-inline-dollar"],
		"the price reports as guarded, not as a converted span"
	);
});

// rule: DP-refused-nested
test("REPRO: price, math and a trailing price still converts the math", () => {
	const text = "cost $5, be $x+5$ and $10";
	const result = findMathSpans(text);
	assert.deepStrictEqual(result.spans.map((span) => span.raw), ["$x+5$"]);
	assert.deepStrictEqual(
		result.warnings.map((warning) => warning.code),
		["guarded-inline-dollar", "unterminated-inline-dollar"]
	);
});

test("CONTROL: the same sentence without the price converts unchanged", () => {
	const text = "cost X, that will be $x+5$";
	const result = findMathSpans(text);
	assert.deepStrictEqual(result.spans.map((span) => span.raw), ["$x+5$"]);
	assert.deepStrictEqual(result.warnings, []);
});

// rule: DP-refused-currency
test("CONTROL: a US price and a European 20$ never pair into one equation", () => {
	// The currency refusal must never be re-offered: otherwise a `$N` price and a
	// later `N$` become one equation out of two prices, which is deleted prose
	// with no rollback.
	const result = findMathSpans("cost $5, then $10 and 20$ here");
	assert.deepStrictEqual(result.spans, []);
	assert.deepStrictEqual(
		result.warnings.map((warning) => warning.code),
		["guarded-inline-dollar"]
	);
});

test("CONTROL: $10-$20 yields one guarded warning and no phantom", () => {
	// The invariant the step-past exists for: re-offering a refused `$` that has
	// no closer ahead would add an `unterminated-inline-dollar` beside the guarded
	// one.
	const pair = findMathSpans("$10-$20");
	assert.deepStrictEqual(pair.spans, []);
	assert.deepStrictEqual(
		pair.warnings.map((warning) => warning.code),
		["guarded-inline-dollar"]
	);

	const prose = findMathSpans("$5 and $10 later");
	assert.deepStrictEqual(prose.spans, []);
	assert.deepStrictEqual(
		prose.warnings.map((warning) => warning.code),
		["guarded-inline-dollar"]
	);
});

// rule: DP-refused-nested
test("CONTROL: re-offering happens only when the refused $ actually closes", () => {
	// Whitespace guard fires, so the `$` is eligible for re-offering -- but it has
	// no closer of its own. Without the nested-close condition this gains a
	// phantom `unterminated` beside the guarded warning.
	const result = findMathSpans("cost $5, see $blah and more");
	assert.deepStrictEqual(result.spans, []);
	assert.deepStrictEqual(
		result.warnings.map((warning) => warning.code),
		["guarded-inline-dollar"]
	);
});

// rule: DP-refused-currency/loss-1 — the accepted loss this rule buys.
test("ACCEPTED: a compact $10$ behind a price stays text (measured)", () => {
	// Deliberate, not an oversight: currency refusals are never re-offered, so
	// this real expression behind a price is left alone. A missed span stays
	// visible text the author can select; a wrong span does not. Pinned so the
	// decision cannot drift silently.
	const result = findMathSpans("cost $5, and $10$ is wrong");
	assert.deepStrictEqual(result.spans, []);
	assert.deepStrictEqual(
		result.warnings.map((warning) => warning.code),
		["guarded-inline-dollar"]
	);
});

// rule: DP-refused-nested — a nested refusal still counts as a candidate.
test("CONTROL: a nested refusal reports the orphan, not the price behind it", () => {
	// `findDollarClose` for the refused `$` in `$x` lands on `$10`, which the
	// currency guard refuses. Re-offering is still right: the loop then reports
	// `$x` as guarded (a real attempt, left as text by a guard) instead of walking
	// past it and calling the trailing price `unterminated` -- the malformed bucket
	// exists precisely so a page of prices is not reported as broken LaTeX.
	const result = findMathSpans("cost $5, see $x and $10");
	assert.deepStrictEqual(result.spans, []);
	assert.deepStrictEqual(
		result.warnings.map((warning) => warning.code),
		["guarded-inline-dollar", "guarded-inline-dollar"],
		"no price may be reported as malformed"
	);
});

// ---------------------------------------------------------------------------
// Repro row 1, live editor. The row's literal symptom - "`$x$y$` collapsed
// into a single math-italic xy" - was a stale-build artifact and is
// **unproven** on the current build (HEAD was measured live giving literal
// `$x` + oMath(y)). What IS reproduced live is the semantic defect: pair-y
// promotes the prose token `y` to math and strands the author's delimited
// `$x$` as text. Q2 decision pinned here: **pair x** - first open, first
// close, the rule TeX itself follows - so `$x$` converts and the orphan `$`
// after `y` stays visible text. Refusing both strands `$x$` too and, worse,
// cannot be defended against `$x$y$ and $z$` without run-detection rewrite.
//
// The branch that used to pair y is `closerIsAlsoAnOpener` (condition (w)
// there now refuses to fire on a spaceless body). The counterexample below is
// the defence the spec demanded: the odd run must not eat `$z$` behind it.
// ---------------------------------------------------------------------------

// rule: DP-closer-w
test("REPRO row 1: $x$y$ pairs the first expression and leaves the orphan visible", () => {
	const result = findMathSpans("$x$y$");
	assert.deepStrictEqual(latexOf(result), ["x"], "first open, first close");
	assert.deepStrictEqual(result.warnings, [], "the orphan is a trailing `$`, not a guard refusal");
});

// rule: DP-closer-w
test("REPRO row 1: the odd run never eats the good $z$ behind it", () => {
	const result = findMathSpans("$x$y$ and $z$");
	assert.deepStrictEqual(latexOf(result), ["x", "z"]);
	assert.deepStrictEqual(result.warnings, []);
});

// ---------------------------------------------------------------------------
// The keystroke property the spec's Q4 pins: across prefix-by-prefix typing,
// a span once formed must survive every later keystroke. Wrong intermediate
// spans that correct themselves are allowed, so only spans that exist in the
// finished string are tracked; each must never disappear after it first
// appears. The three strings are the spec's named set; `$x$y$` is row 1's
// own string, where pair-y used to kill the `$x$` span formed at k=3.
// ---------------------------------------------------------------------------

test("KEYSTROKE: a span once formed survives every later keystroke", () => {
	function keys(result) {
		return result.spans.map(function (span) {
			return span.start + ":" + span.end + ":" + span.latex;
		});
	}
	["$x$$y$", "price $5 and$x$ here", "cost $5, that will be $x+5$", "$x$y$"].forEach(function (text) {
		const perPrefix = [];
		for (let k = 1; k <= text.length; k++) {
			perPrefix[k] = keys(findMathSpans(text.slice(0, k)));
		}
		const final = perPrefix[text.length];
		const firstSeen = {};
		final.forEach(function (key) {
			for (let k = 1; k <= text.length; k++) {
				if (perPrefix[k].indexOf(key) !== -1) {
					firstSeen[key] = k;
					return;
				}
			}
		});
		final.forEach(function (key) {
			for (let k = firstSeen[key]; k <= text.length; k++) {
				assert.ok(
					perPrefix[k].indexOf(key) !== -1,
					text + ": span " + key + " formed at prefix " + firstSeen[key] + " disappeared at prefix " + k
				);
			}
		});
	});
});
