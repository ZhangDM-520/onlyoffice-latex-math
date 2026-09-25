/*
 * The editor-page seam: `commands.js` `run(name, payload)` driven against the
 * fake host.
 *
 * The real host answers `Asc.plugin.callCommand` asynchronously and evaluates
 * the command in the editor page at *evaluation* time, reading the shared
 * `Asc.scope` payload slot then - which is what lets two overlapping conversions
 * swap payloads (measured live: such runs answered `unparsable-command-result`
 * or `no response from editor`). A synchronous double cannot express any of
 * these shapes, so each test here drives one seam failure through the deferred
 * harness (`tests/plugin-harness.js` documents the host behaviour its knobs
 * mirror).
 *
 * No test inits the menus: `run` is the whole surface under test, and a stray
 * `probe` round trip would race the run each test is about.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { createEditor } = require(path.join(__dirname, "fake-editor.js"));
const { createHarness } = require(path.join(__dirname, "plugin-harness.js"));

/** A `resolve` payload whose echoed `index` says which payload the command read. */
function resolveSpec(index) {
	return { paragraphs: [{ index: index, text: "", start: 0, span: 0, need: [] }] };
}

function resolveEcho(index) {
	return { paragraphs: [{ index: index, positions: {} }] };
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The seam's answers cross the VM realm boundary, so its error objects carry
 * the fake plugin frame's `Object.prototype`, not this realm's. The contract is
 * the JSON shape - compare that, prototypes and all.
 */
function assertResult(actual, expected, message) {
	assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}

test("a dropped answer is a typed timeout, and its late answer is ignored", async () => {
	// The host answers every command 60 ms late - past the 25 ms backstop this
	// run arms. The answer of the timed-out run must not reach anything.
	const harness = createHarness(createEditor({ paragraphs: ["$a$"] }), { commandDelay: 60 });
	const hung = harness.runCommand("resolve", resolveSpec(1), 25);
	assertResult(await hung, { error: "timeout" });

	// The next run owns the slot now; when the first run's answer finally
	// lands it must be discarded (settled as `clobbered`), not misrouted here.
	// Its backstop must outlast the 60 ms answer delay, or it would time out
	// for its own reason and prove nothing.
	const next = harness.runCommand("resolve", resolveSpec(2), 200);
	assertResult(await next, resolveEcho(2));
	assertResult(await hung, { error: "timeout" }, "the late answer cannot revive the finished run");
	assert.deepStrictEqual(harness.harness.errors, []);
});

test("an unparsable answer is named and keeps its raw text", async () => {
	const harness = createHarness(createEditor({ paragraphs: ["$a$"] }), { commandRaw: "this is not JSON" });
	assertResult(await harness.runCommand("read", {}), {
		error: "unparsable-command-result",
		raw: "this is not JSON"
	});
});

test("overlapping runs keep their own payloads (the clobber fix)", async () => {
	// The host's overlap pathology: a second conversion re-enters `run` before
	// the first command has answered. The owner serialises, so the second run
	// queues and the shared Asc.scope slot is never written under the first.
	let second = null;
	let withOverlap = null;
	withOverlap = createHarness(createEditor({ paragraphs: ["$a$"] }), {
		commandOverlaps: function () {
			second = withOverlap.runCommand("resolve", resolveSpec(2));
		}
	});

	const first = withOverlap.runCommand("resolve", resolveSpec(1));
	assert.strictEqual(
		withOverlap.harness.executedCommands.length,
		1,
		"the re-entered run queues: one command in flight, one shared payload slot"
	);
	assert.ok(second, "the overlap hook re-entered run");
	assertResult(await first, resolveEcho(1), "the first command read the first payload");
	assertResult(await second, resolveEcho(2), "and the queued run read its own");
});

test("runs are serialised behind a hung one and time out in order", async () => {
	// The queueing tradeoff, pinned: the alternative (fail-fast supersede)
	// would let the second run start now and answer the first `clobbered`.
	const harness = createHarness(createEditor({ paragraphs: ["$a$"] }), { commandNeverAnswers: true });
	const order = [];
	const first = harness.runCommand("read", {}, 30).then((result) => {
		order.push("first");
		return result;
	});
	const second = harness.runCommand("read", {}, 30).then((result) => {
		order.push("second");
		return result;
	});
	assertResult(await Promise.all([first, second]), [{ error: "timeout" }, { error: "timeout" }]);
	assert.deepStrictEqual(order, ["first", "second"]);
	assert.strictEqual(harness.harness.executedCommands.length, 2, "both runs got their round trip");
});

test("a host without callCommand is an explicit error", async () => {
	const harness = createHarness(createEditor({ paragraphs: ["$a$"] }));
	delete harness.window.Asc.plugin.callCommand;
	assertResult(await harness.runCommand("read", {}), { error: "callCommand-unavailable" });
});

test("a callCommand that throws is named with its message", async () => {
	const harness = createHarness(createEditor({ paragraphs: ["$a$"] }));
	harness.window.Asc.plugin.callCommand = function () {
		throw new Error("host exploded");
	};
	assertResult(await harness.runCommand("read", {}), { error: "callCommand-threw: host exploded" });
});

test("a synchronously-answered run leaves no orphaned backstop timer", async () => {
	const harness = createHarness(createEditor({ paragraphs: ["$a$"] }));
	// A host build that answers inside the callCommand stack: the backstop is
	// armed before dispatch precisely so the first settle can clear it.
	harness.window.Asc.plugin.callCommand = function (commandFn, isClose, isCalc, callback) {
		callback(JSON.stringify({ answeredAtOnce: true }));
	};
	assertResult(await harness.runCommand("read", {}, 25), { answeredAtOnce: true });
	const backstops = harness.harness.timers.filter((record) => record.delay === 25);
	assert.strictEqual(backstops.length, 1, "one backstop was armed");
	assert.strictEqual(backstops[0].cleared, true, "cleared by the synchronous answer");
	await wait(40);
	assert.strictEqual(backstops[0].fired, false, "and it never fires as an orphan");
});

test("a duplicated callback cannot displace the settled answer", async () => {
	const harness = createHarness(createEditor({ paragraphs: ["$a$"] }));
	harness.window.Asc.plugin.callCommand = function (commandFn, isClose, isCalc, callback) {
		callback(JSON.stringify({ answer: "first" }));
		callback(JSON.stringify({ answer: "second" }));
	};
	assertResult(await harness.runCommand("read", {}), { answer: "first" });
});

test("an unknown command name is a caller error, not a seam failure", () => {
	const harness = createHarness(createEditor({ paragraphs: ["$a$"] }));
	assert.throws(() => harness.runCommand("bogus", {}), /unknown editor command: bogus/);
});
