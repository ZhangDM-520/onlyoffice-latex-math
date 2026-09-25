/*
 * Report window: renders the payload the background plugin put into the URL, and
 * closes itself.
 *
 * Data travels through the query string so the window needs no cross-frame
 * messaging and can be reloaded at will. The record shape, its URL encoding and
 * the close protocol this page takes part in all have one owner:
 * report-record.js's header (loaded by report.html just before this file, and
 * realm-safe - never load scripts/code.js here, it would re-register the
 * menus). What stays here is the page-realm behaviour itself: rendering,
 * copy-to-clipboard, and this half of closing.
 *
 * ../v1/plugins.js is loaded by report.html for this: it publishes this page's
 * `windowID` from its own URL and provides `executeMethod`.
 */
(function (window, document) {
	"use strict";

	var reportRecord = window.OnlyOfficeLatexMathReportRecord;
	if (!reportRecord) {
		// Loading-order problem (report.html must load scripts/report-record.js
		// before this file): fail loudly instead of rendering a lie.
		console.error("[latex-math] report-record.js missing");
		return;
	}

	function readReport() {
		// The host appends its own parameters to the window URL first, so the
		// payload may arrive after a second "?" - the separator tolerance is
		// part of the seam report-record.js owns.
		return reportRecord.decode(window.location.search || "");
	}

	function plugin() {
		return window.Asc && window.Asc.plugin ? window.Asc.plugin : null;
	}

	/** True when the page can close its own window through the host. */
	function canClose() {
		var api = plugin();
		return !!(api && typeof api.executeMethod === "function" && api.windowID);
	}

	/**
	 * Put the report on the clipboard, and *say so* when that fails.
	 *
	 * `navigator.clipboard.writeText` returns a promise, so a refused permission
	 * used to disappear completely: the button looked like it worked and nothing
	 * was copied, with no error anywhere to explain it. The API is also absent on
	 * a page without a secure context, which is why the missing-API case is
	 * reported rather than ignored.
	 */
	function copyText(text) {
		var clipboard = window.navigator && window.navigator.clipboard;
		if (!clipboard || typeof clipboard.writeText !== "function") {
			console.error("[latex-math] no clipboard API on this page; the report was not copied");
			return false;
		}
		try {
			var written = clipboard.writeText(text);
			if (written && typeof written.then === "function") {
				written.then(null, function (error) {
					console.error("[latex-math] could not copy the report", error);
				});
			}
			return true;
		} catch (e) {
			console.error("[latex-math] could not copy the report", e);
			return false;
		}
	}

	// The page half of the close protocol - its one description lives in
	// report-record.js's header (why this call closes the window is there too).
	function closeSelf() {
		var api = plugin();
		if (!api || typeof api.executeMethod !== "function") {
			return false;
		}
		if (!api.windowID) {
			return false;
		}
		api.executeMethod("CloseWindow", [api.windowID]);
		return true;
	}

	// The windowID XHR race this works around is described in report-record.js's
	// header (docs/NOTE.md §1.9): the SDK's copy of the id may not exist yet at
	// parse time, but the host always appends it to this page's own URL, so read
	// it there and hide the button only when neither source can supply one.
	function urlWindowId() {
		var match = /[?&]windowID=([^&]*)/.exec(window.location.search || "");
		return match ? match[1] : "";
	}

	document.addEventListener("DOMContentLoaded", function () {
		var report = readReport();
		document.getElementById("title").textContent = (report && report.title) || "LaTeX math";
		document.getElementById("when").textContent = (report && report.when) || "";
		document.getElementById("lines").textContent = reportRecord.textOf(report);

		document.getElementById("copy").addEventListener("click", function () {
			return copyText(reportRecord.textOf(report));
		});

		var closeButton = document.getElementById("close");
		if (closeButton) {
			// Bound unconditionally, because the windowID XHR race means the SDK
			// is not necessarily ready yet (report-record.js's header): a click
			// that arrives before it lands closes the window as soon as it does,
			// whereas a button hidden by an early check is gone for good.
			closeButton.addEventListener("click", closeSelf);
			if (!canClose() && !urlWindowId()) {
				// Neither the SDK nor the URL identifies a host window: this page is
				// not a plugin window (opened standalone), so offer no dead button.
				closeButton.style.display = "none";
			}
		}

		// Esc is the page's half of the close protocol (report-record.js's
		// header): the host's dialog disables its own key handling.
		document.addEventListener("keydown", function (event) {
			if (event.key === "Escape" || event.keyCode === 27) {
				if (closeSelf()) {
					event.preventDefault();
				}
			}
		});
	});

	// Exposed for the tests and for manual testing from the window console.
	window.OnlyOfficeLatexMathReport = {
		readReport: readReport,
		closeSelf: closeSelf,
		canClose: canClose,
		copyText: copyText
	};
})(window, document);
