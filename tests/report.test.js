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

function renderAt(search) {
	const elements = {};
	function element(id) {
		if (!elements[id]) {
			elements[id] = { textContent: "", listeners: {}, addEventListener: function (name, fn) { this.listeners[name] = fn; } };
		}
		return elements[id];
	}

	let onReady = null;
	const document = {
		addEventListener: function (name, fn) {
			if (name === "DOMContentLoaded") {
				onReady = fn;
			}
		},
		getElementById: element
	};
	const window = { location: { search: search }, navigator: {} };

	vm.runInNewContext(REPORT_SOURCE, { window: window, document: document });
	assert.ok(onReady, "report.js registered a DOMContentLoaded handler");
	onReady();
	return elements;
}

function payloadUrl(hostPrefix) {
	return hostPrefix + "?report=" + encodeURIComponent(JSON.stringify(REPORT));
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
