/*
 * The report record: the one owner of the payload shape that crosses from the
 * plugin frame into the report window's page, and of its URL serialization -
 * which is the seam itself. `code.js` authors reports (`make` + `encode`),
 * `report.js` renders them (`decode` + `textOf`), and neither knows the field
 * layout: before this file, renaming a field in `code.js` left every report
 * test green while the real window rendered "No report payload."
 *
 * Interface:
 *   make(title)      -> {title, when, lines, converted}   (the record)
 *   encode(report)   -> "?report=" + encodeURIComponent(JSON.stringify(r))
 *   decode(search)   -> record | null   (null: absent or corrupt payload)
 *   textOf(report)   -> lines.join("\n") ("No report payload." when absent)
 *
 * Realm-safe, and loaded by script tag in *both* realms: `plugin/index.html`
 * before `code.js`, `plugin/report.html` before `report.js`. It registers
 * nothing and touches no window/document/host API, which is what lets the
 * report page load it safely - `report.html` must never load `code.js` itself,
 * or it would re-register the plugin's menus from a second frame
 * (docs/NOTE.md §1.5).
 *
 * The close protocol, once - the two call sites (`code.js`
 * `Asc.plugin.button`, `report.js` `closeSelf`) point here by name instead of
 * restating it:
 *   - the dialog footer button (id 0) and the header X (id -1) both arrive in
 *     the *plugin frame* as `Asc.plugin.button(id, windowId)` (code.js); every
 *     id closes the report window. Without that hook the host's injected
 *     router throws and nothing closes at all - measured 9.4.0.130-1, the
 *     router source in docs/NOTE.md §1.5;
 *   - the page's own Close button and `Esc` close through
 *     `executeMethod("CloseWindow", [windowID])` (report.js `closeSelf`) -
 *     `PluginWindow.prototype.close()` is exactly that call, but the page has
 *     no PluginWindow instance of its own, only its id; `Esc` is the page's job
 *     because the host's dialog sets `enableKeyEvents: false`;
 *   - `../v1/plugins.js` publishes `windowID` from an **XHR callback**, later
 *     than `DOMContentLoaded` (docs/NOTE.md §1.9), so the page reads the id
 *     out of its own URL and binds the button unconditionally - a check made
 *     at parse time hid the button for real users.
 *
 * Out of this interface on purpose: report *authoring* (code.js
 * `reportLine`/`summarizeSkipped` - conversion wording, not record shape) and
 * the page's realm-specific behaviour (report.js `copyText`/`closeSelf`).
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.OnlyOfficeLatexMathReportRecord = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	// The field layout - the whole point of this file.
	function make(title) {
		return {
			title: title,
			when: new Date().toISOString().replace("T", " ").substring(0, 19),
			lines: [],
			converted: 0
		};
	}

	// The separator is deliberately a bare "?": the desktop host appends its own
	// parameters to the window URL first, so the payload regularly arrives after
	// a *second* "?" - "report.html?lang=en-GB&theme-type=dark?report={...}".
	// `encode` always produces that first "?report=" and `decode` accepts either
	// separator, so the quirk lives in this one pair and nowhere else.
	function encode(report) {
		return "?report=" + encodeURIComponent(JSON.stringify(report));
	}

	function decode(search) {
		var match = /[?&]report=([^&]*)/.exec(search || "");
		if (!match) {
			return null;
		}
		try {
			return JSON.parse(decodeURIComponent(match[1]));
		} catch (e) {
			// A corrupt payload is not a crash: the window degrades to the empty
			// report rather than failing to open.
			return null;
		}
	}

	function textOf(report) {
		if (!report) {
			return "No report payload.";
		}
		return (report.lines || []).join("\n");
	}

	return {
		make: make,
		encode: encode,
		decode: decode,
		textOf: textOf
	};
});
