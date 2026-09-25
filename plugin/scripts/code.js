/*
 * ONLYOFFICE LaTeX math plugin - background plugin entry point.
 *
 * Converts `$...$`, `$$...$$`, `\(...\)` and `\[...\]` runs of LaTeX source text
 * into native ONLYOFFICE (OMML) math objects through the Builder API.
 *
 * Architecture:
 *   - scan.js      pure delimiter scanner (also unit tested outside the plugin)
 *   - locate.js    span placement: character offsets -> document positions
 *   - commands.js  editor-page command bodies and the `run` seam that executes
 *                  them (payload handoff, answer parsing, timeout taxonomy)
 *   - report-record.js  the report record shape and its URL serialization (the
 *                  seam into the report window's page)
 *   - hotkeys.js   the pure hotkey matcher and its binding/modifier tables
 *   - report-text.js  the report's wording (a guard is not malformed)
 *   - settings.js  the stored settings record and the derived scanner options
 *   - code.js      this file: the live settings object, menus, hotkey lifecycle,
 *                  orchestration, report windows
 */
(function (window) {
	"use strict";

	var core = window.OnlyOfficeLatexMath;
	var commands = window.OnlyOfficeLatexMathCommands;
	var locate = window.OnlyOfficeLatexMathLocate;
	var reportRecord = window.OnlyOfficeLatexMathReportRecord;
	var hotkeys = window.OnlyOfficeLatexMathHotkeys;
	var reportText = window.OnlyOfficeLatexMathReportText;
	var settingsModule = window.OnlyOfficeLatexMathSettings;

	if (!core || !commands || !locate || !reportRecord || !hotkeys || !reportText || !settingsModule) {
		// Loading order problem: fail loudly instead of silently doing nothing.
		console.error(
			"[latex-math] scan.js / commands.js / locate.js / report-record.js / hotkeys.js / report-text.js / settings.js missing"
		);
		return;
	}

	// Upper bound on how long the plugin waits for the host to confirm that the
	// editor shell is up before publishing the menus anyway.
	var PUBLISH_BACKSTOP_MS = 1500;

	// One list behind the four delimiter toggles: their labels, their icon slots
	// and the order `updateMenuLabels` refreshes them in. The key names are
	// settings.js's DELIMITER_KEYS; what lives here is presentation only.
	var DELIMITER_TOGGLES = [
		{ key: "inlineDollar", label: "$...$", icon: "inline-dollar" },
		{ key: "displayDollar", label: "$$...$$", icon: "display-dollar" },
		{ key: "inlineParen", label: "\\(...\\)", icon: "inline-paren" },
		{ key: "displayBracket", label: "\\[...\\]", icon: "display-bracket" }
	];

	// The live settings object. settings.js owns the record, its defaults and
	// the derived scanner options (the storage is passed in there, never
	// reached for); this is the copy the menus mutate and `getSettings` hands
	// to the dev console.
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
	 * Editor bridge
	 * ------------------------------------------------------------------ */

	function readDocument() {
		return commands.run("read", {});
	}

	/**
	 * The adapter at locate.js's seam: runs the editor-side probe (commands.js
	 * `resolve`) and hands locate.js its per-paragraph
	 * `{index, positions}` entries. How a char offset becomes a position is
	 * owned behind locate.js; this function only knows how to ask the editor.
	 */
	function resolveSpanPositions(specs) {
		return commands.run("resolve", { paragraphs: specs }).then(function (result) {
			return (result && result.paragraphs) || [];
		});
	}

	/* ------------------------------------------------------------------ *
	 * Reporting
	 *
	 * The record *shape* and its URL serialization are owned by
	 * report-record.js (`make`/`encode`/`decode`/`textOf`) and the report's
	 * *wording* by report-text.js (a guard is not malformed - that policy lives
	 * there, next to the words it chooses). What stays here is the report
	 * *window* lifecycle: when one opens, and how it closes.
	 * ------------------------------------------------------------------ */

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
			// `reportRecord.encode` owns the payload URL's bytes - including the
			// second-"?" separator quirk (see its header). `buttons` is what the
			// host renders as the dialog footer, and the dialog also sets
			// `enableKeyEvents: false`: the close lifecycle those two shape is
			// described once, in report-record.js's header. The footer/X clicks
			// arrive in `Asc.plugin.button` below.
			var variation = {
				url: base + reportRecord.encode(report),
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
			var empty = reportRecord.make(tr("Show last report"));
			reportText.reportLine(empty, tr("No conversion has been run yet."));
			showReport(empty, true);
			return;
		}
		showReport(lastReport, true);
	}

	/* ------------------------------------------------------------------ *
	 * Conversion
	 *
	 * A pipeline: `read -> decide -> plan -> apply -> verify -> render`. The
	 * stages only sequence; the policy is `decide` (pure) and the report's words
	 * are report-text.js's - this section is the composition of the two.
	 * ------------------------------------------------------------------ */

	/**
	 * The plugin's **only** conversion.
	 *
	 * The selection is the unit of work by design: the owner chooses what to
	 * convert and the plugin never decides for them. "The whole document" is
	 * `Ctrl+A` followed by this same action, which keeps one code path (and one
	 * undo step) behind every conversion instead of two with different scopes.
	 *
	 * One stage at a time:
	 *   read    the editor snapshot (`readDocument`)
	 *   decide  policy: may this run at all? (`decide`, pure)
	 *   plan    spans -> operations (locate.js), and the "nothing" refusal
	 *   apply   the operations in the editor (commands.js `apply`)
	 *   verify  re-read and prove the delimiters are gone
	 *   render  the report (report-text.js) and its window
	 *
	 * Resolves with the report it produced, on every path - a refused conversion
	 * is a report too, and callers (and the dev console) should not have to ask
	 * the module whether it kept one.
	 */
	function convertSelection() {
		var run = {
			report: reportRecord.make(tr("Convert selection")),
			proceed: true,
			refusal: null
		};
		return readStage(run)
			.then(function () {
				return decideStage(run);
			})
			.then(function () {
				return run.proceed ? planStage(run) : null;
			})
			.then(function () {
				return run.proceed ? applyStage(run) : null;
			})
			.then(function () {
				return run.proceed ? verifyStage(run) : null;
			})
			.then(function () {
				return renderStage(run);
			});
	}

	/** Stage `read`: the snapshot the rest of the pipeline works against. */
	function readStage(run) {
		return readDocument().then(function (snapshot) {
			run.snapshot = snapshot;
		});
	}

	/**
	 * Stage `decide`: the conversion's policy, and the only place that decides
	 * whether the pipeline proceeds.
	 *
	 * Pure - a snapshot and the settings in, `{proceed, selection}` or
	 * `{proceed: false, refusal}` out. No editor calls and no report wording
	 * here: the refusals name their reason and report-text.js owns the words.
	 * A failed read is decided like any other snapshot (`unreadable`), so the
	 * outcome of a conversion never depends on how far a stage got.
	 */
	function decide(snapshot, settings) {
		if (settingsModule.enabledDelimiterCount(settings) === 0) {
			return { proceed: false, refusal: { reason: "no-delimiters" } };
		}
		if (!snapshot || snapshot.error) {
			return { proceed: false, refusal: { reason: "unreadable", detail: snapshot } };
		}
		// The editor always reports a selection: an empty one where the
		// caret happens to sit when nothing is highlighted. Only a real
		// (non-collapsed) selection may scope the conversion - a collapsed
		// caret is a no-op, never a whole-document surprise.
		var selection = snapshot.selection;
		if (!selection || selection.start === selection.end) {
			return { proceed: false, refusal: { reason: "no-selection" } };
		}
		return { proceed: true, selection: selection };
	}

	function decideStage(run) {
		var decision = decide(run.snapshot, settings);
		if (decision.proceed) {
			run.selection = decision.selection;
			return;
		}
		run.proceed = false;
		run.refusal = decision.refusal;
	}

	/**
	 * Stage `plan`: spans -> operations against the resolved positions - or the
	 * `nothing` refusal, which is plan's own outcome ("nothing to convert") and
	 * reads after the plan's lines in the report.
	 */
	function planStage(run) {
		return locate
			.plan(run.snapshot, settingsModule.scannerOptions(settings), run.selection, resolveSpanPositions)
			.then(function (plan) {
				run.plan = plan;
				// locate.plan reports only what could not be read, and the
				// snapshot counts every paragraph either readable or unusable -
				// so the scanned count is the difference.
				run.scanned = ((run.snapshot && run.snapshot.paragraphs) || []).length - plan.unusable;
				if (!plan.operations.length) {
					run.proceed = false;
					run.refusal = { reason: "nothing" };
				}
			});
	}

	/** Stage `apply`: the planned operations, one undo point behind them. */
	function applyStage(run) {
		return commands
			.run("apply", {
				operations: run.plan.operations,
				createHistoryPoint: true
			})
			.then(function (result) {
				run.applyResult = result;
				if (!result || result.error) {
					run.proceed = false;
					return;
				}
				run.report.converted = (result.applied || []).length;
			});
	}

	/**
	 * Stage `verify`: re-read the document and prove the delimiters are gone -
	 * scoped to the same selection the conversion used.
	 */
	function verifyStage(run) {
		return readDocument().then(function (snapshot) {
			if (!snapshot || snapshot.error) {
				run.verifyResult = { failure: snapshot };
				return;
			}
			return locate
				.plan(snapshot, settingsModule.scannerOptions(settings), run.selection, resolveSpanPositions)
				.then(function (plan) {
					run.verifyResult = { remaining: plan.operations.length, converted: run.report.converted };
				});
		});
	}

	/**
	 * Stage `render`: the report's words and its window. Every path lands here
	 * and the order of the lines is the order of the stages - the `nothing`
	 * refusal is the one line that follows its stage's own lines.
	 */
	function renderStage(run) {
		var report = run.report;
		if (run.plan) {
			reportText.planLines(report, tr, run.plan, run.scanned);
		}
		if (run.refusal) {
			reportText.reportLine(report, reportText.refusalLine(tr, run.refusal));
		}
		if (run.applyResult) {
			if (run.applyResult.error) {
				reportText.reportLine(report, reportText.applyFailureLine(tr, run.applyResult));
			} else {
				reportText.applyLines(report, tr, run.applyResult, run.plan.operations.length);
			}
		}
		if (run.verifyResult) {
			if (run.verifyResult.failure) {
				reportText.reportLine(report, reportText.verifyFailureLine(tr, run.verifyResult.failure));
			} else {
				reportText.verifyLines(report, tr, run.verifyResult.remaining, run.verifyResult.converted);
			}
		}
		showReport(report);
		return report;
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
					settingsModule.saveSettings(settings, window.localStorage);
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
			settingsModule.saveSettings(settings, window.localStorage);
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
	 * The rule set itself - the matcher, its binding/modifier tables, the chord
	 * timing - is hotkeys.js (pure; its header carries the measurement that
	 * shaped it). What stays here is the DOM lifecycle: there is no plugin
	 * shortcut API in this build and the host's own key event never reaches a
	 * plugin at document level (see `register`), so the plugin listens to the
	 * editor's document itself. The plugin frame is a child of the editor's
	 * main frame and both are `file://` origin, so `window.parent.document` is
	 * reachable - measured live, plan section 2.2.
	 * ------------------------------------------------------------------ */

	var hotkeyStatus = {
		attached: 0,
		blocked: 0,
		chords: hotkeys.HOTKEYS.map(function (binding) {
			return binding.mods.join("+") + "+" + binding.key.toUpperCase();
		})
	};
	var hotkeyMarker = "onlyOfficeLatexMathHotkey" + (window.Asc.plugin.guid || "");

	function attachToDocument(doc, matcher) {
		if (doc[hotkeyMarker]) {
			return; // idempotent: a re-init must not double-fire
		}
		function onKeyDown(event) {
			var binding = null;
			try {
				binding = matcher.keydown(event, hotkeys.nowMs());
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
		var matcher = hotkeys.createHotkeyMatcher(hotkeys.HOTKEYS);
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

	// A trivial command that only the live editor can answer (body in
	// commands.js as `probe`); its answer proves the document is loaded, hence
	// that the toolbar that hosts the menu exists.
	function probeEditor() {
		commands.run("probe", {}).then(function (result) {
			if (result && result.latexMathProbe === true) {
				markEditorReady("roundtrip");
			}
		});
	}

	window.Asc.plugin.init = function () {
		settings = settingsModule.loadSettings(window.localStorage);
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
			settings = settingsModule.loadSettings(window.localStorage);
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

	// The plugin-frame half of the close protocol. The protocol has one
	// description - the header of report-record.js; this is its call site.
	// Mandatory once the plugin opens a window: without this hook the host's
	// injected router throws and nothing closes at all (measured 9.4.0.130-1;
	// the router source: docs/NOTE.md §1.5).
	window.Asc.plugin.button = function (id, windowId) {
		if (!windowId) {
			return;
		}
		if (!reportWindow || String(reportWindow.id) !== String(windowId)) {
			return;
		}
		// Every id closes the report window.
		closeReportWindow();
	};

	// Exposed for manual testing from the plugin dev console.
	window.OnlyOfficeLatexMathApi = {
		convertSelection: convertSelection,
		// The pipeline's policy, pure and exposed on its own:
		// `decide(snapshot, settings)` -> `{proceed, selection}` or a refusal.
		decide: decide,
		readDocument: readDocument,
		showLastReport: showLastReport,
		closeReportWindow: closeReportWindow,
		// Re-running the attach is harmless (the document marker makes it
		// idempotent) and is how the hotkeys can be inspected from the console.
		attachHotkeys: attachHotkeys,
		createHotkeyMatcher: hotkeys.createHotkeyMatcher,
		getHotkeys: function () {
			return hotkeys.HOTKEYS;
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
