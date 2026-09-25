/*
 * Pure, dependency-free scanner that finds math delimiters in plain text.
 *
 * Supported delimiters (all can be toggled through `options.delimiters`):
 *   $...$      inline   (currency-guarded, single line)
 *   $$...$$    display  (may span lines)
 *   \(...\)    inline
 *   \[...\]    display
 *
 * The scanner never mutates its input: it returns spans described by character
 * offsets so the caller can map them onto ONLYOFFICE document positions.
 *
 * Loadable both as a CommonJS module (node --test) and as a plain script that
 * exposes `window.OnlyOfficeLatexMath` inside the plugin iframe.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.OnlyOfficeLatexMath = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	var DEFAULTS = {
		delimiters: {
			inlineDollar: true,
			displayDollar: true,
			inlineParen: true,
			displayBracket: true
		},
		// A `$` closing delimiter may not be followed by a digit ("$1 and $2").
		//
		// The *scanner* exposes this as an option because the rule belongs to the
		// scanner and its own tests exercise both settings; the *plugin* has no
		// toggle for it and always passes `true` (see code.js scannerOptions). That
		// asymmetry is deliberate: an option a product never sets is still the right
		// shape for a pure function, and the guard's effect is asserted from both
		// sides.
		currencyGuard: true,
		// Keep the raw content, newlines collapsed into single spaces.
		collapseNewlines: true
	};

	function mergeOptions(options) {
		var merged = {
			delimiters: {},
			currencyGuard: DEFAULTS.currencyGuard,
			collapseNewlines: DEFAULTS.collapseNewlines
		};
		options = options || {};
		for (var key in DEFAULTS.delimiters) {
			merged.delimiters[key] =
				options.delimiters && typeof options.delimiters[key] === "boolean"
					? options.delimiters[key]
					: DEFAULTS.delimiters[key];
		}
		if (typeof options.currencyGuard === "boolean") {
			merged.currencyGuard = options.currencyGuard;
		}
		if (typeof options.collapseNewlines === "boolean") {
			merged.collapseNewlines = options.collapseNewlines;
		}
		return merged;
	}

	function isWhitespace(ch) {
		return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
	}

	function isDigit(ch) {
		return ch >= "0" && ch <= "9";
	}

	// Characters that can never begin inline math content. Keeping this list
	// tight is what stops prose such as "Cost in USD ($) is fine" from being
	// mistaken for a `$...$` span.
	var CANNOT_START_MATH = ")]},.;:?!%'\"";

	function canStartInlineMath(text, index) {
		var ch = text.charAt(index);
		if (ch === "" || isWhitespace(ch)) {
			return false;
		}
		return CANNOT_START_MATH.indexOf(ch) === -1;
	}

	// True when the char at `index` is part of an escape sequence. Handles both
	// `\$` (escaped dollar) and `\\$` (escaped backslash followed by a real `$`).
	function isEscaped(text, index) {
		var backslashes = 0;
		for (var i = index - 1; i >= 0 && text.charAt(i) === "\\"; i--) {
			backslashes++;
		}
		return backslashes % 2 === 1;
	}

	function normalizeLatex(content, collapseNewlines) {
		var latex = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (collapseNewlines) {
			latex = latex.trim().replace(/\s*\n\s*/g, " ");
		}
		return latex;
	}

	/**
	 * Locate the closing delimiter for a `$...$` span.
	 *
	 * Returns `{index, guarded}`:
	 *   `{index: -1}`            **none**: the search reached the end of the line
	 *                            without finding a candidate at all, so the opener
	 *                            really is unterminated.
	 *   `{index: n, guarded: true}`  a `$` at `n` was found but a *guard* refused it
	 *                            (currency, or a space before the closer). The text
	 *                            is not math - and reporting it as "unterminated"
	 *                            made a document full of prices read as though it
	 *                            were full of malformed delimiters.
	 *   `{index: n, guarded: false}`  a usable closer.
	 *
	 * The refused index is returned so the caller can step *past* it: re-offering
	 * a refused `$` would let `$10-$20` report one guarded span and one phantom
	 * unterminated one. The exceptions to that default are owned by
	 * `refusedDollarIsAnOpener` (docs/adr/0001-dollar-pairing.md).
	 */
	function findDollarClose(text, from, options) {
		for (var i = from; i < text.length; i++) {
			var ch = text.charAt(i);
			if (ch === "\n" || ch === "\r") {
				return { index: -1 }; // inline math never spans lines
			}
			if (ch !== "$" || isEscaped(text, i)) {
				continue;
			}
			if (options.currencyGuard && isDigit(text.charAt(i + 1))) {
				return { index: i, guarded: true }; // "$5 ... $6" is currency, not math
			}
			if (isWhitespace(text.charAt(i - 1))) {
				return { index: i, guarded: true }; // "live $x , 5$ " style false positive
			}
			return { index: i, guarded: false };
		}
		return { index: -1 };
	}

	/**
	 * True when a `$` a guard has just *refused as a closer* should nevertheless
	 * be re-read as an opener, instead of stepping past it. The rule prose is
	 * owned by docs/adr/0001-dollar-pairing.md; the lines below are its manifest.
	 *
	 *   DP-refused-currency  the digit guard fired: a price, never re-offered;
	 *   DP-refused-canStart  the refused `$` can start math (intent, redundant);
	 *   DP-refused-nested    a nested close exists with a non-empty body.
	 *
	 * @param {string} text
	 * @param {number} refused index of the `$` the guard refused.
	 * @param {object} options merged scanner options.
	 */
	function refusedDollarIsAnOpener(text, refused, options) {
		if (options.currencyGuard && isDigit(text.charAt(refused + 1))) {
			return false;
		}
		if (!canStartInlineMath(text, refused + 1)) {
			return false;
		}
		var nested = findDollarClose(text, refused + 1, options);
		if (nested.index === -1) {
			return false;
		}
		// Mirror `pushSpan`: a body that normalizes to nothing would be refused
		// anyway, so re-offering the `$` would produce nothing at all.
		return normalizeLatex(text.substring(refused + 1, nested.index), options.collapseNewlines) !== "";
	}

	/**
	 * True when the candidate `closer` should be read as an **opener** in its own
	 * right, abandoning the span whose closer it currently is. The rule prose is
	 * owned by docs/adr/0001-dollar-pairing.md; the lines below are its manifest.
	 *
	 *   DP-closer-0  the current opener's body is non-empty, so it held a span;
	 *   DP-closer-a  the candidate can start math, so there is something to open;
	 *   DP-closer-b  an even count of unescaped `$` remains from the candidate;
	 *   DP-closer-w  the current body has whitespace (why, at the check below);
	 *   DP-closer-c  a nested close succeeds with a non-empty body.
	 *
	 * @param {string} text
	 * @param {number} opener index of the `$` being scanned.
	 * @param {number} closer candidate closer of that opener.
	 * @param {object} options merged scanner options.
	 * @param {Array<number>} dollarFrom suffix count of unescaped `$` per offset.
	 */
	function closerIsAlsoAnOpener(text, opener, closer, options, dollarFrom) {
		var body = text.substring(opener + 1, closer);
		if (normalizeLatex(body, options.collapseNewlines) === "") {
			return false;
		}
		if (!canStartInlineMath(text, closer + 1)) {
			return false;
		}
		if (dollarFrom[closer] % 2 !== 0) {
			return false;
		}
		// DP-closer-w: a spaceless body is a token, not prose - both candidate
		// pairings are token-local, so reading order decides (first open, first
		// close, the rule TeX follows) and this rule must not steal the pair TeX
		// would make: `$x$y$` pairs `x`, leaving the trailing `$` visible. Every
		// real steal this rule exists for has a whitespace-bearing body.
		if (!/\s/.test(body)) {
			return false;
		}
		var nested = findDollarClose(text, closer + 1, options);
		if (nested.index === -1 || nested.guarded) {
			return false;
		}
		// Mirror `pushSpan`: a body that normalizes to nothing would be refused
		// anyway, so abandoning the current opener would produce nothing at all.
		return normalizeLatex(text.substring(closer + 1, nested.index), options.collapseNewlines) !== "";
	}

	/**
	 * Locate the closing delimiter for a paired-delimiter span (`$$`, `\(`,
	 * `\[`). Returns the index at which the closing token starts, or -1.
	 *
	 * A blank line ends the search, whatever `allowNewline` says: this scanner
	 * only ever sees **one paragraph at a time**, so a delimiter separated from
	 * its partner by an empty line was never closed (the README states this as a
	 * rule, and this is where it is enforced).
	 */
	function findPairClose(text, from, closer, allowNewline) {
		var newlineSeen = false;
		for (var i = from; i < text.length; i++) {
			var ch = text.charAt(i);
			if (ch === "\n" || ch === "\r") {
				if (!allowNewline) {
					return -1; // inline math never spans lines
				}
				if (ch === "\n" && text.charAt(i - 1) === "\r") {
					continue; // CRLF is one break, not two
				}
				if (newlineSeen) {
					return -1; // a blank line
				}
				newlineSeen = true;
				continue;
			}
			if (ch !== " " && ch !== "\t") {
				newlineSeen = false;
			}
			if (ch !== closer.charAt(0) || isEscaped(text, i)) {
				continue;
			}
			if (text.substr(i, closer.length) === closer) {
				return i;
			}
		}
		return -1;
	}

	function pushSpan(spans, text, start, end, content, display, open, close, options) {
		var latex = normalizeLatex(content, options.collapseNewlines);
		if (latex === "") {
			return false;
		}
		spans.push({
			start: start,
			end: end,
			raw: text.substring(start, end),
			latex: latex,
			display: display,
			open: open,
			close: close
		});
		return true;
	}

	/**
	 * @param {string} text
	 * @param {object} [options] see DEFAULTS
	 * @returns {{spans: Array, warnings: Array}}
	 */
	function findMathSpans(text, options) {
		var opts = mergeOptions(options);
		var spans = [];
		var warnings = [];
		if (typeof text !== "string" || text === "") {
			return { spans: spans, warnings: warnings };
		}

		// Unescaped `$` remaining at each offset, including that offset itself.
		// Precomputed once so `closerIsAlsoAnOpener` can ask "is the remainder
		// even?" in O(1); counting per candidate would make a `$`-dense paragraph
		// quadratic. `$$` pairs contribute 2 and are therefore parity-neutral.
		var dollarFrom = new Array(text.length + 1);
		dollarFrom[text.length] = 0;
		for (var d = text.length - 1; d >= 0; d--) {
			dollarFrom[d] =
				dollarFrom[d + 1] + (text.charAt(d) === "$" && !isEscaped(text, d) ? 1 : 0);
		}

		var i = 0;
		while (i < text.length) {
			var ch = text.charAt(i);

			// Skip escaped characters wholesale so "\$" never opens a span.
			// `\(` and `\[` are deliberately *not* skipped here: they are math
			// delimiters and are handled by the branches below.
			if (ch === "\\" && isEscaped(text, i) === false) {
				var escaped = text.charAt(i + 1);
				if (escaped === "$" || escaped === "\\") {
					i += 2;
					continue;
				}
			}

			var handled = false;

			if (opts.delimiters.displayDollar && text.substr(i, 2) === "$$" && !isEscaped(text, i)) {
				var closeDollar = findPairClose(text, i + 2, "$$", true);
				if (closeDollar === -1) {
					warnings.push({ code: "unterminated-display-dollar", index: i });
				} else if (
					pushSpan(
						spans,
						text,
						i,
						closeDollar + 2,
						text.substring(i + 2, closeDollar),
						true,
						"$$",
						"$$",
						opts
					)
				) {
					handled = true;
					i = closeDollar + 2;
				} else {
					// pushSpan refused: the body was empty or whitespace only.
					warnings.push({ code: "empty-span", index: i });
				}
			} else if (
				opts.delimiters.inlineDollar &&
				ch === "$" &&
				!isEscaped(text, i) &&
				canStartInlineMath(text, i + 1)
			) {
				var closeInline = findDollarClose(text, i + 1, opts);
				if (closeInline.index === -1) {
					warnings.push({ code: "unterminated-inline-dollar", index: i });
				} else if (closeInline.guarded) {
					// A guard refused the closer: not a malformed span, a non-span.
					// Step past the refused `$` so it is not re-read as an opener --
					// *unless* it is itself a legitimate opener, in which case
					// stepping past would swallow the real expression that follows.
					warnings.push({ code: "guarded-inline-dollar", index: i });
					handled = true;
					i = refusedDollarIsAnOpener(text, closeInline.index, opts)
						? i + 1
						: closeInline.index + 1;
				} else if (closerIsAlsoAnOpener(text, i, closeInline.index, opts, dollarFrom)) {
					// The candidate closer is an opener in its own right, so this
					// `$` has no partner: report it as guarded (the same
					// "left as text by a guard" bucket) and advance by exactly one,
					// never past `closeInline.index`, so the outer loop re-reads it
					// as the opener it is.
					warnings.push({ code: "guarded-inline-dollar", index: i });
					handled = true;
					i = i + 1;
				} else if (
					pushSpan(
						spans,
						text,
						i,
						closeInline.index + 1,
						text.substring(i + 1, closeInline.index),
						false,
						"$",
						"$",
						opts
					)
				) {
					handled = true;
					i = closeInline.index + 1;
				} else {
					// Reachable: with the display delimiter switched off, "$$x$"
					// offers an empty body to this branch.
					warnings.push({ code: "empty-span", index: i });
				}
			} else if (opts.delimiters.inlineParen && text.substr(i, 2) === "\\(" && !isEscaped(text, i)) {
				// Single line, like `$...$`: `\(...\)` *is* inline math.
				var closeParen = findPairClose(text, i + 2, "\\)", false);
				if (closeParen === -1) {
					warnings.push({ code: "unterminated-inline-paren", index: i });
				} else if (
					pushSpan(
						spans,
						text,
						i,
						closeParen + 2,
						text.substring(i + 2, closeParen),
						false,
						"\\(",
						"\\)",
						opts
					)
				) {
					handled = true;
					i = closeParen + 2;
				} else {
					// pushSpan refused: the body was empty or whitespace only.
					warnings.push({ code: "empty-span", index: i });
				}
			} else if (opts.delimiters.displayBracket && text.substr(i, 2) === "\\[" && !isEscaped(text, i)) {
				var closeBracket = findPairClose(text, i + 2, "\\]", true);
				if (closeBracket === -1) {
					warnings.push({ code: "unterminated-display-bracket", index: i });
				} else if (
					pushSpan(
						spans,
						text,
						i,
						closeBracket + 2,
						text.substring(i + 2, closeBracket),
						true,
						"\\[",
						"\\]",
						opts
					)
				) {
					handled = true;
					i = closeBracket + 2;
				} else {
					// pushSpan refused: the body was empty or whitespace only.
					warnings.push({ code: "empty-span", index: i });
				}
			}

			if (!handled) {
				i++;
			}
		}
		return { spans: spans, warnings: warnings };
	}

	return {
		DEFAULT_OPTIONS: DEFAULTS,
		findMathSpans: findMathSpans,
		isEscaped: isEscaped,
		normalizeLatex: normalizeLatex
	};
});
