/*
 * Report window: renders the payload the background plugin put into the URL, and
 * closes itself.
 *
 * Data travels through the query string so the window needs no cross-frame
 * messaging and can be reloaded at will. Closing is the page's own job as well
 * as the host's: the host's dialog footer button and header X both arrive in the
 * plugin frame (see Asc.plugin.button in code.js), but the page also offers a
 * Close button and Esc so the window is never a trap.
 *
 * ../v1/plugins.js is loaded by report.html for this: it publishes this page's
 * `windowID` from its own URL and provides `executeMethod`.
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

	function closeSelf() {
		var api = plugin();
		if (!api || typeof api.executeMethod !== "function") {
			return false;
		}
		if (!api.windowID) {
			return false;
		}
		// PluginWindow.prototype.close() does exactly this; the page has no
		// PluginWindow instance of its own, only its id.
		api.executeMethod("CloseWindow", [api.windowID]);
		return true;
	}

	// ../v1/plugins.js publishes Asc.plugin.windowID from an **XHR callback**, so
	// it does not exist yet when this page finishes parsing: in the real desktop
	// app the Close button was therefore hidden by the check that used to happen
	// here, while `Esc` kept working because it re-resolves the API at keydown
	// time. Do not try to time it either - read the same id out of this page's own
	// URL, which the host always appends, and hide the button only when neither
	// source can supply one.
	function urlWindowId() {
		var match = /[?&]windowID=([^&]*)/.exec(window.location.search || "");
		return match ? match[1] : "";
	}

	document.addEventListener("DOMContentLoaded", function () {
		var report = readReport();
		document.getElementById("title").textContent = (report && report.title) || "LaTeX math";
		document.getElementById("when").textContent = (report && report.when) || "";
		document.getElementById("lines").textContent = textOf(report);

		document.getElementById("copy").addEventListener("click", function () {
			return copyText(textOf(report));
		});

		var closeButton = document.getElementById("close");
		if (closeButton) {
			// Bound unconditionally: the SDK is not necessarily ready yet, and a
			// click that arrives before it lands closes the window as soon as it
			// does, whereas a button hidden by an early check is gone for good.
			closeButton.addEventListener("click", closeSelf);
			if (!canClose() && !urlWindowId()) {
				// Neither the SDK nor the URL identifies a host window: this page is
				// not a plugin window (opened standalone), so offer no dead button.
				closeButton.style.display = "none";
			}
		}

		// The host's dialog disables its own key handling for plugin windows, so
		// Esc is handled here.
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
