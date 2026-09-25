/*
 * Settings: the stored record, its defaults, and what the scanner reads from it.
 *
 * Interface (all pure - the storage is a *parameter*, so this file never reaches
 * for the window and stays testable outside the plugin):
 *   loadSettings(storage)           -> the merged settings object
 *   saveSettings(settings, storage) -> persist the record (stamped with VERSION)
 *   scannerOptions(settings)        -> the options scan.js takes
 *   enabledDelimiterCount(settings) -> how many delimiters are on
 *
 * The stale-record rule lives in `loadSettings`, and it is behaviour, not
 * config plumbing: a record written before the report window was silenced
 * (SETTINGS_VERSION 2) carries no version, and its `openReport: true` would
 * keep the old behaviour forever - so a stale record may not decide
 * `openReport`. The delimiter choices are still the owner's and are kept.
 *
 * Everything in DEFAULT_SETTINGS is reachable from the ribbon tab; a stored key
 * with no UI would be a setting nothing can change, so `currencyGuard` is a
 * constant inside `scannerOptions` instead. The toggle *labels and icons* stay
 * in code.js's DELIMITER_TOGGLES (menu presentation); the key names below are
 * the vocabulary both sides share.
 *
 * Loadable both as a CommonJS module (node --test) and as a plain script that
 * exposes `window.OnlyOfficeLatexMathSettings` inside the plugin iframe.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.OnlyOfficeLatexMathSettings = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	var SETTINGS_KEY = "onlyoffice-latex-math.settings";
	// Bumped when a stored default must not survive: 2 silenced the report window.
	var SETTINGS_VERSION = 2;

	var DEFAULT_SETTINGS = {
		inlineDollar: true,
		displayDollar: true,
		inlineParen: true,
		displayBracket: true,
		openReport: false
	};

	var DELIMITER_KEYS = ["inlineDollar", "displayDollar", "inlineParen", "displayBracket"];

	function loadSettings(storage) {
		var loaded = {};
		try {
			loaded = JSON.parse(storage.getItem(SETTINGS_KEY) || "{}") || {};
		} catch (e) {
			loaded = {};
		}
		// Records written before the report window was silenced carry no version.
		// Their `openReport: true` would keep the old behaviour forever, so a
		// stale record may not decide `openReport` - the delimiter choices are
		// still the owner's and are kept.
		var stale = loaded.version !== SETTINGS_VERSION;
		var merged = {};
		Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
			if (stale && key === "openReport") {
				merged[key] = DEFAULT_SETTINGS[key];
				return;
			}
			merged[key] = typeof loaded[key] === "boolean" ? loaded[key] : DEFAULT_SETTINGS[key];
		});
		return merged;
	}

	function saveSettings(settings, storage) {
		try {
			var record = { version: SETTINGS_VERSION };
			Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
				record[key] = settings[key];
			});
			storage.setItem(SETTINGS_KEY, JSON.stringify(record));
		} catch (e) {
			console.error("[latex-math] cannot persist settings", e);
		}
	}

	function scannerOptions(settings) {
		return {
			delimiters: {
				inlineDollar: settings.inlineDollar,
				displayDollar: settings.displayDollar,
				inlineParen: settings.inlineParen,
				displayBracket: settings.displayBracket
			},
			// Not a toggle, and not a stored key: see the header.
			currencyGuard: true
		};
	}

	function enabledDelimiterCount(settings) {
		return DELIMITER_KEYS.filter(function (key) {
			return settings[key];
		}).length;
	}

	return {
		SETTINGS_KEY: SETTINGS_KEY,
		SETTINGS_VERSION: SETTINGS_VERSION,
		DEFAULT_SETTINGS: DEFAULT_SETTINGS,
		DELIMITER_KEYS: DELIMITER_KEYS,
		loadSettings: loadSettings,
		saveSettings: saveSettings,
		scannerOptions: scannerOptions,
		enabledDelimiterCount: enabledDelimiterCount
	};
});
