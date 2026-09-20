/*
 * Report window: renders the payload the background plugin put into the URL.
 * Data travels through the query string so the window needs no cross-frame
 * messaging and can be reloaded at will.
 */
(function (window, document) {
	"use strict";

	function readReport() {
		// The desktop host appends its own parameters to the plugin window URL, so
		// the payload arrives after a second "?" -
		// "report.html?lang=en-GB&theme-type=dark?report={...}&windowID=..." -
		// which is why the separator may be either "?" or "&".
		var search = window.location.search || "";
		var match = /[?&]report=([^&]*)/.exec(search);
		if (!match) {
			return null;
		}
		try {
			return JSON.parse(decodeURIComponent(match[1]));
		} catch (e) {
			return null;
		}
	}

	function textOf(report) {
		if (!report) {
			return "No report payload.";
		}
		return (report.lines || []).join("\n");
	}

	document.addEventListener("DOMContentLoaded", function () {
		var report = readReport();
		document.getElementById("title").textContent = (report && report.title) || "LaTeX math";
		document.getElementById("when").textContent = (report && report.when) || "";
		document.getElementById("lines").textContent = textOf(report);

		document.getElementById("copy").addEventListener("click", function () {
			var text = textOf(report);
			try {
				if (window.navigator.clipboard) {
					window.navigator.clipboard.writeText(text);
				}
			} catch (e) {
				/* clipboard access is optional */
			}
		});
	});
})(window, document);
