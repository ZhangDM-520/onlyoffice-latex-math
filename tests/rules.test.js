"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// The dollar-pairing rules have exactly one owner: the fenced manifest in
// docs/adr/0001-dollar-pairing.md. Everywhere else (scan.js docblocks, README,
// docs/NOTE.md, the scan.test.js fixtures) carries rule IDs as pointers. The
// three checks below make drift a test failure instead of a review duty.
//
// The ID shape is `DP-<family>-<letter>` with optional `/suffix` entries for
// accepted losses and rejected alternatives. IDs are append-only: a new
// decision is a new ID, checked in here before it is mentioned anywhere else.

const ROOT = path.join(__dirname, "..");
const ADR = path.join("docs", "adr", "0001-dollar-pairing.md");
const POINTER_FILES = ["plugin/scripts/scan.js", "README.md", "docs/NOTE.md", "tests/scan.test.js"];
const DOC_FILES = ["README.md", "docs/NOTE.md"];

const ID = "(DP-[A-Za-z0-9-]+(?:\\/[A-Za-z0-9-]+)?)";

function read(relative) {
	return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function manifestIds() {
	const text = read(ADR);
	const block = text.match(/^```manifest\s*\n([\s\S]*?)^```/m);
	assert.ok(block, ADR + " must fence the rule manifest in a ```manifest block");
	const ids = [];
	for (const line of block[1].split("\n")) {
		const entry = line.match(new RegExp("^" + ID + "\\s*\\|"));
		if (entry) {
			ids.push(entry[1]);
		}
	}
	assert.ok(ids.length > 0, "the manifest block must contain `ID | decision` lines");
	assert.strictEqual(new Set(ids).size, ids.length, "manifest IDs must be unique");
	return ids;
}

test("every DP-* rule token in code and docs exists in the ADR manifest", () => {
	const manifest = new Set(manifestIds());
	for (const file of POINTER_FILES) {
		for (const token of read(file).match(new RegExp(ID, "g")) || []) {
			assert.ok(
				manifest.has(token),
				file + " uses " + token + ", which the ADR manifest does not own (IDs are append-only: add it to " + ADR + " first)"
			);
		}
	}
});

test("every manifest rule ID is pinned by a // rule: fixture annotation", () => {
	const annotated = new Set();
	for (const line of read("tests/scan.test.js").split("\n")) {
		const found = line.match(new RegExp("//\\s*rule:\\s*" + ID));
		if (found) {
			annotated.add(found[1]);
		}
	}
	for (const id of manifestIds()) {
		assert.ok(
			annotated.has(id),
			"no fixture in tests/scan.test.js is annotated `// rule: " + id + "` (orphan rule, or the fixture that pinned it was deleted)"
		);
	}
});

test("README and docs/NOTE.md state no numeric test counts", () => {
	// Dated counts live in the ADR's Evidence section only. The patterns are
	// deliberately narrow: version numbers (9.4.0.130), hashes, dates, line
	// counts, scale strings (100/125/150/175/200), conversion tallies
	// (`Converted: 3 / 3`) and raw `node --test` output (`-> 132`) are all
	// legitimate prose and must not trip.
	const CLAIMS = [
		/\b\d+\s*[-–—]\s*test\b/i, // "128-test suite"
		/\b\d+\s+tests?\b/i // "132 tests: scanner, ..."
	];
	const TALLY = /\b\d+\s*\/\s*\d+\b/; // "126/128" ablation ratios
	const TALLY_CONTEXT = /\b(tests?|suites?|ablations?)\b/i;
	for (const file of DOC_FILES) {
		read(file).split("\n").forEach(function (line, index) {
			const at = file + ":" + (index + 1);
			for (const claim of CLAIMS) {
				assert.ok(!claim.test(line), at + " states a numeric test count: " + JSON.stringify(line));
			}
			assert.ok(
				!(TALLY.test(line) && TALLY_CONTEXT.test(line)),
				at + " states a numeric test tally: " + JSON.stringify(line)
			);
		});
	}
});
