/*
 * The conversion pipeline: `decide` on its own, and the stage order the
 * pipeline sequences - neither needs the full fake host. `tests/integration.test.js`
 * owns the end-to-end pins (fixtures, selection filter, stale-plan refusal);
 * this file loads code.js against a stub window just rich enough for the
 * composition root to wire itself, with a stub `commands` module standing in
 * for the editor seam and recording every call it receives.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPTS = path.join(__dirname, "..", "plugin", "scripts");
const CODE_SOURCE = fs.readFileSync(path.join(SCRIPTS, "code.js"), "utf8");

const SETTINGS_ALL_ON = {
	inlineDollar: true,
	displayDollar: true,
	inlineParen: true,
	displayBracket: true,
	openReport: false
};
const SETTINGS_ALL_OFF = Object.assign({}, SETTINGS_ALL_ON, {
	inlineDollar: false,
	displayDollar: false,
	inlineParen: false,
	displayBracket: false
});

// `responses[name]` is a queue of seam answers (the last one repeats).
function createStubCommands(responses) {
	const calls = [];
	return {
		calls: calls,
		run: function (name, payload) {
			calls.push({ name: name, payload: payload });
			const queue = responses[name] || [];
			const answer = queue.length > 1 ? queue.shift() : queue[0];
			return Promise.resolve(answer === undefined ? {} : answer);
		}
	};
}

/**
 * Load code.js the way index.html does - the UMD modules in their script-tag
 * order, code.js last - against a stub window. The pure modules are ordinary
 * Node requires (their CommonJS branch); only code.js needs a realm, because
 * it is an IIFE over `window`.
 */
function loadPlugin(responses) {
	const commands = createStubCommands(responses || {});
	const windowStub = {
		Asc: { plugin: { guid: "pipeline-test" } },
		localStorage: {
			data: {},
			getItem: function (key) {
				return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
			},
			setItem: function (key, value) {
				this.data[key] = String(value);
			}
		},
		OnlyOfficeLatexMath: require(path.join(SCRIPTS, "scan.js")),
		OnlyOfficeLatexMathCommands: commands,
		OnlyOfficeLatexMathLocate: require(path.join(SCRIPTS, "locate.js")),
		OnlyOfficeLatexMathReportRecord: require(path.join(SCRIPTS, "report-record.js")),
		OnlyOfficeLatexMathHotkeys: require(path.join(SCRIPTS, "hotkeys.js")),
		OnlyOfficeLatexMathReportText: require(path.join(SCRIPTS, "report-text.js")),
		OnlyOfficeLatexMathSettings: require(path.join(SCRIPTS, "settings.js"))
	};
	windowStub.window = windowStub;
	vm.runInNewContext(CODE_SOURCE, { window: windowStub, console: { log: function () {}, error: function () {} } }, {
		filename: "code.js"
	});
	return { windowStub: windowStub, commands: commands, api: windowStub.OnlyOfficeLatexMathApi };
}

// Decisions cross the vm realm; compare their shape, not their prototypes.
function shape(value) {
	return JSON.parse(JSON.stringify(value));
}

function oneSpanSnapshot(selection) {
	return { paragraphs: [{ start: 0, end: 6, text: "$x$\r\n" }], selection: selection };
}

// ---------------------------------------------------------------------------
// decide: the policy, pure.
// ---------------------------------------------------------------------------

test("decide refuses when no delimiter is enabled - whatever the snapshot says", () => {
	const { api } = loadPlugin();
	// Settings policy wins over snapshot state: this is the same answer the
	// pre-pipeline code gave before it ever read the document.
	assert.deepStrictEqual(shape(api.decide({ error: "timeout" }, SETTINGS_ALL_OFF)), {
		proceed: false,
		refusal: { reason: "no-delimiters" }
	});
	assert.deepStrictEqual(shape(api.decide(oneSpanSnapshot({ start: 0, end: 6 }), SETTINGS_ALL_OFF)), {
		proceed: false,
		refusal: { reason: "no-delimiters" }
	});
});

