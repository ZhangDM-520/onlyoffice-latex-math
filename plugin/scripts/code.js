/*
 * ONLYOFFICE LaTeX math plugin - background plugin entry point.
 *
 * Converts `$...$`, `$$...$$`, `\(...\)` and `\[...\]` runs of LaTeX source text
 * into native ONLYOFFICE (OMML) math objects through the Builder API.
 *
 * Architecture:
 *   - scan.js      pure delimiter scanner (also unit tested outside the plugin)
 *   - commands.js  self-contained command functions evaluated inside the editor
 *   - code.js      this file: settings, menus, hotkeys, orchestration, reporting
 */
(function (window) {
	"use strict";

	var core = window.OnlyOfficeLatexMath;
	var commands = window.OnlyOfficeLatexMathCommands;

	if (!core || !commands) {
		// Loading order problem: fail loudly instead of silently doing nothing.
		console.error("[latex-math] scan.js / commands.js missing");
		return;
	}

	var SETTINGS_KEY = "onlyoffice-latex-math.settings";
	// Bumped when a stored default must not survive: 2 silenced the report window.
	var SETTINGS_VERSION = 2;
	// The editor answers callCommand asynchronously; without a backstop a dropped
	// callback would leave the UI waiting forever.
	var COMMAND_TIMEOUT_MS = 30000;
	// Upper bound on how long the plugin waits for the host to confirm that the
	// editor shell is up before publishing the menus anyway.
	var PUBLISH_BACKSTOP_MS = 1500;

	// Everything here is reachable from the ribbon tab; a stored key with no UI
	// would be a setting nothing can change, so `currencyGuard` is a constant in
	// `scannerOptions` instead.
	var DEFAULT_SETTINGS = {
		inlineDollar: true,
		displayDollar: true,
		inlineParen: true,
		displayBracket: true,
		openReport: false
	};

	// One list behind the four delimiter toggles: their labels, their icon slots
	// and the order `updateMenuLabels` refreshes them in.
	var DELIMITER_TOGGLES = [
		{ key: "inlineDollar", label: "$...$", icon: "inline-dollar" },
		{ key: "displayDollar", label: "$$...$$", icon: "display-dollar" },
		{ key: "inlineParen", label: "\\(...\\)", icon: "inline-paren" },
		{ key: "displayBracket", label: "\\[...\\]", icon: "display-bracket" }
	];

	var settings = null;
	var lastReport = null;
	var reportWindow = null;
	var prepared = false;
	var published = false;
	var backstopArmed = false;
	var readySignals = {};
	var menuRoot = null;
	var menuItems = [];
	var reportMenuItem = null;

	function tr(text) {
		try {
			if (window.Asc && window.Asc.plugin && typeof window.Asc.plugin.tr === "function") {
				return window.Asc.plugin.tr(text);
			}
		} catch (e) {
			/* fall through */
		}
		return text;
	}

	/* ------------------------------------------------------------------ *
	 * Settings
	 * ------------------------------------------------------------------ */

	function loadSettings() {
		var loaded = {};
		try {
			loaded = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}") || {};
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

	function saveSettings() {
		try {
			var record = { version: SETTINGS_VERSION };
			Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
				record[key] = settings[key];
			});
			window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(record));
		} catch (e) {
			console.error("[latex-math] cannot persist settings", e);
		}
	}

	function scannerOptions() {
		return {
			delimiters: {
				inlineDollar: settings.inlineDollar,
				displayDollar: settings.displayDollar,
				inlineParen: settings.inlineParen,
				displayBracket: settings.displayBracket
			},
			// Not a toggle, and not a stored key: see DEFAULT_SETTINGS above.
			currencyGuard: true
		};
	}

	function enabledDelimiterCount() {
		return ["inlineDollar", "displayDollar", "inlineParen", "displayBracket"].filter(function (key) {
			return settings[key];
		}).length;
	}

	/* ------------------------------------------------------------------ *
	 * Editor bridge
	 * ------------------------------------------------------------------ */

	function parseCommandResult(result) {
		if (typeof result === "string" && result !== "") {
			try {
				return JSON.parse(result);
			} catch (e) {
				return { error: "unparsable-command-result", raw: result };
			}
		}
		if (result && typeof result === "object") {
			return result;
		}
		return null;
	}

	/**
	 * Run one of the self-contained command functions inside the editor page.
	 * Resolves with the parsed JSON result, or `null` when the host never
	 * delivered a callback.
	 */
	function callEditorCommand(commandFn, scope) {
		return new Promise(function (resolve) {
			var plugin = window.Asc && window.Asc.plugin;
			if (!plugin || typeof plugin.callCommand !== "function") {
				resolve({ error: "callCommand-unavailable" });
				return;
			}

			var settled = false;
			var timer = null;
			function settle(value) {
				if (settled) {
					return;
				}
				settled = true;
				if (timer !== null) {
					window.clearTimeout(timer);
					timer = null;
				}
				resolve(parseCommandResult(value));
			}

			try {
				// The generated command wrapper reads the payload from Asc.scope.
				window.Asc.scope = scope || {};
				// Arm the backstop before dispatching: a host that answers
				// synchronously would otherwise leave the timer orphaned.
				timer = window.setTimeout(function () {
					settle(null);
				}, COMMAND_TIMEOUT_MS);
				plugin.callCommand(commandFn, false, true, settle);
			} catch (e) {
				settle({ error: "callCommand-threw: " + (e && e.message) });
			}
		});
	}

	function readDocument() {
		return callEditorCommand(commands.readCommand, {});
	}

	/* ------------------------------------------------------------------ *
	 * Reporting
	 * ------------------------------------------------------------------ */

	function makeReport(title) {
		return {
			title: title,
			when: new Date().toISOString().replace("T", " ").substring(0, 19),
			lines: [],
			converted: 0
		};
	}

	function reportLine(report, text) {
		report.lines.push(text);
	}

	function summarizeSkipped(skipped) {
		var groups = {};
		skipped.forEach(function (item) {
			var reason = item.reason || "unknown";
			groups[reason] = (groups[reason] || 0) + 1;
		});
		return groups;
	}

	// `force` is for the explicit *Show last report* request: silencing the report
	// window must not make the report unreachable, only stop it appearing on its
	// own after every conversion.
	function showReport(report, force) {
		lastReport = report;
		updateMenuLabels();

		if (!settings.openReport && force !== true) {
			return;
		}

		try {
			var location = window.location;
			var start = location.pathname.lastIndexOf("/") + 1;
			var file = location.pathname.substring(start);
			var base = location.href.replace(file, "report.html");
			var payload = encodeURIComponent(JSON.stringify(report));
			// `buttons` is what the host renders as the dialog footer, and the
			// dialog also sets `enableKeyEvents: false`, so this Close button is the
			// only affordance the host itself offers. Its click arrives in
			// `Asc.plugin.button` below. The header X arrives there too.
			var variation = {
				url: base + "?report=" + payload,
				description: tr("LaTeX math conversion report"),
				isVisual: true,
				isModal: false,
				EditorsSupport: ["word"],
				size: [520, 380],
				buttons: [{ text: tr("Close"), primary: true, isViewer: true }]
			};

			// A second report must not reuse the first window: the host ignores a
			// repeat `frameId` (`onApiPluginWindowShow` returns early), which left
			// the previous numbers on screen. Close, then open a fresh one.
			closeReportWindow();
			reportWindow = new window.Asc.PluginWindow();
			reportWindow.show(variation);
		} catch (e) {
			console.error("[latex-math] cannot open report window", e);
		}
	}

	function closeReportWindow() {
		if (!reportWindow) {
			return;
		}
		try {
			reportWindow.close();
		} catch (e) {
			console.error("[latex-math] cannot close report window", e);
		}
		reportWindow = null;
	}

	/**
	 * Open the last report, whatever the *Report window* toggle says.
	 *
	 * Reports are silent by default, so this is the only way back to one. The
	 * window itself is the plugin's, so nothing here touches the document.
	 */
	function showLastReport() {
		if (!lastReport) {
			var empty = makeReport(tr("Show last report"));
			reportLine(empty, tr("No conversion has been run yet."));
			showReport(empty, true);
			return;
		}
		showReport(lastReport, true);
	}

	/* ------------------------------------------------------------------ *
	 * Conversion
	 * ------------------------------------------------------------------ */

	/**
	 * The plugin's **only** conversion.
	 *
	 * The selection is the unit of work by design: the owner chooses what to
	 * convert and the plugin never decides for them. "The whole document" is
	 * `Ctrl+A` followed by this same action, which keeps one code path (and one
	 * undo step) behind every conversion instead of two with different scopes.
	 *
	 * Resolves with the report it produced, on every path - a refused conversion
	 * is a report too, and callers (and the dev console) should not have to ask
	 * the module whether it kept one.
	 */
	function convertSelection() {
		var report = makeReport(tr("Convert selection"));

		if (enabledDelimiterCount() === 0) {
			reportLine(report, tr("No delimiters are enabled. Turn one on in the plugin menu."));
			showReport(report);
			return Promise.resolve(report);
		}

		return readDocument()
			.then(function (snapshot) {
				if (!snapshot || snapshot.error) {
					reportLine(
						report,
						tr("Cannot read the document") + ": " + ((snapshot && snapshot.error) || "no response from editor")
					);
					showReport(report);
					return report;
				}

				// The editor always reports a selection: an empty one where the
				// caret happens to sit when nothing is highlighted. Only a real
				// (non-collapsed) selection may scope the conversion - a collapsed
				// caret is a no-op, never a whole-document surprise.
				var selection = snapshot.selection;
				if (!selection || selection.start === selection.end) {
					reportLine(report, tr("Select the text to convert first."));
					showReport(report);
					return report;
				}

				var collected = core.collectParagraphs(snapshot);
				var plan = core.planReplacements(collected.paragraphs, scannerOptions(), selection);

				reportLine(
					report,
					tr("Scanned") +
						": " +
						collected.paragraphs.length +
						" " +
						tr("paragraphs") +
						", " +
						plan.operations.length +
						" " +
						tr("LaTeX spans found") +
						" (" +
						plan.operations.filter(function (op) {
							return op.display;
						}).length +
						" " +
						tr("display") +
						")"
				);

				if (collected.unusable > 0) {
					reportLine(
						report,
						tr("Paragraphs that could not be read") + ": " + collected.unusable
					);
				}
				if (plan.skipped.length > 0) {
					reportLine(report, tr("Outside the selection") + ": " + plan.skipped.length);
				}
				if (plan.warnings.length > 0) {
					var byCode = {};
					plan.warnings.forEach(function (warning) {
						byCode[warning.code] = (byCode[warning.code] || 0) + 1;
					});
					reportLine(report, tr("Malformed delimiters") + ": " + JSON.stringify(byCode));
				}

				if (!plan.operations.length) {
					reportLine(report, tr("Nothing to convert."));
					showReport(report);
					return report;
				}

				return callEditorCommand(commands.applyCommand, {
					operations: plan.operations,
					createHistoryPoint: true
				}).then(function (result) {
					if (!result || result.error) {
						reportLine(
							report,
							tr("Conversion failed") + ": " + ((result && result.error) || "no response from editor")
						);
						showReport(report);
						return report;
					}

					var applied = result.applied || [];
					report.converted = applied.length;
					reportLine(report, tr("Converted") + ": " + applied.length + " / " + plan.operations.length);
					reportLine(report, tr("Undo point created") + ": " + (result.historyPoint ? tr("yes") : tr("no")));

					var displayCount = applied.filter(function (op) {
						return op.display;
					}).length;
					if (displayCount > 0) {
						reportLine(
							report,
							tr("Display math requested") +
								": " +
								displayCount +
								", " +
								tr("display mode applied via") +
								": " +
								(result.displayMode || tr("unavailable"))
						);
					}

					var skippedGroups = summarizeSkipped(result.skipped || []);
					Object.keys(skippedGroups).forEach(function (reason) {
						reportLine(report, tr("Skipped") + " (" + reason + "): " + skippedGroups[reason]);
					});
					(result.skipped || []).slice(0, 5).forEach(function (item) {
						reportLine(
							report,
							"  - " +
								item.reason +
								" @" +
								item.start +
								(item.expected ? " expected=" + JSON.stringify(item.expected) : "")
						);
					});

					return verify(report, selection).then(function () {
						showReport(report);
						return report;
					});
				});
			});
	}

	/** Re-read the document to prove the delimiters are gone. */
	function verify(report, filter) {
		return readDocument().then(function (snapshot) {
			if (!snapshot || snapshot.error) {
				reportLine(report, tr("Verification unavailable") + ": " + ((snapshot && snapshot.error) || "no response"));
				return;
			}
			var collected = core.collectParagraphs(snapshot);
			var plan = core.planReplacements(collected.paragraphs, scannerOptions(), filter);
			reportLine(report, tr("Delimiters still present") + ": " + plan.operations.length);
			if (plan.operations.length === 0 && report.converted > 0) {
				reportLine(report, tr("All converted spans became native math objects."));
			}
		});
	}

	/* ------------------------------------------------------------------ *
	 * Menus, hotkeys, lifecycle
	 * ------------------------------------------------------------------ */

	// Every icon in the repo is generated by `tools/make-icons.py` from the Tabler
	// font noctalia ships. `%scale%(default)` expands to five scales
	// (100/125/150/175/200 %) and the host picks the one nearest the display
	// scale with no fallback to the 100 % file, which is why the generator writes
	// all five and why a missing variant shows *nothing* rather than a fallback.
	function themedIcon(name, big) {
		return (
			"resources/icons/%theme-type%(light|dark)/" +
			(big ? "big/" : "") +
			name +
			"%scale%(default).png"
		);
	}

	function buildToolbar() {
		menuRoot = new window.Asc.ButtonToolbar();
		menuRoot.text = tr("LaTeX math");
		menuRoot.icons = themedIcon("latex", true);
		menuItems = [];

		// `iconName` is a slot from the generator's manifest; without one the host
		// renders the item with no icon at all, which is what every ribbon button
		// did before.
		function addItem(text, handler, iconName, separator) {
			var item = new window.Asc.ButtonToolbar(menuRoot);
			item.text = text;
			if (iconName) {
				item.icons = themedIcon(iconName, true);
			}
			if (separator) {
				item.separator = true;
			}
			item.attachOnClick(handler);
			menuItems.push(item);
			return item;
		}

		// The ribbon tab is a **settings surface, not a menu of actions**. There is
		// no conversion item by design: conversion acts on the selection and the
		// owner decides what that is, so it is triggered where the selection is
		// made - the document right-click row, or the Alt+L chord.
		reportMenuItem = addItem(tr("Show last report"), showLastReport, "report");
		reportMenuItem.updateLabel = function () {
			reportMenuItem.text = tr("Show last report");
		};

		// The toggles live under a separator, away from the report entry. Each item
		// carries its own label refresh, so nothing has to know their positions in
		// the list.
		DELIMITER_TOGGLES.forEach(function (toggle, index) {
			var item = addItem(
				delimiterLabel(toggle),
				function () {
					settings[toggle.key] = !settings[toggle.key];
					saveSettings();
					updateMenuLabels();
				},
				toggle.icon,
				index === 0
			);
			item.updateLabel = function () {
				item.text = delimiterLabel(toggle);
			};
		});

		// Reports are silent by default (SETTINGS_VERSION 2); this is how they come
		// back, and the glyph says which state the item will switch to.
		var reportToggle = addItem(reportToggleLabel(), function () {
			settings.openReport = !settings.openReport;
			saveSettings();
			updateMenuLabels();
		});
		reportToggle.updateLabel = function () {
			reportToggle.text = reportToggleLabel();
			reportToggle.icons = themedIcon(settings.openReport ? "report-on" : "report-off", true);
		};
		reportToggle.updateLabel();

		window.OnlyOfficeLatexMathMenu = menuRoot;
	}

	function delimiterLabel(toggle) {
		return (settings[toggle.key] ? "\u2713 " : "\u2717 ") + toggle.label;
	}

	function reportToggleLabel() {
		return (settings.openReport ? "\u2713 " : "\u2717 ") + tr("Report window");
	}

	function updateMenuLabels() {
		if (!menuRoot) {
			return;
		}
		menuItems.forEach(function (item) {
			if (typeof item.updateLabel === "function") {
				item.updateLabel();
			}
		});
		if (reportMenuItem && lastReport) {
			reportMenuItem.text = tr("Show last report") + " (" + reportItem_converted() + ")";
		}
		try {
			// `updateToolbarMenu` takes (id, caption, items) and writes the
			// caption into the tab; a ButtonToolbar has no `name`, so passing it
			// blanked the ribbon tab. Only ever called after publication - the
			// host ignores an update for a tab that does not exist yet.
			if (published && window.Asc.Buttons && typeof window.Asc.Buttons.updateToolbarMenu === "function") {
				window.Asc.Buttons.updateToolbarMenu(menuRoot.id, menuRoot.text, menuItems);
			}
		} catch (e) {
			console.error("[latex-math] updateToolbarMenu failed", e);
		}
	}

	function reportItem_converted() {
		return lastReport ? lastReport.converted + " \u2192 " + tr("math") : tr("none");
	}

	function buildContextMenu() {
		// Mandatory in this build, and on *every* item. `onContextMenuShow`
		// (v1/plugins.js) copies an item into the host menu only when the live
		// context info matches one of `showOnOptionsType`, or when one checker is
		// the literal "All"; otherwise the item is silently skipped. That gate is
		// what made the whole submenu invisible with the default empty list - and
		// it is applied to `childs` too, through the very same function, so a root
		// that passed the check produced an EMPTY submenu and clicking it did
		// nothing at all (both measured live against 9.4.0.130-1). Known context
		// types: None/Target/Selection/OleObject/Image/Shape
		// (c_oPluginContextMenuTypes in sdkjs/word/sdk-all.js).
		function menuItem(parent, text, iconName, action) {
			var item = new window.Asc.ButtonContextMenu(parent);
			item.text = tr(text);
			if (iconName) {
				item.icons = themedIcon(iconName, false);
			}
			item.addCheckers("All");
			// A clickable row in the host menu: without a handler a click on
			// "LaTeX math" itself did nothing.
			item.attachOnClick(action);
			return item;
		}

		// One row, and it converts - immediately. The submenu it used to carry only
		// existed to offer scopes the plugin no longer has, and a row that opens a
		// menu makes the owner answer a second question before the obvious one (what
		// is selected) has any effect.
		var root = menuItem(null, "LaTeX math", "latex", convertSelection);

		window.OnlyOfficeLatexMathContextMenu = root;
	}

	/* ------------------------------------------------------------------ *
	 * Hotkeys
	 *
	 * There is no plugin shortcut API in this build and the host's own key
	 * event never reaches a plugin at document level (see `register`), so the
	 * plugin listens to the editor's document itself. The plugin frame is a
	 * child of the editor's main frame and both are `file://` origin, so
	 * `window.parent.document` is reachable - measured live, plan section 2.2.
	 * ------------------------------------------------------------------ */

	// A chord does NOT arrive with its modifiers (measured).
	//
	// Measured with injected keystrokes against 9.4.0.130-1 on Linux/X11 (plan
	// section 2.3, the only input path available when driving the app from a
	// terminal): holding Alt and pressing L delivers *two* events - `Alt` (key
	// "Alt", altKey true) and then `l` with keyCode 76, code "KeyL" and EVERY
	// modifier flag false - and the editor inserts that `l` into the document as
	// text. `Ctrl+Alt+M` behaves identically (both flags false, an `m` inserted).
	// Whether a *physical* chord keeps its flags is untested; Chromium's
	// access-key pass is the likely cause of the loss, and the matcher accepts
	// both shapes so it does not matter.
	//
	// Consequences, and why this matcher is shaped the way it is:
	//   - a chord is recognised from the MODIFIER key presses that precede the
	//     bound key as well as from the bound key's own flags;
	//   - the modifier set must match the binding EXACTLY, which is what keeps a
	//     plain `l` and an ordinary `Ctrl+L` out of the branch;
	//   - a claimed key must be swallowed, or it lands in the document.
	//
	// Do not "simplify" this back to a `keyCode === 76` or `event.altKey` test.
	var HOTKEYS = [
		{ code: "KeyL", key: "l", mods: ["Alt"] }
	];
	// A modifier keyup the plugin never saw must not leave a chord armed forever.
	// A real chord is pressed within this window of its modifier.
	var CHORD_MODIFIER_WINDOW_MS = 1500;
	var MODIFIER_KEYS = { Control: "Control", Alt: "Alt", Shift: "Shift", Meta: "Meta" };
	var MODIFIER_CODES = {
		ControlLeft: "Control",
		ControlRight: "Control",
		AltLeft: "Alt",
		AltRight: "Alt",
		ShiftLeft: "Shift",
		ShiftRight: "Shift",
		MetaLeft: "Meta",
		MetaRight: "Meta"
	};

	function modifierName(event) {
		if (event.key && MODIFIER_KEYS[event.key]) {
			return MODIFIER_KEYS[event.key];
		}
		if (event.code && MODIFIER_CODES[event.code]) {
			return MODIFIER_CODES[event.code];
		}
		return null;
	}

	function sameModifierSet(a, b) {
		if (!a || !b || a.length !== b.length) {
			return false;
		}
		return a.every(function (name) {
			return b.indexOf(name) >= 0;
		});
	}

	function altGraphHeld(event) {
		try {
			return typeof event.getModifierState === "function" && !!event.getModifierState("AltGraph");
		} catch (e) {
			return false;
		}
	}

	/**
	 * Turns the raw key stream into the binding it completes, or `null` when the
	 * key is not ours.
	 *
	 * Everything it knows comes from the events handed to it plus the `now` the
	 * caller passes, so the whole rule set - including the timing - is testable
	 * without a browser.
	 */
	function createHotkeyMatcher(bindings) {
		var pressed = {};
		var lastModifierAt = null;

		function armedSet(now) {
			if (lastModifierAt === null || now - lastModifierAt > CHORD_MODIFIER_WINDOW_MS) {
				// Nothing armed: a missed modifier keyup must not poison a later
				// keystroke.
				return null;
			}
			return Object.keys(pressed);
		}

		// When the host does report modifiers (a browser build, or one that does
		// not consume them) the reported flags win; otherwise the modifier keys
		// that were seen do.
		function reportedSet(event) {
			var set = [];
			if (event.ctrlKey) {
				set.push("Control");
			}
			if (event.altKey) {
				set.push("Alt");
			}
			if (event.shiftKey) {
				set.push("Shift");
			}
			if (event.metaKey) {
				set.push("Meta");
			}
			return set.length ? set : null;
		}

		function match(event, mods) {
			var code = event.code || "";
			var key = typeof event.key === "string" ? event.key.toLowerCase() : "";
			for (var i = 0; i < bindings.length; i++) {
				var binding = bindings[i];
				if (code !== binding.code && key !== binding.key) {
					continue;
				}
				if (sameModifierSet(mods, binding.mods)) {
					return binding;
				}
			}
			return null;
		}

		return {
			keydown: function (event, now) {
				if (!event) {
					return null;
				}
				var name = modifierName(event);
				if (name) {
					// Recorded, never claimed: Alt on its own keeps its normal
					// behaviour (it is also how a chord is announced).
					pressed[name] = true;
					lastModifierAt = now;
					return null;
				}
				var mods = reportedSet(event);
				if (!mods) {
					mods = armedSet(now) || [];
				}
				var matched = null;
				if (!event.repeat && !altGraphHeld(event)) {
					// Auto-repeat must not convert over and over; `AltGr` shows up
					// as Control+Alt on layouts that type with it.
					matched = match(event, mods);
				}
				// Any other key consumes the chord state: a chord belongs to the
				// key that completed it.
				pressed = {};
				lastModifierAt = null;
				return matched;
			},
			keyup: function (event) {
				var name = event ? modifierName(event) : null;
				if (!name) {
					return;
				}
				delete pressed[name];
				if (Object.keys(pressed).length === 0) {
					lastModifierAt = null;
				}
			},
			// Inspection helpers: `reset` lets a test (or the dev console) start
			// from a clean state, `armed` reports the modifiers currently held.
			reset: function () {
				pressed = {};
				lastModifierAt = null;
			},
			armed: function (now) {
				return armedSet(now) || [];
			}
		};
	}

	var hotkeyStatus = {
		attached: 0,
		blocked: 0,
		chords: HOTKEYS.map(function (binding) {
			return binding.mods.join("+") + "+" + binding.key.toUpperCase();
		})
	};
	var hotkeyMarker = "onlyOfficeLatexMathHotkey" + (window.Asc.plugin.guid || "");

	function nowMs() {
		if (window.Date && typeof window.Date.now === "function") {
			return window.Date.now();
		}
		return new Date().getTime();
	}

	function attachToDocument(doc, matcher) {
		if (doc[hotkeyMarker]) {
			return; // idempotent: a re-init must not double-fire
		}
		function onKeyDown(event) {
			var binding = null;
			try {
				binding = matcher.keydown(event, nowMs());
			} catch (e) {
				console.error("[latex-math] hotkey matcher failed", e);
				return;
			}
			if (!binding) {
				return;
			}
			// Claim the key before the editor turns it into text (measured: an
			// unclaimed `l` lands in the document). `stopPropagation` keeps the
			// event from ever reaching the SDK's own keyboard sink.
			if (typeof event.stopPropagation === "function") {
				event.stopPropagation();
			}
			if (typeof event.preventDefault === "function") {
				event.preventDefault();
			}
			convertSelection();
		}
		function onKeyUp(event) {
			matcher.keyup(event);
		}
		doc.addEventListener("keydown", onKeyDown, true);
		doc.addEventListener("keyup", onKeyUp, true);
		try {
			doc[hotkeyMarker] = true;
		} catch (e) {
			/* a document that refuses the marker is still attached */
		}
		hotkeyStatus.attached++;
	}

	/**
	 * Install the listener in the editor's document.
	 *
	 * Walked upwards from `window.parent` because the plugin frame's parent is the
	 * editor's main frame (the frame that owns the hidden `TEXTAREA` the SDK reads
	 * keys from). Every step is guarded: a host that puts plugins on an opaque
	 * origin (the shipped AI plugin is loaded from `onlyoffice://plugin`) can only
	 * make the attach fail, never break the rest of the plugin.
	 */
	function attachHotkeys() {
		var matcher = createHotkeyMatcher(HOTKEYS);
		var frame = null;
		try {
			frame = window.parent;
		} catch (e) {
			frame = null;
		}
		for (var depth = 0; frame && frame !== window && depth < 10; depth++) {
			var next = null;
			try {
				next = frame.parent;
			} catch (e) {
				next = null;
			}
			try {
				var doc = frame.document;
				if (doc && typeof doc.addEventListener === "function") {
					attachToDocument(doc, matcher);
				} else {
					hotkeyStatus.blocked++;
				}
			} catch (e) {
				hotkeyStatus.blocked++;
			}
			// A top-level frame's `parent` is itself, which is what ends the walk
			// (the depth bound is only a backstop).
			frame = next === frame ? null : next;
		}

		if (hotkeyStatus.attached === 0) {
			console.error("[latex-math] no document reached; the hotkeys are unavailable");
		} else {
			console.log(
				"[latex-math] " + hotkeyStatus.chords.join(", ") + " attached to " + hotkeyStatus.attached + " document(s)"
			);
		}
		// A partial attach is not a failure, but it is not a success either: name
		// the frames that refused, or the count above hides them.
		if (hotkeyStatus.blocked > 0) {
			console.error(
				"[latex-math] " + hotkeyStatus.blocked + " frame(s) refused the hotkey listener (opaque origin?)"
			);
		}
	}

	function register() {
		if (prepared) {
			return;
		}
		prepared = true;

		// The host's plugin key event is NOT a shortcut channel in this build.
		//
		// Measured (onlyoffice-git 9.4.0.130-1): the word editor only calls
		// `g_asc_plugins.onPluginEvent2("onKeyDown", ...)` from inside the
		// `isInputHelpersPresent` branch of its key handler, i.e. while a form
		// control / content control input helper owns the keyboard, and only for
		// navigation keys (Tab, Enter, arrows, Home/End, PageUp/Down, Escape).
		// The shipped API has no `shortcut` field either. An `onKeyDown` handler
		// here could therefore never fire for a real chord - the `Ctrl+Alt+M`
		// handler this plugin used to register was dead code, and was removed
		// rather than kept as advertisement. `attachHotkeys` is the channel that
		// actually works.
		attachHotkeys();

		// Armed here rather than in `init`: a host that never calls `init` (the
		// `onThemeChanged`-only path below) otherwise had no backstop at all and
		// never published its menus.
		armPublishBackstop();
	}

	/**
	 * Hand the menus to the host - once, and only once the editor shell is up.
	 *
	 * Measured (onlyoffice-git 9.4.0.130-1, checked against the editor's DOM):
	 * an `AddToolbarMenuItem` sent from `Asc.plugin.init` is dropped - no
	 * `.ribtab` is created - while the identical payload re-sent a moment later
	 * does create the ribbon tab. The shipped AI plugin, the only background
	 * plugin with a ribbon menu, waits for `onTranslate` on top of `init` for the
	 * same reason. `onTranslate` is also the earliest point at which
	 * `Asc.plugin.tr()` returns real translations, so the labels are built here
	 * rather than at load time.
	 */
	function publishMenus() {
		if (published) {
			return;
		}
		published = true;

		buildToolbar();
		buildContextMenu();

		try {
			window.Asc.Buttons.registerToolbarMenu();
			window.Asc.Buttons.registerContextMenu();
		} catch (e) {
			console.error("[latex-math] menu registration failed", e);
		}

		console.log("[latex-math] menus published");
	}

	function markEditorReady(signal) {
		if (readySignals[signal]) {
			return;
		}
		readySignals[signal] = true;

		var hostIsTalking = !!(readySignals.init || readySignals.theme);
		var editorAnswers = !!(readySignals.translate || readySignals.roundtrip || readySignals.interaction);
		if (readySignals.timeout || (hostIsTalking && editorAnswers)) {
			publishMenus();
		}
	}

	function armPublishBackstop() {
		if (backstopArmed || typeof window.setTimeout !== "function") {
			return;
		}
		backstopArmed = true;
		window.setTimeout(function () {
			markEditorReady("timeout");
		}, PUBLISH_BACKSTOP_MS);
	}

	// A trivial command that only the live editor can answer; its answer proves
	// the document is loaded, hence that the toolbar that hosts the menu exists.
	function probeEditor() {
		callEditorCommand(function () {
			return JSON.stringify({ latexMathProbe: true });
		}, {}).then(function (result) {
			if (result && result.latexMathProbe === true) {
				markEditorReady("roundtrip");
			}
		});
	}

	window.Asc.plugin.init = function () {
		settings = loadSettings();
		register();
		markEditorReady("init");
		probeEditor();
	};

	// The host calls onTranslate once the editor is up (every shipped plugin
	// uses it), which makes it the publish trigger.
	window.Asc.plugin.onTranslate = function () {
		markEditorReady("translate");
	};

	// Some hosts call onExternalPluginMessage/onThemeChanged only; make sure the
	// plugin still initialises when init is skipped. The signal is a *host* signal
	// (`markEditorReady`'s two halves are `init|theme` and
	// `translate|roundtrip|interaction`), so a theme-only host still waits for the
	// backstop - which is what the backstop is for.
	window.Asc.plugin.onThemeChanged = function (theme) {
		if (!prepared) {
			settings = loadSettings();
			register();
			markEditorReady("theme");
		}
		if (typeof window.Asc.plugin.onThemeChangedBase === "function") {
			window.Asc.plugin.onThemeChangedBase(theme);
		}
	};

	// A user interacting with the document is the last-resort proof that the
	// editor shell is alive.
	window.Asc.plugin.onExternalMouseUp = function () {
		markEditorReady("interaction");
	};

	// **Mandatory once the plugin opens a window.** The host's injected router
	// (sdkjs/word/sdk-all.js, the `plugin_onMessage` blob) dispatches every dialog
	// button like this:
	//
	//     case "button":
	//       Asc.plugin.button || (-1 !== k) || n !== g.buttonWindowId
	//           ? Asc.plugin.button(k, g.buttonWindowId)   // throws when undefined
	//           : Asc.plugin.executeCommand("close", "");
	//
	// The message is posted to *this* frame, whose id is never the window id, so
	// the first branch is always taken. Without this hook the header X (and the
	// footer Close button) threw a TypeError inside the message handler and the
	// report window could not be closed at all - measured live against
	// 9.4.0.130-1. The shipped AI plugin defines it for the same reason.
	window.Asc.plugin.button = function (id, windowId) {
		if (!windowId) {
			return;
		}
		if (!reportWindow || String(reportWindow.id) !== String(windowId)) {
			return;
		}
		// Every id closes the report: 0 is the footer Close button, -1 is the
		// dialog's header X. The page can also close itself (see report.js).
		closeReportWindow();
	};

	// Exposed for manual testing from the plugin dev console.
	window.OnlyOfficeLatexMathApi = {
		convertSelection: convertSelection,
		readDocument: readDocument,
		showLastReport: showLastReport,
		closeReportWindow: closeReportWindow,
		// Re-running the attach is harmless (the document marker makes it
		// idempotent) and is how the hotkeys can be inspected from the console.
		attachHotkeys: attachHotkeys,
		createHotkeyMatcher: createHotkeyMatcher,
		getHotkeys: function () {
			return HOTKEYS;
		},
		getHotkeyStatus: function () {
			return { attached: hotkeyStatus.attached, blocked: hotkeyStatus.blocked, chords: hotkeyStatus.chords.slice() };
		},
		getSettings: function () {
			return settings;
		},
		getLastReport: function () {
			return lastReport;
		}
	};
})(window);
