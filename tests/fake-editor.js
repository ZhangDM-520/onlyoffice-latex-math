/*
 * Minimal onlyoffice document/Builder-API simulator.
 *
 * It models just enough of the real contract to test the plugin end to end
 * outside the editor:
 *   - `GetAllParagraphs()` / `paragraph.GetRange()` / `GetStartPos()` /
 *     `GetEndPos()` / `GetText()` / `GetRange(start, end)` / `Delete()` /
 *     `AddMathEquation(latex, 'latex')` / `CreateNewHistoryPoint()`
 *   - document level character offsets, where a paragraph mark costs one
 *     character, so paragraph start offsets are not simply cumulative text
 *     lengths (this is what catches stale-offset bugs)
 *   - `Document.GetCurrentMath()` and `Document.ConvertMathDisplayMode()`
 *
 * Ranges that would span more than one paragraph throw, because the plugin is
 * never allowed to build such a range.
 */
"use strict";

var PARAGRAPH_MARK_COST = 1;

function createEditor(options) {
	options = options || {};
	var paragraphs = (options.paragraphs || []).map(function (text) {
		return { segments: [{ type: "text", value: text }] };
	});

	var state = {
		historyPoints: 0,
		displayConversions: [],
		insertedMath: [],
		lastInsertedMath: null,
		currentMath: null,
		selection: options.selection || null,
		mathRendersAsPlaceholder: !!options.mathRendersAsPlaceholder,
		alignedOverride: options.alignedOverride || {},
		failInsert: options.failInsert || {},
		// The caret an ApiDocument.AddMathEquation call inserts at. It starts at the
		// top of the document, which is where the editor leaves it for a command
		// that never touches the selection.
		caret: 0,
		cursorMoves: [],
		hasMoveCursorApi: options.hasMoveCursorApi !== false,
		exposeCaretAsSelection: options.exposeCaretAsSelection !== false
	};

	function documentLength() {
		var total = 0;
		for (var i = 0; i < paragraphs.length; i++) {
			total += paragraphLength(i) + PARAGRAPH_MARK_COST;
		}
		return Math.max(0, total - PARAGRAPH_MARK_COST);
	}

	function segmentText(segment) {
		if (segment.type === "text") {
			return segment.value;
		}
		if (segment.type === "math") {
			return state.mathRendersAsPlaceholder ? "\uFFFC" : segment.latex;
		}
		if (segment.type === "image") {
			return "\uFFFC\uFFFC"; // two rendered chars, one content item
		}
		return "";
	}

	/**
	 * Content length (what GetStartPos/GetEndPos count) as opposed to the
	 * rendered length (what GetText returns). Equations and images count as a
	 * single content item, which is exactly why the plugin has to verify that
	 * offsets and text agree before rewriting anything.
	 */
	function segmentContentLength(segment) {
		if (segment.type === "text") {
			return segment.value.length;
		}
		return 1;
	}

	function paragraphText(index) {
		return paragraphs[index].segments.map(segmentText).join("");
	}

	function paragraphLength(index) {
		// Content length as counted by GetStartPos/GetEndPos.
		return paragraphs[index].segments.reduce(function (total, segment) {
			return total + segmentContentLength(segment);
		}, 0);
	}

	function paragraphStart(index) {
		var base = 0;
		for (var i = 0; i < index; i++) {
			base += paragraphLength(i) + PARAGRAPH_MARK_COST;
		}
		if (state.alignedOverride[index] !== undefined) {
			base += state.alignedOverride[index];
		}
		return base;
	}

	function paragraphOf(offset) {
		for (var i = 0; i < paragraphs.length; i++) {
			var start = paragraphStart(i);
			var end = start + paragraphLength(i);
			if (offset >= start && offset <= end) {
				return { index: i, start: start, end: end };
			}
		}
		return null;
	}

	function assertSingleParagraph(start, end) {
		var head = paragraphOf(start);
		var tail = paragraphOf(end);
		if (!head || !tail) {
			throw new Error("offset out of bounds: " + start + "-" + end);
		}
		if (head.index !== tail.index) {
			throw new Error("range spans paragraphs: " + start + "-" + end);
		}
		return { index: head.index, from: start - head.start, to: end - head.start };
	}

	function textBetween(start, end) {
		var located = assertSingleParagraph(start, end);
		var segments = paragraphs[located.index].segments;
		var text = "";
		var cursor = 0;
		segments.forEach(function (segment) {
			var contentLength = segmentContentLength(segment);
			var segStart = cursor;
			var segEnd = cursor + contentLength;
			cursor = segEnd;
			if (segEnd <= located.from || segStart >= located.to) {
				return;
			}
			if (segment.type === "text") {
				// Text can be sliced; other content items render as a whole.
				text += segment.value.substring(
					Math.max(0, located.from - segStart),
					Math.min(contentLength, located.to - segStart)
				);
				return;
			}
			text += segmentText(segment);
		});
		return text;
	}

	function replaceRange(start, end, replacementSegments) {
		var located = assertSingleParagraph(start, end);
		var paragraph = paragraphs[located.index];
		var result = [];
		var cursor = 0;
		var inserted = false;

		function insertReplacement() {
			if (inserted) {
				return;
			}
			replacementSegments.forEach(function (item) {
				result.push(item);
			});
			inserted = true;
		}

		paragraph.segments.forEach(function (segment) {
			var contentLength = segmentContentLength(segment);
			var segStart = cursor;
			var segEnd = cursor + contentLength;
			cursor = segEnd;

			if (segEnd <= located.from) {
				result.push(segment);
				if (segEnd === located.from) {
					insertReplacement();
				}
				return;
			}

			var overlaps = segEnd > located.from && segStart < located.to;
			if (!overlaps) {
				insertReplacement();
				result.push(segment);
				return;
			}

			if (segment.type === "text") {
				var keepLeft = segment.value.substring(0, Math.max(0, located.from - segStart));
				var keepRight = segment.value.substring(Math.min(contentLength, located.to - segStart));
				if (keepLeft) {
					result.push({ type: "text", value: keepLeft });
				}
				insertReplacement();
				if (keepRight) {
					result.push({ type: "text", value: keepRight });
				}
				return;
			}

			// An image or equation marker is removed as a whole.
			insertReplacement();
		});

		insertReplacement();
		paragraph.segments = result;
		return located.index;
	}

	function makeRange(start, end) {
		return {
			GetStartPos: function () {
				return start;
			},
			GetEndPos: function () {
				return end;
			},
			GetText: function () {
				return textBetween(start, end);
			},
			Select: function () {
				return true;
			},
			Delete: function () {
				// Faithful to ApiRange.Delete: it saves the document state before the
				// removal and loads it back afterwards, so the caret keeps whatever
				// value it had when the command started. Ignoring this is what makes
				// AddMathEquation insert at the wrong offset.
				replaceRange(start, end, []);
				return true;
			}
		};
	}

	var logicDocument = {
		GetCurrentMath: function () {
			return state.currentMath;
		},
		ConvertMathDisplayMode: function (isInline) {
			if (!state.currentMath) {
				return;
			}
			state.displayConversions.push({ isInline: !!isInline, via: "logic-document" });
			state.currentMath.display = !isInline;
			state.currentMath.displayModeApplied = "logic-document";
		}
	};

	var apiDocument = {
		Document: logicDocument,
		// `Api.GetDocument()` returns the document object itself, exactly like the
		// real builder API.
		GetDocument: function () {
			return apiDocument;
		},
		GetAllParagraphs: function () {
			return paragraphs.map(function (paragraph, index) {
				return {
					GetText: function () {
						return paragraphText(index);
					},
					GetRange: function () {
						return makeRange(paragraphStart(index), paragraphStart(index) + paragraphLength(index));
					}
				};
			});
		},
		GetRange: function (start, end) {
			if (typeof start !== "number" || typeof end !== "number" || end <= start) {
				return null;
			}
			return makeRange(start, end);
		},
		GetRangeBySelect: function () {
			if (state.selection) {
				return makeRange(state.selection.start, state.selection.end);
			}
			// Like the real editor, an empty selection is reported as a collapsed
			// range sitting at the caret rather than as nothing at all.
			if (state.exposeCaretAsSelection) {
				return makeRange(state.caret, state.caret);
			}
			return null;
		},
		MoveCursorToPos: function (pos) {
			if (!state.hasMoveCursorApi) {
				throw new Error("MoveCursorToPos is not available");
			}
			if (typeof pos !== "number" || pos < 0 || pos > documentLength()) {
				return false;
			}
			state.cursorMoves.push(pos);
			state.caret = pos;
			return true;
		},
		CreateNewHistoryPoint: function () {
			state.historyPoints++;
			return true;
		},
		AddMathEquation: function (latex, format) {
			if (state.failInsert[latex]) {
				throw new Error("simulated insert failure");
			}
			if (typeof latex !== "string" || latex.trim() === "") {
				return false;
			}
			if (format !== "latex") {
				throw new Error("unexpected format: " + format);
			}
			var math = { type: "math", latex: latex, display: false };
			replaceRange(state.caret, state.caret, [math]);
			state.insertedMath.push({ latex: latex, format: format });
			state.currentMath = math;
			state.lastInsertedMath = math;
			return true;
		}
	};

	var editorApi = {
		asc_ConvertMathDisplayMode: function (isInline) {
			state.displayConversions.push({ isInline: !!isInline, via: "editor-api" });
			if (state.currentMath) {
				state.currentMath.display = !isInline;
				state.currentMath.displayModeApplied = "editor-api";
			}
		}
	};

	if (options.hasMoveCursorApi === false) {
		// Models a build where the caret cannot be moved programmatically; the
		// conversion must then refuse to rewrite anything rather than corrupt the
		// document by inserting at a stale caret.
		delete apiDocument.MoveCursorToPos;
	}

	return {
		apiDocument: apiDocument,
		editorApi: editorApi,
		state: state,
		text: function () {
			return paragraphs
				.map(function (_paragraph, index) {
					return paragraphText(index);
				})
				.join("\n");
		},
		segments: function () {
			return paragraphs.map(function (paragraph) {
				return paragraph.segments;
			});
		},
		maths: function () {
			var found = [];
			paragraphs.forEach(function (paragraph) {
				paragraph.segments.forEach(function (segment) {
					if (segment.type === "math") {
						found.push(segment);
					}
				});
			});
			return found;
		}
	};
}

module.exports = { createEditor: createEditor, PARAGRAPH_MARK_COST: PARAGRAPH_MARK_COST };
