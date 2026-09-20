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
	var HOTKEY_KEY_CODE = 77; // "M"
	// Upper bound on how long the plugin waits for the host to confirm that the
	// editor shell is up before publishing the menus anyway.
	var PUBLISH_BACKSTOP_MS = 1500;

	var DEFAULT_SETTINGS = {
		inlineDollar: true,
		displayDollar: true,
		inlineParen: true,
		displayBracket: true,
		currencyGuard: true,
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

	function scannerOptions(forceDisplay) {
		return {
			delimiters: {
				inlineDollar: settings.inlineDollar,
				displayDollar: settings.displayDollar,
				inlineParen: settings.inlineParen,
				displayBracket: settings.displayBracket
			},
			currencyGuard: settings.currencyGuard,
			forceDisplay: !!forceDisplay
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

	// The single entry point behind the ribbon item and the context-menu item.
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

	function collectParagraphs(snapshot) {
		return core.collectParagraphs(snapshot);
	}

	function convert(mode) {
		var title =
			mode === "document"
				? tr("Convert document")
				: mode === "selection-display"
				? tr("Convert selection as display math")
				: tr("Convert selection");

		var report = makeReport(title);

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
					return null;
				}

				var collected = collectParagraphs(snapshot);
				var filter = null;
				if (mode !== "document") {
					// The editor always reports a selection: an empty one where the
					// caret happens to sit when nothing is highlighted. Only a real
					// (non-collapsed) selection may scope the conversion.
					if (!snapshot.selection || snapshot.selection.start === snapshot.selection.end) {
						reportLine(report, tr("Select the text to convert first."));
						showReport(report);
						return null;
					}
					filter = snapshot.selection;
				}

				var plan = core.planReplacements(
					collected.paragraphs,
					scannerOptions(mode === "selection-display"),
					filter
				);

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
					return null;
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
						return null;
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

					return verify(report, collected.paragraphs, mode, filter).then(function () {
						showReport(report);
						return report;
					});
				});
			});
	}

	/** Re-read the document to prove the delimiters are gone. */
	function verify(report, paragraphs, mode, filter) {
		return readDocument().then(function (snapshot) {
			if (!snapshot || snapshot.error) {
				reportLine(report, tr("Verification unavailable") + ": " + ((snapshot && snapshot.error) || "no response"));
				return;
			}
			var collected = collectParagraphs(snapshot);
			var plan = core.planReplacements(collected.paragraphs, scannerOptions(mode === "selection-display"), filter);
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
		function addItem(text, handler, iconName) {
			var item = new window.Asc.ButtonToolbar(menuRoot);
			item.text = text;
			if (iconName) {
				item.icons = themedIcon(iconName, true);
			}
			item.attachOnClick(handler);
			menuItems.push(item);
			return item;
		}

		addItem(
			tr("Convert document"),
			function () {
				convert("document");
			},
			"document"
		);

		addItem(
			tr("Convert selection"),
			function () {
				convert("selection");
			},
			"selection"
		);

		addItem(
			tr("Convert selection as display math"),
			function () {
				convert("selection-display");
			},
			"display"
		);

		reportMenuItem = addItem(tr("Show last report"), showLastReport, "report");
		reportMenuItem.updateLabel = function () {
			reportMenuItem.text = tr("Show last report");
		};

		// Delimiter toggles live at the bottom of the menu. Each item carries its
		// own label refresh, so nothing has to know their positions in the list.
		DELIMITER_TOGGLES.forEach(function (toggle) {
			var item = addItem(delimiterLabel(toggle), function () {
				settings[toggle.key] = !settings[toggle.key];
				saveSettings();
				updateMenuLabels();
			}, toggle.icon);
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
			// "LaTeX math" itself did nothing. The root doubles as the default
			// action, the children stay available for the scoped variants.
			item.attachOnClick(action);
			return item;
		}

		var root = menuItem(null, "LaTeX math", "latex", function () {
			convert("document");
		});
		menuItem(root, "Convert selection", "selection", function () {
			convert("selection");
		});
		menuItem(root, "Convert whole document", "document", function () {
			convert("document");
		});
		// Reports are silent by default now, so the last one has to be reachable
		// from where the conversion was started.
		menuItem(root, "Show last report", "report", showLastReport);

		window.OnlyOfficeLatexMathContextMenu = root;
	}

	function isHotkey(event) {
		if (!event) {
			return false;
		}
		var keyCode = event.keyCode || event.which;
		return keyCode === HOTKEY_KEY_CODE && !!(event.ctrlKey && event.altKey) && !event.shiftKey;
	}

	function register() {
		if (prepared) {
			return;
		}
		prepared = true;

		// Ctrl+Alt+M converts the whole document.
		//
		// Measured limitation (onlyoffice-git 9.4.0.130-1): the word editor only
		// calls `g_asc_plugins.onPluginEvent2("onKeyDown", ...)` from inside the
		// `isInputHelpersPresent` branch of its key handler, i.e. while a form
		// control / content control input helper owns the keyboard, and only for
		// navigation keys (Tab, Enter, arrows, Home/End, PageUp/Down, Escape).
		// There is therefore no document-level plugin shortcut in this build -
		// the shipped API has no `shortcut` field either. The handler is kept
		// because it is correct wherever the event does arrive, and because a
		// future build may widen the dispatch.
		window.Asc.plugin.attachEvent("onKeyDown", function (event) {
			if (!isHotkey(event)) {
				return;
			}
			// The dispatcher above only spends navigation keys, so a real
			// Ctrl+Alt+M never reaches this line today.
			convert("document");
		});
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
		armPublishBackstop();
		probeEditor();
	};

	// The host calls onTranslate once the editor is up (every shipped plugin
	// uses it), which makes it the publish trigger.
	window.Asc.plugin.onTranslate = function () {
		markEditorReady("translate");
	};

	// Some hosts call onExternalPluginMessage/onThemeChanged only; make sure the
	// plugin still initialises when init is skipped.
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
		convert: convert,
		readDocument: readDocument,
		showLastReport: showLastReport,
		closeReportWindow: closeReportWindow,
		getSettings: function () {
			return settings;
		},
		getLastReport: function () {
			return lastReport;
		}
	};
})(window);
