/*
 * The report window reads its payload out of the query string. The desktop host
 * appends its own parameters to the URL, so the payload can arrive after a
 * *second* "?" - "report.html?lang=en-GB&theme-type=dark?report={...}" - which
 * the first implementation did not match at all. These tests drive the real
 * `report.js` against both shapes.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPORT_SOURCE = fs.readFileSync(
	path.join(__dirname, "..", "plugin", "scripts", "report.js"),
	"utf8"
);

const REPORT = {
	title: "LaTeX math conversion report",
	when: "2026-09-20T21:10:00.000Z",
	lines: ["Scanned: 4 paragraphs, 4 LaTeX spans found (1 display)", "Converted: 4 / 4"],
	converted: 4
};

/**
 * Runs the real report.js against a minimal DOM.
 *
 * `options.sdk` false omits `window.Asc.plugin`, reproducing a page whose
 * `../v1/plugins.js` did not load: the Close button must then hide itself rather
 * than look like it works.
 */
function renderAt(search, options) {
	options = options || {};
	const elements = {};
	function element(id) {
		if (!elements[id]) {
			elements[id] = {
				textContent: "",
				style: {},
				listeners: {},
				addEventListener: function (name, fn) {
					this.listeners[name] = fn;
				}
			};
		}
		return elements[id];
	}

	let onReady = null;
	const documentListeners = {};
	const document = {
		addEventListener: function (name, fn) {
			if (name === "DOMContentLoaded") {
				onReady = fn;
			}
			documentListeners[name] = fn;
		},
		getElementById: element
	};
	const windowListeners = {};
	const window = {
		location: { search: search },
		navigator: {},
		addEventListener: function (name, fn) {
			windowListeners[name] = fn;
		}
	};
	// `sdkAfterReady` models the real desktop app: ../v1/plugins.js publishes
	// Asc.plugin.windowID from an XHR callback, so the API is *not* there when the
	// page finishes parsing. A check made that early hid the Close button for good,
	// even though the host always puts the window id in the page's own URL.
	function installSdk(windowID) {
		window.calls = [];
		window.Asc = {
			plugin: {
				windowID: windowID === undefined ? "editor_1" : windowID,
				executeMethod: function (method, args) {
					window.calls.push({ method: method, args: args });
				}
			}
		};
	}
	if (options.sdk !== false && !options.sdkAfterReady) {
		installSdk(options.windowID);
	}

	vm.runInNewContext(REPORT_SOURCE, { window: window, document: document });
	assert.ok(onReady, "report.js registered a DOMContentLoaded handler");
	onReady();
	elements.window = window;
	elements.document = documentListeners;
	elements.fireLoad = function () {
		if (typeof windowListeners.load === "function") {
			windowListeners.load();
		}
	};
	if (options.sdkAfterReady) {
		installSdk(options.windowID);
	}
	return elements;
}

function payloadUrl(hostPrefix) {
	return hostPrefix + "?report=" + encodeURIComponent(JSON.stringify(REPORT));
}

/** The calls the page made into the host, copied out of the vm realm. */
function calls(elements) {
	return JSON.parse(JSON.stringify(elements.window.calls || []));
}

test("the report renders the payload when the host has not touched the URL", () => {
	const elements = renderAt(payloadUrl(""));
	assert.strictEqual(elements.title.textContent, REPORT.title);
	assert.strictEqual(elements.lines.textContent, REPORT.lines.join("\n"));
});

test("the report still renders when the host prepends its own query parameters", () => {
	// Exactly the URL observed in the real desktop app.
	const elements = renderAt(
		"?lang=en-GB&theme-type=dark" + payloadUrl("") + "&windowID=editor_1"
	);
	assert.strictEqual(elements.title.textContent, REPORT.title);
	assert.strictEqual(elements.lines.textContent, REPORT.lines.join("\n"));
});

test("a report window opened without a payload says so instead of throwing", () => {
	const elements = renderAt("?lang=en-GB&theme-type=dark");
	assert.strictEqual(elements.lines.textContent, "No report payload.");
	assert.strictEqual(elements.title.textContent, "LaTeX math");
});

test("a corrupted payload degrades to the empty report", () => {
	const elements = renderAt("?report=%7Bnot-json");
	assert.strictEqual(elements.lines.textContent, "No report payload.");
});

// ---------------------------------------------------------------------------
// Closing. The window is a plugin dialog, so the page can only close it through
// the host: `PluginWindow.prototype.close()` is exactly this call. It has to work
// from the page because the host's own dialog disables key handling and its Close
// button arrives in the *plugin* frame, not here.
// ---------------------------------------------------------------------------

test("the page's Close button closes the window through the host", () => {
	const elements = renderAt(payloadUrl("") + "&windowID=editor_7", { windowID: "editor_7" });
	elements.close.listeners.click();

	// JSON round-trip: the arrays are built inside the vm realm, and
	// deepStrictEqual compares realms.
	assert.deepStrictEqual(calls(elements), [{ method: "CloseWindow", args: ["editor_7"] }]);
});

test("Esc closes the window too, because the host disables key handling", () => {
	const elements = renderAt(payloadUrl("") + "&windowID=editor_9", { windowID: "editor_9" });
	assert.strictEqual(typeof elements.document.keydown, "function", "report.js listens for keys");

	let prevented = false;
	elements.document.keydown({
		key: "Escape",
		preventDefault: function () {
			prevented = true;
		}
	});

	assert.deepStrictEqual(calls(elements), [{ method: "CloseWindow", args: ["editor_9"] }]);
	assert.strictEqual(prevented, true, "and swallows the key");
});

test("a page without the plugin SDK hides Close instead of pretending", () => {
	const elements = renderAt(payloadUrl(""), { sdk: false });
	// No SDK and no window id in the URL: this is not a plugin window, so there is
	// nothing to close and no button is offered.
	assert.strictEqual(elements.close.style.display, "none", "no SDK, no working Close button");
	assert.strictEqual(typeof elements.document.keydown, "function", "the key handler is still bound");
	// Must not throw without Asc.plugin.
	elements.document.keydown({ key: "Escape", preventDefault: function () {} });
});

test("the Close button survives an SDK that arrives after the page has parsed", () => {
	// Measured in the desktop app: ../v1/plugins.js publishes Asc.plugin.windowID
	// from an XHR callback, so it is absent at DOMContentLoaded. Hiding the button
	// because of a check made there hid it for real users even though the host was
	// reachable (and the URL carried the id) moments later.
	const elements = renderAt(payloadUrl("") + "&windowID=editor_5", {
		sdkAfterReady: true,
		windowID: "editor_5"
	});

	assert.notStrictEqual(
		elements.close.style.display,
		"none",
		"a late SDK must not leave the window without its Close button"
	);

	elements.close.listeners.click();
	assert.deepStrictEqual(calls(elements), [{ method: "CloseWindow", args: ["editor_5"] }]);
});

test("a window with no id offers no dead Close button", () => {
	// Without a windowID the page cannot address the host's window, so a Close
	// button would be a lie.
	const elements = renderAt(payloadUrl(""), { windowID: "" });
	assert.strictEqual(elements.close.style.display, "none");
	elements.document.keydown({ key: "Escape", preventDefault: function () {} });
	assert.deepStrictEqual(calls(elements), [], "nothing is sent without a window id");
});