test("decide refuses an unreadable document, and names the failure", () => {
	const { api } = loadPlugin();
	assert.deepStrictEqual(shape(api.decide(null, SETTINGS_ALL_ON)), {
		proceed: false,
		refusal: { reason: "unreadable", detail: null }
	});
	assert.deepStrictEqual(shape(api.decide({ error: "timeout" }, SETTINGS_ALL_ON)), {
		proceed: false,
		refusal: { reason: "unreadable", detail: { error: "timeout" } }
	});
});

test("decide treats a collapsed caret as a no-op", () => {
	const { api } = loadPlugin();
	[{ start: 2, end: 2 }, null, undefined].forEach((selection) => {
		const snapshot = { paragraphs: [], selection: selection };
		assert.deepStrictEqual(
			shape(api.decide(snapshot, SETTINGS_ALL_ON)),
			{ proceed: false, refusal: { reason: "no-selection" } },
			"collapsed or missing selection: " + JSON.stringify(selection)
		);
	});
});

test("decide proceeds with the selection that scoped the run", () => {
	const { api } = loadPlugin();
	const decision = api.decide(oneSpanSnapshot({ start: 0, end: 6 }), SETTINGS_ALL_ON);
	assert.deepStrictEqual(shape(decision), { proceed: true, selection: { start: 0, end: 6 } });
});

// ---------------------------------------------------------------------------
// The stage order: read -> decide -> plan -> apply -> verify -> render.
// ---------------------------------------------------------------------------

test("the pipeline sequences its stages, and renders their report in order", async () => {
	// read -> (plan's probe) -> apply -> the verify re-read. The verify plan
	// finds no spans left, so it answers without a second probe.
	const { commands, api, windowStub } = loadPlugin({
		read: [
			oneSpanSnapshot({ start: 0, end: 6 }),
			{ paragraphs: [{ start: 0, end: 3, text: "x\r\n" }], selection: { start: 0, end: 6 } }
		],
		resolve: [{ paragraphs: [] }],
		apply: [{ applied: [{ display: false }], skipped: [], historyPoint: true }]
	});
	windowStub.Asc.plugin.init();
	commands.calls.length = 0; // drop the readiness probe from the record

	const report = await api.convertSelection();

	assert.deepStrictEqual(
		commands.calls.map((call) => call.name),
		["read", "resolve", "apply", "read"],
		"read -> decide -> plan -> apply -> verify -> render"
	);
	assert.deepStrictEqual(report.lines, [
		"Scanned: 1 paragraphs, 1 LaTeX spans found (0 display)",
		"Converted: 1 / 1",
		"Undo point created: yes",
		"Delimiters still present: 0",
		"All converted spans became native math objects."
	]);
	assert.strictEqual(report.converted, 1);
});

test("a refusal stops the pipeline at decide and renders one line", async () => {
	const { commands, api, windowStub } = loadPlugin({
		read: [oneSpanSnapshot({ start: 2, end: 2 })]
	});
	windowStub.Asc.plugin.init();
	commands.calls.length = 0;

	const report = await api.convertSelection();

	assert.deepStrictEqual(commands.calls.map((call) => call.name), ["read"], "no plan, no apply, no verify");
	assert.deepStrictEqual(report.lines, ["Select the text to convert first."]);
});

test("an empty plan refuses after its own lines, and never applies", async () => {
	const { commands, api, windowStub } = loadPlugin({
		read: [{ paragraphs: [{ start: 0, end: 11, text: "plain text\r\n" }], selection: { start: 0, end: 11 } }]
	});
	windowStub.Asc.plugin.init();
	commands.calls.length = 0;

	const report = await api.convertSelection();

	assert.deepStrictEqual(commands.calls.map((call) => call.name), ["read"], "no spans, so not even a probe");
	assert.deepStrictEqual(report.lines, [
		"Scanned: 1 paragraphs, 0 LaTeX spans found (0 display)",
		"Nothing to convert."
	]);
});
