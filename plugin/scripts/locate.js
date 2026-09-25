/*
 * Owner of "a span lives in character coordinates; where does it live in
 * document-position coordinates - and is that placement proven or guessed?"
 *
 * Two coordinate systems meet here (measured, docs/NOTE.md 1.7): a paragraph's
 * document range counts **positions** while `GetText()` returns **characters**
 * (the paragraph mark renders as `\r\n` - two characters for one position - and
 * an inline equation object costs 3 positions for the 1 character it renders).
 * scan.js reports spans in character offsets; the editor-page commands need
 * document positions. Everything that translates between the two lives behind
 * `plan()`:
 *   - the per-paragraph character scan (scan.js),
 *   - the probe seam (`resolve`, in the plugin backed by commands.js
 *     `resolveCommand`) that *proves* a char offset -> position mapping,
 *   - the best-effort arithmetic fallback for offsets no probe proved,
 *   - the map validation that decides what counts as proof,
 * and every operation is tagged `placement: "probed" | "arithmetic"` so the
 * caller can tell which one it got. commands.js APPLY_BODY's `text-mismatch`
 * guard stays the safety net behind both: it answers "has the document changed
 * since planning", not "where is this span".
 *
 * Loadable both as a CommonJS module (node --test) and as a plain script that
 * exposes `window.OnlyOfficeLatexMathLocate` inside the plugin iframe; the
 * browser build needs scan.js loaded first.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./scan.js"));
	} else {
		root.OnlyOfficeLatexMathLocate = factory(root.OnlyOfficeLatexMath);
	}
})(typeof self !== "undefined" ? self : this, function (core) {
	"use strict";

	/**
	 * Reduce a document snapshot (see commands.js READ_BODY) to the paragraphs
	 * worth scanning.
	 *
	 * Offsets are treated as **best effort**, deliberately. A paragraph range
	 * counts positions, while GetText() returns characters: empty/formatting
	 * positions render as nothing and the trailing paragraph mark renders as
	 * `\r\n` (two characters for one position), so `end - start === text.length`
	 * is false for practically every paragraph - including plain prose with no
	 * math in it. Gating on that comparison silently discarded whole documents.
	 *
	 * Safety does not depend on this filter: the apply step re-reads each span's
	 * range and refuses to rewrite anything whose live text does not match the
	 * source it was planned from (see APPLY_BODY's `text-mismatch`), then checks
	 * the outcome afterwards. Paragraphs are therefore attempted rather than
	 * discarded, and only the genuinely unreadable ones are counted as unusable.
	 *
	 * @param {{paragraphs: Array}} snapshot
	 * @returns {{paragraphs: Array<{start: number, end: number, text: string}>, unusable: number}}
	 */
	function collectParagraphs(snapshot) {
		var paragraphs = [];
		var unusable = 0;
		((snapshot && snapshot.paragraphs) || []).forEach(function (paragraph) {
			if (!paragraph || paragraph.start === null || typeof paragraph.text !== "string") {
				unusable++;
				return;
			}
			var entry = { start: paragraph.start, text: paragraph.text };
			if (typeof paragraph.end === "number") {
				// The range span: the upper bound for the char -> position probe
				// behind `resolve`. Absent when a snapshot did not carry it.
				entry.end = paragraph.end;
			}
			paragraphs.push(entry);
		});
		return { paragraphs: paragraphs, unusable: unusable };
	}

	/**
	 * A paragraph may carry a resolved `positions` map (char offset -> absolute
	 * document position) written by the editor-side probe behind `resolve`
	 * (commands.js RESOLVE_BODY). It exists for paragraphs whose content items
	 * cost more positions than the characters they render - an inline equation
	 * counts 3 positions for the 1 character its text shows - where
	 * `paragraph.start + span.start` lands early, the apply-time text check
	 * refuses the span and the conversion silently does nothing (live repro row
	 * 2). Offsets the probe could not resolve fall back to the best-effort
	 * arithmetic, and APPLY_BODY's `text-mismatch` guard stays the safety net
	 * behind both.
	 *
	 * @param {{start: number, positions?: Object}} paragraph
	 * @param {number} charOffset offset inside `paragraph.text`
	 * @returns {number} absolute document position
	 */
	function positionOf(paragraph, charOffset) {
		var map = paragraph.positions;
		if (map && typeof map === "object" && typeof map[charOffset] === "number") {
			return map[charOffset];
		}
		return paragraph.start + charOffset;
	}

	/**
	 * The verdict `positionOf` acts on: "probed" means the probe *proved* this
	 * offset's position; "arithmetic" means it is the best-effort guess
	 * `paragraph.start + charOffset`.
	 */
	function placementOf(paragraph, charOffset) {
		var map = paragraph.positions;
		if (map && typeof map === "object" && typeof map[charOffset] === "number") {
			return "probed";
		}
		return "arithmetic";
	}

	/**
	 * What counts as proof. The probe answers with a char offset -> position
	 * map; anything that cannot be true on its own terms discards the whole map
	 * and the paragraph falls back to the arithmetic. A wrong "proof" is worse
	 * than a labelled guess - it would place the caret on faith - so a map that
	 * lies once is not proof at all:
	 *   - keys must be integer char offsets inside the paragraph's own text
	 *     domain `[0, content length]` (the trailing mark renders as `\r\n` but
	 *     is not content);
	 *   - values must be document positions inside the paragraph's own range
	 *     `[start, end]` - anything else points into a foreign paragraph;
	 *   - a paragraph with no `end` has no range to verify against, so no map on
	 *     it can be proven (the probe's own walk is bounded by `end - start` and
	 *     resolves nothing there either);
	 *   - keys ascending must give strictly ascending values: distinct offsets
	 *     sit at distinct positions (each probe match happens at its own walk
	 *     step).
	 */
	function verifiedPositions(paragraph, positions) {
		if (!positions || typeof positions !== "object" || Array.isArray(positions)) {
			return null;
		}
		if (typeof paragraph.end !== "number") {
			return null;
		}
		var text = paragraph.text;
		var contentLength = text.slice(-2) === "\r\n" ? text.length - 2 : text.length;
		var offsets = Object.keys(positions);
		var pairs = [];
		for (var i = 0; i < offsets.length; i++) {
			var offset = Number(offsets[i]);
			var value = positions[offsets[i]];
			if (String(offset) !== offsets[i] || offset % 1 !== 0 || offset < 0 || offset > contentLength) {
				return null;
			}
			if (typeof value !== "number" || !isFinite(value)) {
				return null;
			}
			if (value < paragraph.start || value > paragraph.end) {
				return null;
			}
			pairs.push([offset, value]);
		}
		pairs.sort(function (a, b) {
			return a[0] - b[0];
		});
		for (var p = 1; p < pairs.length; p++) {
			if (pairs[p][1] <= pairs[p - 1][1]) {
				return null;
			}
		}
		return positions;
	}

	/**
	 * The seam: `resolve` is the caller's adapter (in the plugin, the
	 * editor-side probe compiled from commands.js `resolveCommand`). It answers
	 * with per-paragraph `{index, positions}` entries. A missing or failing
	 * adapter resolves nothing and every offset falls back to the best-effort
	 * arithmetic - proof is an improvement on the fallback, never a
	 * precondition for converting.
	 */
	function callResolve(resolve, specs) {
		if (typeof resolve !== "function") {
			return Promise.resolve([]);
		}
		var pending;
		try {
			pending = resolve(specs);
		} catch (e) {
			return Promise.resolve([]);
		}
		return Promise.resolve(pending).then(
			function (items) {
				return Array.isArray(items) ? items : [];
			},
			function () {
				return [];
			}
		);
	}

	/**
	 * The character domain: what `planReplacements` used to be, degraded to a
	 * per-paragraph reduce over scan.js that returns **paragraph-relative
	 * character offsets** and nothing else. Turning those into document
	 * positions is `place`'s job below, so the mixing of the two coordinate
	 * systems (the live row-2 bug) is no longer expressible here.
	 */
	function reduceParagraphs(paragraphs, scannerOptions) {
		var spans = [];
		var warnings = [];
		paragraphs.forEach(function (paragraph, paragraphIndex) {
			var result = core.findMathSpans(paragraph.text, scannerOptions);
			result.warnings.forEach(function (warning) {
				warnings.push({
					code: warning.code,
					index: warning.index,
					paragraphIndex: paragraphIndex
				});
			});
			result.spans.forEach(function (span) {
				spans.push({
					paragraphIndex: paragraphIndex,
					start: span.start,
					end: span.end,
					latex: span.latex,
					display: span.display,
					expected: span.raw
				});
			});
		});
		return { spans: spans, warnings: warnings };
	}

	/**
	 * The position domain: one span's char offsets -> document positions. Each
	 * boundary is resolved independently, probe first and arithmetic behind it;
	 * an operation is `placement: "probed"` only when **every** boundary was
	 * proven. One guessed boundary makes the placement a guess - and the
	 * apply-time `text-mismatch` guard covers guesses either way.
	 */
	function place(paragraph, span) {
		var startPlacement = placementOf(paragraph, span.start);
		var endPlacement = placementOf(paragraph, span.end);
		return {
			paragraphIndex: span.paragraphIndex,
			start: positionOf(paragraph, span.start),
			end: positionOf(paragraph, span.end),
			latex: span.latex,
			display: span.display,
			expected: span.expected,
			placement: startPlacement === "probed" && endPlacement === "probed" ? "probed" : "arithmetic"
		};
	}

	/** Assemble one pass: place every span, apply the filter, sort back-to-front. */
	function assemble(reduced, paragraphs, filter) {
		var operations = [];
		var skipped = [];
		var warnings = reduced.warnings.map(function (warning) {
			return {
				code: warning.code,
				index: warning.index,
				paragraphIndex: warning.paragraphIndex,
				absoluteIndex: positionOf(paragraphs[warning.paragraphIndex], warning.index)
			};
		});
		reduced.spans.forEach(function (span) {
			var operation = place(paragraphs[span.paragraphIndex], span);
			if (filter && (operation.start < filter.start || operation.end > filter.end)) {
				operation.reason = "outside-selection";
				skipped.push(operation);
				return;
			}
			operations.push(operation);
		});

		// Replace from the end of the document towards the beginning so every
		// remaining offset stays valid while the run is being applied.
		operations.sort(function (a, b) {
			return b.start - a.start || b.end - a.end;
		});

		return { operations: operations, skipped: skipped, warnings: warnings };
	}

	/**
	 * Build the plan: every span the plan would consider first resolved to real
	 * document positions by the probe behind `resolve`. Two pure passes bracket
	 * the probe: the first (unfiltered) names the paragraphs and offsets worth
	 * resolving, the second applies the selection filter against resolved
	 * positions - so a precisely selected span inside a drifted paragraph is no
	 * longer filtered out by arithmetic that never matched the document. A
	 * failed probe leaves no map behind and the second pass reproduces the
	 * best-effort plan exactly.
	 *
	 * @param {{paragraphs: Array}} snapshot commands.js readCommand output.
	 * @param {object} scannerOptions see scan.js DEFAULT_OPTIONS.
	 * @param {{start: number, end: number}} [filter] selection window in
	 *        document positions; spans outside it are reported as skipped.
	 * @param {function} [resolve] the probe adapter (see callResolve).
	 * @returns {Promise<{operations: Array, skipped: Array, warnings: Array, unusable: number}>}
	 */
	function plan(snapshot, scannerOptions, filter, resolve) {
		var collected = collectParagraphs(snapshot);
		var paragraphs = collected.paragraphs;
		var first = assemble(reduceParagraphs(paragraphs, scannerOptions), paragraphs, null);
		if (!first.operations.length) {
			// No span anywhere: a filtered pass cannot produce operations either
			// (a filter only moves them out), so the probe is not worth a round
			// trip. `skipped` stays empty for the same reason - there is nothing
			// to skip.
			return Promise.resolve({
				operations: first.operations,
				skipped: first.skipped,
				warnings: first.warnings,
				unusable: collected.unusable
			});
		}
		var specs = [];
		var byParagraph = {};
		first.operations.forEach(function (op) {
			var paragraph = paragraphs[op.paragraphIndex];
			if (!paragraph) {
				return;
			}
			var spec = byParagraph[op.paragraphIndex];
			if (!spec) {
				spec = {
					index: op.paragraphIndex,
					start: paragraph.start,
					span: typeof paragraph.end === "number" ? paragraph.end - paragraph.start : -1,
					text: paragraph.text,
					need: []
				};
				byParagraph[op.paragraphIndex] = spec;
				specs.push(spec);
			}
			spec.need.push(op.start - paragraph.start);
			spec.need.push(op.end - paragraph.start);
		});
		specs.forEach(function (spec) {
			spec.need = spec.need.filter(function (offset, index, all) {
				return all.indexOf(offset) === index;
			});
		});
		return callResolve(resolve, specs).then(function (items) {
			items.forEach(function (item) {
				if (!item || typeof item.index !== "number" || !byParagraph[item.index]) {
					// Foreign: not a paragraph this plan sent a spec for. Its map
					// is not evidence about this document.
					return;
				}
				var paragraph = paragraphs[item.index];
				if (!paragraph) {
					return;
				}
				var verified = verifiedPositions(paragraph, item.positions);
				if (verified) {
					paragraph.positions = verified;
				}
			});
			var second = assemble(reduceParagraphs(paragraphs, scannerOptions), paragraphs, filter);
			return {
				operations: second.operations,
				skipped: second.skipped,
				warnings: second.warnings,
				unusable: collected.unusable
			};
		});
	}

	return {
		plan: plan
	};
});
