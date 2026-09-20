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
		openReport: true
	};

	var settings = null;
	var lastReport = null;
	var reportWindow = null;
	var prepared = false;
	var published = false;
	var backstopArmed = false;
	var readySignals = {};
	var menuRoot = null;
	var menuItems = [];

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
		var merged = {};
		Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
			merged[key] = typeof loaded[key] === "boolean" ? loaded[key] : DEFAULT_SETTINGS[key];
		});
		return merged;
	}

	function saveSettings() {
		try {
			window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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

	function showReport(report) {
		lastReport = report;
		updateMenuLabels();

		if (!settings.openReport) {
			return;
		}

		try {
			var location = window.location;
			var start = location.pathname.lastIndexOf("/") + 1;
			var file = location.pathname.substring(start);
			var base = location.href.replace(file, "report.html");
			var payload = encodeURIComponent(JSON.stringify(report));
			var variation = {
				url: base + "?report=" + payload,
				description: tr("LaTeX math conversion report"),
				isVisual: true,
				isModal: false,
				isViewer: true,
				EditorsSupport: ["word"],
				size: [520, 380],
				buttons: []
			};

			if (!reportWindow) {
				reportWindow = new window.Asc.PluginWindow();
			}
			reportWindow.show(variation);
		} catch (e) {
			console.error("[latex-math] cannot open report window", e);
		}
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
						tr("Skipped paragraphs whose text offsets cannot be mapped") + ": " + collected.unusable
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

	function buildToolbar() {
		function icon(name) {
			return "resources/icons/%theme-type%(light|dark)/big/" + name + "%scale%(default).png";
		}

		menuRoot = new window.Asc.ButtonToolbar();
		menuRoot.text = tr("LaTeX math");
		menuRoot.icons = icon("latex");
		menuItems = [];

		function addItem(text, handler, icons) {
			var item = new window.Asc.ButtonToolbar(menuRoot);
			item.text = text;
			if (icons) {
				item.icons = icons;
			}
			item.attachOnClick(handler);
			menuItems.push(item);
			return item;
		}

		addItem(tr("Convert document"), function () {
			convert("document");
		});

		addItem(tr("Convert selection"), function () {
			convert("selection");
		});

		addItem(tr("Convert selection as display math"), function () {
			convert("selection-display");
		});

		addItem(tr("Show last report"), function () {
			if (!lastReport) {
				var empty = makeReport(tr("Show last report"));
				reportLine(empty, tr("No conversion has been run yet."));
				showReport(empty);
				return;
			}
			showReport(lastReport);
		});

		// Delimiter toggles live at the bottom of the menu.
		var toggles = [
			{ key: "inlineDollar", label: "$...$" },
			{ key: "displayDollar", label: "$$...$$" },
			{ key: "inlineParen", label: "\\(...\\)" },
			{ key: "displayBracket", label: "\\[...\\]" }
		];
		toggles.forEach(function (toggle) {
			var item = addItem(delimiterLabel(toggle), function () {
				settings[toggle.key] = !settings[toggle.key];
				saveSettings();
				updateMenuLabels();
			});
			item.delimiterKey = toggle.key;
		});

		window.OnlyOfficeLatexMathMenu = menuRoot;
	}

	function delimiterLabel(toggle) {
		return (settings[toggle.key] ? "\u2713 " : "\u2717 ") + toggle.label;
	}

	function updateMenuLabels() {
		if (!menuRoot) {
			return;
		}
		var toggles = [
			{ key: "inlineDollar", label: "$...$" },
			{ key: "displayDollar", label: "$$...$$" },
			{ key: "inlineParen", label: "\\(...\\)" },
			{ key: "displayBracket", label: "\\[...\\]" }
		];
		menuItems.forEach(function (item, index) {
			var toggle = toggles[index - (menuItems.length - toggles.length)];
			if (toggle) {
				item.text = delimiterLabel(toggle);
			}
		});
		if (lastReport) {
			var reportItem = menuItems[menuItems.length - toggles.length - 1];
			if (reportItem) {
				reportItem.text = tr("Show last report") + " (" + reportItem_converted() + ")";
			}
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
		function icon(name) {
			return "resources/icons/%theme-type%(light|dark)/" + name + "%scale%(default).png";
		}

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
				item.icons = icon(iconName);
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
		menuItem(root, "Convert selection", null, function () {
			convert("selection");
		});
		menuItem(root, "Convert whole document", null, function () {
			convert("document");
		});

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

	// Exposed for manual testing from the plugin dev console.
	window.OnlyOfficeLatexMathApi = {
		convert: convert,
		readDocument: readDocument,
		getSettings: function () {
			return settings;
		},
		getLastReport: function () {
			return lastReport;
		}
	};
})(window);
