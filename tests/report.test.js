/*
 * The report window reads its payload out of the query string. The desktop host
 * appends its own parameters to the URL, so the payload can arrive after a
 * *second* "?" - "report.html?lang=en-GB&theme-type=dark?report={...}" - which
 * the first implementation did not match at all. These tests drive the real
 * `report.js` against both shapes.
 *
 * The payload is **producer bytes**: a real conversion run through the harness,
 * its recorded report window URL taken as the search string. Hand-building the
 * record here (as these tests used to) let producer and consumer drift apart
 * while every test stayed green. The one hand-built payload left is the corrupt
 * one below - it is deliberately not a record.
 */
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const reportRecord = require(path.join(__dirname, "..", "plugin", "scripts", "report-record.js"));
const { createEditor } = require(path.join(__dirname, "fake-editor.js"));
const { createHarness } = require(path.join(__dirname, "plugin-harness.js"));

const REPORT_SOURCE = fs.readFileSync(
	path.join(__dirname, "..", "plugin", "scripts", "report.js"),
	"utf8"
);
// report.html loads scripts/report-record.js before scripts/report.js; the
// sandbox below reproduces that order so the page script runs as it ships.
const RECORD_SOURCE = fs.readFileSync(
	path.join(__dirname, "..", "plugin", "scripts", "report-record.js"),
	"utf8"
);

/*
 * Producer bytes, once per run: the real code.js converting `$a$` through the
 * harness with the report window on. `search` is exactly the query string the
 * window page sees after "report.html"; `record` is the report the producer
 * kept - the expected value behind every rendering assertion below.
 */
let produced = null;
before(async () => {
	const editor = createEditor({ paragraphs: ["$a$"], selection: { start: 0, end: 3 } });
	const harness = createHarness(editor);
	harness.window.localStorage.setItem(
		"onlyoffice-latex-math.settings",
		JSON.stringify({ version: 2, openReport: true })
	);
	harness.init();
	await harness.convertSelection();
	const url = harness.harness.windows[0].variation.url;
	produced = {
		search: url.substring(url.indexOf("report.html") + "report.html".length),
		record: JSON.parse(JSON.stringify(harness.getLastReport()))
	};
	assert.strictEqual(produced.search.indexOf("?report="), 0, "the producer URL carries the payload");
});

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
	if (options.clipboard) {
		window.navigator.clipboard = options.clipboard;
	}
	// `report.js` reports clipboard failures rather than swallowing them, so the
	// sandbox has to offer the console it talks to.
	const logs = [];
	const consoleStub = {
		error: function () {
			logs.push(Array.prototype.slice.call(arguments).map(String).join(" "));
		}
	};
	const sandbox = { window: window, document: document, console: consoleStub, self: window };
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

	vm.createContext(sandbox);
	vm.runInContext(RECORD_SOURCE, sandbox, { filename: "report-record.js" });
	vm.runInContext(REPORT_SOURCE, sandbox, { filename: "report.js" });
	assert.ok(onReady, "report.js registered a DOMContentLoaded handler");
	onReady();
	elements.window = window;
	elements.document = documentListeners;
	elements.errors = logs;
	elements.click = function (id) {
		const handlers = elements[id] && elements[id].listeners;
		if (!handlers || typeof handlers.click !== "function") {
			return undefined;
		}
		return handlers.click();
	};
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

/** The calls the page made into the host, copied out of the vm realm. */
function calls(elements) {
	return JSON.parse(JSON.stringify(elements.window.calls || []));
}

test("the report renders the producer's payload when the host has not touched the URL", () => {
	const elements = renderAt(produced.search);
	// Anchored on the conversion's own wording, so a producer that stopped
	// filling the record cannot pass by matching an empty expectation.
	assert.strictEqual(elements.title.textContent, "Convert selection");
	assert.match(elements.lines.textContent, /Converted: 1 \/ 1/);
	assert.strictEqual(elements.lines.textContent, reportRecord.textOf(produced.record));
});

test("the URL decodes back to exactly the record the producer kept", () => {
	assert.deepStrictEqual(reportRecord.decode(produced.search), produced.record);
});

test("the report still renders when the host prepends its own query parameters", () => {
	// Exactly the URL observed in the real desktop app: the host's own
	// parameters land between "report.html" and the producer's payload, which is
	// where the second "?" comes from.
	const elements = renderAt("?lang=en-GB&theme-type=dark" + produced.search + "&windowID=editor_1");
	assert.strictEqual(elements.title.textContent, "Convert selection");
	assert.strictEqual(elements.lines.textContent, reportRecord.textOf(produced.record));
});

