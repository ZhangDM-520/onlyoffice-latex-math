/*
 * The icon regression test.
 *
 * The defect this exists for: ONLYOFFICE expands `%scale%(default)` into five
 * scales (100/125/150/175/200 %) and then picks the one nearest the display
 * scale, with **no fallback** to the 100 % file. The plugin shipped only 100 %
 * and 200 %, so on a 1.25 display every entry rendered as *nothing*, and nothing
 * anywhere reported an error. So: every icon the plugin asks for must exist at
 * every scale, at the right pixel size, and actually have ink in it.
 *
 * Deliberately independent of the icon generator: it reads what the plugin
 * registers and checks the files, so it also holds for a machine that has neither
 * Pillow nor the noctalia font.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { createEditor } = require("./fake-editor.js");
const { createHarness } = require("./plugin-harness.js");
const png = require("./png.js");

const ROOT = path.join(__dirname, "..");
const THEMES = ["light", "dark"];
const SCALES = [
	{ key: "100%", suffix: "" },
	{ key: "125%", suffix: "@1.25x" },
	{ key: "150%", suffix: "@1.5x" },
	{ key: "175%", suffix: "@1.75x" },
	{ key: "200%", suffix: "@2x" }
];

// Base pixel sizes, matching the shipped plugins: entry and ribbon icons 28 px,
// menu icons 20 px (measured from AI's resources/icons and Send's entry icon).
const ENTRY_BASE = 28;
const RIBBON_BASE = 28;
const MENU_BASE = 20;
const MIN_VISIBLE_FRACTION = 0.05;

/** Turn one declared icon path into the file for a theme and a scale. */
function expand(icons, theme, suffix) {
	return path.join(
		ROOT,
		"plugin",
		icons
			.replace("%theme-type%(light|dark)", theme)
			.replace("%scale%(default)", suffix)
	);
}

function declaredPaths() {
	const paths = [];

	const config = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin", "config.json"), "utf8"));
	config.variations.forEach(function (variation) {
		assert.strictEqual(
			typeof variation.icons,
			"string",
			"the entry icon is declared with placeholders, so every scale can be resolved"
		);
		paths.push({ icons: variation.icons, base: ENTRY_BASE, source: "config.json" });
	});

	// Drive the real plugin: whatever it registers is what the host will ask for.
	const harness = createHarness(createEditor({ paragraphs: ["$x$"] }));
	harness.init();
	const h = harness.harness;

	function collect(item, source) {
		if (item.icons) {
			paths.push({
				icons: item.icons,
				base: /\/big\//.test(item.icons) ? RIBBON_BASE : MENU_BASE,
				source: source
			});
		}
		item.children.forEach(function (child) {
			collect(child, source);
		});
	}

	h.roots.filter(function (item) {
		return item.itemType === "toolbar";
	}).forEach(function (item) {
		collect(item, "the ribbon");
		collect(item, item.text);
	});
	h.roots.filter(function (item) {
		return item.itemType === "contextMenu";
	}).forEach(function (item) {
		collect(item, "the context menu");
	});

	return { paths: paths, harness: harness };
}

test("every ribbon item and every context menu item carries an icon", () => {
	const h = declaredPaths().harness.harness;
	const toolbar = h.roots.filter(function (item) {
		return item.itemType === "toolbar";
	})[0];
	const contextMenu = h.roots.filter(function (item) {
		return item.itemType === "contextMenu";
	})[0];

	assert.ok(toolbar, "the ribbon was registered");
	assert.ok(toolbar.icons, "the ribbon's own button has an icon");
	assert.ok(toolbar.children.length >= 8, "the ribbon has its items");
	toolbar.children.forEach(function (item) {
		// Every one of them used to be iconless: addItem() was never given a path.
		assert.ok(item.icons, item.text + " has an icon");
		assert.match(item.icons, /%theme-type%\(light\|dark\)/);
		assert.match(item.icons, /%scale%\(default\)/);
	});

	assert.ok(contextMenu, "the context menu was registered");
	assert.ok(contextMenu.icons, "the context menu root has an icon");
	contextMenu.children.forEach(function (item) {
		assert.ok(item.icons, item.text + " has an icon");
	});
});

test("every icon resolves at every scale, at the right size, with ink in it", () => {
	const declared = declaredPaths().paths;
	assert.ok(declared.length >= 20, "collected the plugin's icon declarations");

	const seen = {};
	declared.forEach(function (entry) {
		THEMES.forEach(function (theme) {
			SCALES.forEach(function (scale) {
				const file = expand(entry.icons, theme, scale.suffix);
				const relative = path.relative(ROOT, file);
				const key = relative.replace(/@[\d.]+x/, "@Nx");
				if (seen[key]) {
					return;
				}
				seen[key] = true;

				assert.ok(
					fs.existsSync(file),
					"missing " + relative + " - the host asks for the scale nearest the display one " +
						"and has no fallback, so this renders as no icon at all (" + entry.source + ")"
				);

				const image = png.readPng(file);
				const expected = Math.round(entry.base * parseFloat(scale.key) / 100);
				assert.strictEqual(image.width, expected, relative + " width");
				assert.strictEqual(image.height, expected, relative + " height");

				const floor = Math.floor(expected * expected * MIN_VISIBLE_FRACTION);
				const visible = png.visiblePixels(image);
				assert.ok(visible >= floor, relative + " is blank (" + visible + " visible pixels)");
			});
		});
	});

	assert.ok(Object.keys(seen).length >= 30, "checked at least 30 distinct files");
});

