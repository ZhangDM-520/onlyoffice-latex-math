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
		currencyGuard: true,
		// Force every produced span into display mode (menu action).
		forceDisplay: false,
		// Keep the raw content, newlines collapsed into single spaces.
		collapseNewlines: true
	};

	function mergeOptions(options) {
		var merged = {
			delimiters: {},
			currencyGuard: DEFAULTS.currencyGuard,
			forceDisplay: DEFAULTS.forceDisplay,
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
		if (typeof options.forceDisplay === "boolean") {
			merged.forceDisplay = options.forceDisplay;
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
	 * Returns the index of the closing `$`, or -1 when there is none.
	 */
	function findDollarClose(text, from, options) {
		for (var i = from; i < text.length; i++) {
			var ch = text.charAt(i);
			if (ch === "\n" || ch === "\r") {
				return -1; // inline math never spans lines
			}
			if (ch !== "$" || isEscaped(text, i)) {
				continue;
			}
			if (options.currencyGuard && isDigit(text.charAt(i + 1))) {
				return -1; // "$5 ... $6" is currency, not math
			}
			if (isWhitespace(text.charAt(i - 1))) {
				return -1; // "live $x , 5$ " style false positive
			}
			return i;
		}
		return -1;
	}

	/**
	 * Locate the closing delimiter for a paired-delimiter span (`$$`, `\(`,
	 * `\[`). Returns the index at which the closing token starts, or -1.
	 */
	function findPairClose(text, from, closer, allowNewline) {
		for (var i = from; i < text.length; i++) {
			if (!allowNewline && (text.charAt(i) === "\n" || text.charAt(i) === "\r")) {
				return -1;
			}
			if (text.charAt(i) !== closer.charAt(0) || isEscaped(text, i)) {
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
			display: display || options.forceDisplay,
			open: open,
			close: close
		});
		return true;
	}

	/**
	 * @param {string} text
	 * @param {object} [options] see DEFAULTS
	 * @returns {{spans: Array, warnings: Array, masked: Array}}
	 */
	function findMathSpans(text, options) {
		var opts = mergeOptions(options);
		var spans = [];
		var warnings = [];
		var masked = [];
		if (typeof text !== "string" || text === "") {
			return { spans: spans, warnings: warnings, masked: masked };
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
					warnings.push({ code: "empty-span", index: i });
				}
			} else if (
				opts.delimiters.inlineDollar &&
				ch === "$" &&
				!isEscaped(text, i) &&
				canStartInlineMath(text, i + 1)
			) {
				var closeInline = findDollarClose(text, i + 1, opts);
				if (closeInline === -1) {
					warnings.push({ code: "unterminated-inline-dollar", index: i });
				} else if (
					pushSpan(
						spans,
						text,
						i,
						closeInline + 1,
						text.substring(i + 1, closeInline),
						false,
						"$",
						"$",
						opts
					)
				) {
					handled = true;
					i = closeInline + 1;
				}
			} else if (opts.delimiters.inlineParen && text.substr(i, 2) === "\\(" && !isEscaped(text, i)) {
				var closeParen = findPairClose(text, i + 2, "\\)", true);
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
				}
			}

			if (!handled) {
				i++;
			}
		}
		return { spans: spans, warnings: warnings, masked: masked };
	}

	/**
	 * Turn per-paragraph scan results into document-level replacement operations.
	 *
	 * @param {Array<{start: number, text: string}>} paragraphs paragraph start
	 *        offsets inside the document plus their plain text, in document order.
	 * @param {object} [options] scanner options.
	 * @param {object} [filter] optional `{start, end}` document offset window;
	 *        spans outside it are reported as skipped instead of converted.
	 * @returns {{operations: Array, skipped: Array, warnings: Array}}
	 */
	function planReplacements(paragraphs, options, filter) {
		var operations = [];
		var skipped = [];
		var warnings = [];

		(paragraphs || []).forEach(function (paragraph, paragraphIndex) {
			var result = findMathSpans(paragraph.text, options);
			warnings = warnings.concat(
				result.warnings.map(function (warning) {
					return {
						code: warning.code,
						index: warning.index,
						paragraphIndex: paragraphIndex,
						absoluteIndex: paragraph.start + warning.index
					};
				})
			);

			result.spans.forEach(function (span) {
				var absoluteStart = paragraph.start + span.start;
				var absoluteEnd = paragraph.start + span.end;
				var operation = {
					paragraphIndex: paragraphIndex,
					start: absoluteStart,
					end: absoluteEnd,
					latex: span.latex,
					display: span.display,
					expected: span.raw
				};
				if (filter && (absoluteStart < filter.start || absoluteEnd > filter.end)) {
					operation.reason = "outside-selection";
					skipped.push(operation);
					return;
				}
				operations.push(operation);
			});
		});

		// Replace from the end of the document towards the beginning so every
		// remaining offset stays valid while the run is being applied.
		operations.sort(function (a, b) {
			return b.start - a.start || b.end - a.end;
		});

		return { operations: operations, skipped: skipped, warnings: warnings };
	}

	/**
	 * Reduce a document snapshot (see commands.js) to the paragraphs whose
	 * character offsets can be trusted. Paragraphs containing content that
	 * renders to a different length than it counts (equations, images, tables)
	 * are dropped rather than converted at the wrong position.
	 *
	 * @param {{paragraphs: Array}} snapshot
	 * @returns {{paragraphs: Array<{start: number, text: string}>, unusable: number}}
	 */
	function collectParagraphs(snapshot) {
		var paragraphs = [];
		var unusable = 0;
		((snapshot && snapshot.paragraphs) || []).forEach(function (paragraph) {
			if (!paragraph || paragraph.start === null || typeof paragraph.text !== "string") {
				unusable++;
				return;
			}
			if (paragraph.aligned === false) {
				unusable++;
				return;
			}
			paragraphs.push({ start: paragraph.start, text: paragraph.text });
		});
		return { paragraphs: paragraphs, unusable: unusable };
	}

	return {
		DEFAULT_OPTIONS: DEFAULTS,
		findMathSpans: findMathSpans,
		planReplacements: planReplacements,
		collectParagraphs: collectParagraphs,
		isEscaped: isEscaped,
		normalizeLatex: normalizeLatex
	};
});