test("a record round-trips through its URL form", () => {
	const record = reportRecord.make("round trip");
	assert.deepStrictEqual(reportRecord.decode(reportRecord.encode(record)), record);
});

test("encode reproduces the pre-module payload URL byte for byte", () => {
	// `code.js` showReport used to inline
	// `"?report=" + encodeURIComponent(JSON.stringify(report))`; moving the seam
	// into report-record.js must not change a byte. The record below is frozen
	// *input* for the encoder - not a stand-in for producer output - which is
	// what lets the expected string be a literal.
	const record = {
		title: "LaTeX math conversion report",
		when: "2026-09-20 21:10:00",
		lines: ["Converted: 4 / 4"],
		converted: 4
	};
	assert.strictEqual(
		reportRecord.encode(record),
		"?report=%7B%22title%22%3A%22LaTeX%20math%20conversion%20report%22%2C%22when%22%3A%222026-09-20%2021%3A10%3A00%22%2C%22lines%22%3A%5B%22Converted%3A%204%20%2F%204%22%5D%2C%22converted%22%3A4%7D"
	);
});

test("both pages load report-record.js before the script that consumes it", () => {
	// A missing or late script tag is invisible until a real window renders
	// "No report payload."; the shipped load order is a test failure instead.
	function order(page, first, second) {
		const html = fs.readFileSync(path.join(__dirname, "..", "plugin", page), "utf8");
		const a = html.indexOf(first);
		const b = html.indexOf(second);
		assert.ok(a >= 0, page + " must load " + first);
		assert.ok(b >= 0, page + " must load " + second);
		assert.ok(a < b, page + " must load " + first + " before " + second);
	}
	order("index.html", "scripts/report-record.js", "scripts/code.js");
	order("report.html", "scripts/report-record.js", "scripts/report.js");
});

test("a report window opened without a payload says so instead of throwing", () => {
	const elements = renderAt("?lang=en-GB&theme-type=dark");
	assert.strictEqual(elements.lines.textContent, "No report payload.");
	assert.strictEqual(elements.title.textContent, "LaTeX math");
});

test("a corrupted payload degrades to the empty report", () => {
	// Hand-built on purpose: a corrupt payload is deliberately not a record.
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
	const elements = renderAt(produced.search + "&windowID=editor_7", { windowID: "editor_7" });
	elements.close.listeners.click();

	// JSON round-trip: the arrays are built inside the vm realm, and
	// deepStrictEqual compares realms.
	assert.deepStrictEqual(calls(elements), [{ method: "CloseWindow", args: ["editor_7"] }]);
});

test("Esc closes the window too, because the host disables key handling", () => {
	const elements = renderAt(produced.search + "&windowID=editor_9", { windowID: "editor_9" });
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
	const elements = renderAt(produced.search, { sdk: false });
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
	const elements = renderAt(produced.search + "&windowID=editor_5", {
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
	const elements = renderAt(produced.search, { windowID: "" });
	assert.strictEqual(elements.close.style.display, "none");
	elements.document.keydown({ key: "Escape", preventDefault: function () {} });
	assert.deepStrictEqual(calls(elements), [], "nothing is sent without a window id");
});

// The Copy button. `writeText` returns a promise and the Clipboard API is absent
// without a secure context, so both failure modes used to be invisible: the
// button looked like it worked and nothing was copied.
test("the Copy button writes the report to the clipboard", () => {
	const written = [];
	const elements = renderAt(produced.search, {
		clipboard: {
			writeText: function (text) {
				written.push(text);
				return Promise.resolve();
			}
		}
	});

	assert.strictEqual(elements.click("copy"), true);
	assert.deepStrictEqual(written, [reportRecord.textOf(produced.record)]);
	assert.deepStrictEqual(elements.errors, []);
});

test("a refused clipboard write is reported, not swallowed", async () => {
	const elements = renderAt(produced.search, {
		clipboard: {
			writeText: function () {
				return Promise.reject(new Error("denied"));
			}
		}
	});

	elements.click("copy");
	await Promise.resolve().then(() => {});
	assert.strictEqual(elements.errors.length, 1, "the rejection reaches the console");
	assert.match(elements.errors[0], /could not copy the report/);
});

test("a page without a clipboard API says so instead of pretending", () => {
	const elements = renderAt(produced.search);

	assert.strictEqual(elements.click("copy"), false);
	assert.strictEqual(elements.errors.length, 1);
	assert.match(elements.errors[0], /no clipboard API/);
});
