/*
 * Report wording: every line a conversion's report says, and the bucketing that
 * decides which line says it.
 *
 * Wording IS policy here - "a guard is not malformed" is the whole reason the
 * warnings split into two buckets (`Malformed delimiters` vs `Left as text by a
 * guard`): a document of prices used to read as broken LaTeX because the two
 * were lumped together. That policy lives in `planLines`, next to the words it
 * chooses, not in the orchestrator.
 *
 * Interface (all pure; `t` is the host's translator - `Asc.plugin.tr`, injected
 * so this file never reaches for the window):
 *   reportLine(report, text)              push one line
 *   summarizeSkipped(skipped)             {reason: count} groups for the apply result
 *   commandFailureText(result, noAnswer)  the seam's error name -> the wording
 *                                         owners have read since the first builds
 *   refusalLine(t, refusal)               the one line for a pipeline refusal;
 *                                         `refusal.reason` is one of
 *                                         `no-delimiters` | `unreadable` |
 *                                         `no-selection` | `nothing`
 *   planLines(report, t, plan, scanned)   scanned/unusable/outside lines and the
 *                                         malformed-vs-guarded buckets
 *   applyLines(report, t, result, planned)  converted/display/skip-detail lines
 *   applyFailureLine(t, result)           "Conversion failed: ..."
 *   verifyLines(report, t, remaining, converted)  the verification lines
 *   verifyFailureLine(t, result)          "Verification unavailable: ..."
 *
 * The record shape is report-record.js's; what a report *says* is this file's;
 * how it is shown is report.js's. Loadable both as a CommonJS module
 * (node --test) and as a plain script that exposes
 * `window.OnlyOfficeLatexMathReportText` inside the plugin iframe.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.OnlyOfficeLatexMathReportText = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	function reportLine(report, text) {
		report.lines.push(text);
	}

	function summarizeSkipped(skipped) {
		var groups = {};
		skipped.forEach(function (item) {
			var reason = item.reason || "unknown";
			groups[reason] = (groups[reason] || 0) + 1;
		});
		return groups;
	}

	// The seam (commands.js `run`) names its failures (`timeout`,
	// `unparsable-command-result`, …); the report keeps the wording owners have
	// read since the first builds - a dropped answer has always printed "no
	// response from editor" here and it still does, it just has a name now.
	function commandFailureText(result, noAnswerText) {
		if (!result || result.error === "timeout") {
			return noAnswerText;
		}
		return result.error;
	}

	/**
	 * The one line that says why the pipeline did not proceed.
	 *
	 * `unreadable` carries the failed read result as `detail` because its line
	 * names the failure. The rest are pure policy outcomes.
	 */
	function refusalLine(t, refusal) {
		if (refusal.reason === "no-delimiters") {
			return t("No delimiters are enabled. Turn one on in the plugin menu.");
		}
		if (refusal.reason === "unreadable") {
			return t("Cannot read the document") + ": " + commandFailureText(refusal.detail, "no response from editor");
		}
		if (refusal.reason === "no-selection") {
			return t("Select the text to convert first.");
		}
		// `nothing`: the plan found no spans - after its own lines, which say why.
		return t("Nothing to convert.");
	}

	/**
	 * What the plan saw. The warnings split into two buckets because they ask
	 * the author for different things: an unterminated delimiter is a typo to
	 * fix; a span a *guard* refused ("$5 and $6") is the guard working, and
	 * lumping the two together made a page of prices read as malformed LaTeX.
	 */
	function planLines(report, t, plan, scanned) {
		// locate.plan reports only what could not be read, and collectParagraphs
		// counts every snapshot paragraph either readable or unusable - so the
		// scanned count is the difference.
		var displayCount = plan.operations.filter(function (op) {
			return op.display;
		}).length;
		reportLine(
			report,
			t("Scanned") +
				": " +
				scanned +
				" " +
				t("paragraphs") +
				", " +
				plan.operations.length +
				" " +
				t("LaTeX spans found") +
				" (" +
				displayCount +
				" " +
				t("display") +
				")"
		);
		if (plan.unusable > 0) {
			reportLine(report, t("Paragraphs that could not be read") + ": " + plan.unusable);
		}
		if (plan.skipped.length > 0) {
			reportLine(report, t("Outside the selection") + ": " + plan.skipped.length);
		}
		if (plan.warnings.length > 0) {
			var malformed = {};
			var guarded = {};
			plan.warnings.forEach(function (warning) {
				var bucket = warning.code.indexOf("guarded-") === 0 ? guarded : malformed;
				bucket[warning.code] = (bucket[warning.code] || 0) + 1;
			});
			if (Object.keys(malformed).length > 0) {
				reportLine(report, t("Malformed delimiters") + ": " + JSON.stringify(malformed));
			}
			if (Object.keys(guarded).length > 0) {
				reportLine(report, t("Left as text by a guard") + ": " + JSON.stringify(guarded));
			}
		}
	}

	/** What the apply step did - or, through `skipped`, what it refused. */
	function applyLines(report, t, result, planned) {
		var applied = result.applied || [];
		reportLine(report, t("Converted") + ": " + applied.length + " / " + planned);
		reportLine(report, t("Undo point created") + ": " + (result.historyPoint ? t("yes") : t("no")));

		var displayCount = applied.filter(function (op) {
			return op.display;
		}).length;
		if (displayCount > 0) {
			reportLine(
				report,
				t("Display math requested") +
					": " +
					displayCount +
					", " +
					t("display mode applied via") +
					": " +
					(result.displayMode || t("unavailable"))
			);
		}

		var skipped = result.skipped || [];
		var skippedGroups = summarizeSkipped(skipped);
		Object.keys(skippedGroups).forEach(function (reason) {
			reportLine(report, t("Skipped") + " (" + reason + "): " + skippedGroups[reason]);
		});
		skipped.slice(0, 5).forEach(function (item) {
			reportLine(
				report,
				"  - " +
					item.reason +
					" @" +
					item.start +
					(item.expected ? " expected=" + JSON.stringify(item.expected) : "")
			);
		});
	}

	function applyFailureLine(t, result) {
		return t("Conversion failed") + ": " + commandFailureText(result, "no response from editor");
	}

	/** The verification pass: proves the delimiters are gone - or says so. */
	function verifyLines(report, t, remaining, converted) {
		reportLine(report, t("Delimiters still present") + ": " + remaining);
		if (remaining === 0 && converted > 0) {
			reportLine(report, t("All converted spans became native math objects."));
		}
	}

	function verifyFailureLine(t, result) {
		return t("Verification unavailable") + ": " + commandFailureText(result, "no response");
	}

	return {
		reportLine: reportLine,
		summarizeSkipped: summarizeSkipped,
		commandFailureText: commandFailureText,
		refusalLine: refusalLine,
		planLines: planLines,
		applyLines: applyLines,
		applyFailureLine: applyFailureLine,
		verifyLines: verifyLines,
		verifyFailureLine: verifyFailureLine
	};
});