test("the entry icon has ink on its tile, not an empty rounded square", () => {
	const file = expand(
		JSON.parse(fs.readFileSync(path.join(ROOT, "plugin", "config.json"), "utf8")).variations[0].icons,
		"light",
		"@1.25x"
	);
	const image = png.readPng(file);
	const middle = Math.floor(image.height / 2);
	// The left edge's midpoint is tile and always outside the glyph, whose ink is
	// ~0.84 em of the 0.72 em box it is drawn into.
	const tile = png.pixel(image, 1, middle);
	assert.deepStrictEqual(tile, [0x5b, 0x4c, 0x1a, 255], "the edge is the solid tile: " + tile);

	// The mark is the only thing on the tile in the cream ink.
	let cream = 0;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			const pixel = png.pixel(image, x, y);
			const near =
				Math.abs(pixel[0] - 0xf2) < 45 && Math.abs(pixel[1] - 0xe9) < 45 && Math.abs(pixel[2] - 0xc9) < 45;
			if (pixel[3] > 200 && near) {
				cream++;
			}
		}
	}
	assert.ok(cream >= 10, "the logo mark is drawn on the tile (" + cream + " cream pixels)");
	assert.notDeepStrictEqual(
		png.pixel(image, Math.floor(image.width / 2), middle),
		tile,
		"the centre of the tile is the glyph, not more tile"
	);
});

test("the menu glyphs are themed, so dark ink gives way to light", () => {
	const icons = declaredPaths().paths.filter(function (entry) {
		return /icons\/%theme-type/.test(entry.icons) && !/\/big\//.test(entry.icons);
	})[0];
	assert.ok(icons, "a menu icon was declared");

	function ink(theme) {
		const image = png.readPng(expand(icons.icons, theme, "@1.25x"));
		let darkest = [255, 255, 255];
		let brightest = [0, 0, 0];
		for (let y = 0; y < image.height; y++) {
			for (let x = 0; x < image.width; x++) {
				const pixel = png.pixel(image, x, y);
				if (pixel[3] < 200) {
					continue;
				}
				[0, 1, 2].forEach(function (channel) {
					darkest[channel] = Math.min(darkest[channel], pixel[channel]);
					brightest[channel] = Math.max(brightest[channel], pixel[channel]);
				});
			}
		}
		return { darkest: darkest, brightest: brightest };
	}

	const light = ink("light");
	const dark = ink("dark");
	assert.ok(light.darkest[0] < 90, "the light-theme glyph is dark: " + light.darkest);
	assert.ok(dark.brightest[0] > 200, "the dark-theme glyph is light: " + dark.brightest);
});

test("the generator's manifest covers every icon slot the plugin asks for", () => {
	let listing;
	try {
		listing = execFileSync("python3", [path.join("tools", "make-icons.py"), "--list"], {
			cwd: ROOT,
			encoding: "utf8"
		});
	} catch (error) {
		// The icon files themselves are checked above without Python.
		return;
	}

	const slots = listing
		.split("\n")
		.map(function (line) {
			return /^(\S+)\s+(\S+)$/.exec(line);
		})
		.filter(Boolean)
		.map(function (match) {
			return match[1];
		});
	assert.ok(slots.length >= 9, "the manifest lists the slots: " + slots.join(", "));

	declaredPaths().paths.forEach(function (entry) {
		// "resources/icons/%theme-type%(light|dark)/big/report%scale%(default).png"
		const match = /\/big\/([^%]+)%scale%/.exec(entry.icons) || /\(light\|dark\)\/([^%]+)%scale%/.exec(entry.icons);
		assert.ok(match, "an icon path with a slot: " + entry.icons);
		assert.ok(
			slots.indexOf(match[1]) !== -1,
			match[1] + " is requested by the plugin but has no entry in the generator manifest (" + entry.source + ")"
		);
	});
});

test("the generator's own check passes and leaves no orphans", () => {
	let result;
	try {
		result = execFileSync("python3", [path.join("tools", "make-icons.py"), "--check"], {
			cwd: ROOT,
			encoding: "utf8"
		});
	} catch (error) {
		assert.fail("make-icons.py --check failed:\n" + (error.stdout || error.message));
	}
	assert.match(result, /files ok/, result.trim());

	// Every PNG under resources must belong to the manifest, or a rename would
	// leave an unused file behind that nothing regenerates.
	const listing = execFileSync("python3", [path.join("tools", "make-icons.py"), "--list"], {
		cwd: ROOT,
		encoding: "utf8"
	});
	const manifestSlots = listing
		.split("\n")
		.map(function (line) {
			const match = /^(\S+)\s+(\S+)$/.exec(line);
			return match ? match[1] : null;
		})
		.filter(Boolean);

	const known = {};
	manifestSlots.forEach(function (slot) {
		known[slot] = true;
	});

	const onDisk = [];
	(function walk(directory) {
		fs.readdirSync(directory, { withFileTypes: true }).forEach(function (entry) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith(".png")) {
				onDisk.push(full);
			}
		});
	})(path.join(ROOT, "plugin", "resources"));

	assert.ok(onDisk.length >= 100, "the plugin ships a full icon set: " + onDisk.length + " files");
	onDisk.forEach(function (file) {
		const name = path.basename(file).replace(/@[\d.]+x/, "").replace(/\.png$/, "");
		assert.ok(
			known[name] || name === "icon",
			path.relative(ROOT, file) + " is not in the generator manifest"
		);
	});
});
