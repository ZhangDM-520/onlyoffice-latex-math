/*
 * Loads the real plugin (`code.js`) into a fake browser window so the whole
 * pipeline can be exercised headlessly: menu registration, the read/apply
 * commands running against the simulated editor, the report payload and the
 * hotkey handler.
 *
 * Host contract: Desktop Editors 9.4.0.130-1, editors/sdkjs-plugins/{pluginBase.js,v1/plugins.js}
 */
"use strict";

var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var core = require(path.join(__dirname, "..", "plugin", "scripts", "scan.js"));
var locate = require(path.join(__dirname, "..", "plugin", "scripts", "locate.js"));

var CODE_SOURCE = fs.readFileSync(path.join(__dirname, "..", "plugin", "scripts", "code.js"), "utf8");
// commands.js is loaded the way production loads it - inside the fake plugin
// frame - because its `run` seam reaches the host through the UMD root, which
// must be that frame's `window`/`self`. The pure modules above are ordinary
// Node requires; the compiled command bodies can also be driven directly from
// the test realm (see tests/integration.test.js).
var COMMANDS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "plugin", "scripts", "commands.js"), "utf8");
// report-record.js is loaded the way production loads it too - a plain script
// of the fake plugin frame, before code.js (index.html's order).
var REPORT_RECORD_SOURCE = fs.readFileSync(
	path.join(__dirname, "..", "plugin", "scripts", "report-record.js"),
	"utf8"
);

function createStorage() {
	var data = {};
	return {
		getItem: function (key) {
			return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
		},
		setItem: function (key, value) {
			data[key] = String(value);
		},
		removeItem: function (key) {
			delete data[key];
		},
		dump: function () {
			return data;
		}
	};
}

function createWindowElement() {
	return null;
}

/**
 * @param {object} editor result of `createEditor`
 * @param {object} [options] `{ editorExposedAsWindowEditor: boolean, exposeAscBuilder: boolean }`
 */
function createHarness(editor, options) {
	options = options || {};

	var context = {};
	// `commandOverlaps` fires once per harness: the knob models one overlap
	// event (a second conversion re-entering `run` before the first answers).
	var overlapped = false;
	var harness = {
		roots: [],
		contextMenus: [],
		windows: [],
		windowCloses: [],
		events: {},
		executedCommands: [],
		toolbarUpdates: [],
		errors: []
	};

	function Matcher(parent) {
		var self = this;
		self.parent = parent || null;
		self.children = [];
		self.text = "";
		self.name = "item-" + harness.roots.length + "-" + Math.random().toString(36).substring(2, 8);
		self.id = self.name;
		self.enabled = true;
		self.onClick = null;
		self.icons = null;
		if (parent) {
			parent.children.push(self);
		} else {
			harness.roots.push(self);
		}
	}
	Matcher.prototype.attachOnClick = function (handler) {
		this.onClick = handler;
	};
	// CONVENIENT: synthetic shortcut - the host offers no click(); a real chord is
	// two key events and the injected router is what reaches onClick.
	Matcher.prototype.click = function () {
		if (this.onClick) {
			return this.onClick();
		}
		return undefined;
	};
	// MIRROR(toItem, 9.4.0.130-1):
	// Mirrors the shipped `toItem` (`pluginBase.js`) in the one respect this
	// plugin depends on: `items` is emitted **only** when the node has children
	// (`this.menu && (a.items = ...)`). A childless item is therefore a plain row
	// or button to the host rather than a menu - which is what makes both the
	// single-row right-click entry and the flat ribbon tab possible.
	Matcher.prototype.toItem = function () {
		var item = { id: this.id, text: this.text, disabled: false };
		if (this.icons) {
			item.icons = this.icons;
		}
		if (this.separator) {
			item.separator = true;
		}
		if (this.children.length) {
			item.items = this.children.map(function (child) {
				return child.toItem();
			});
		}
		return item;
	};
	// MIRROR(showOnOptionsType, 9.4.0.130-1):
	// Mirrors Asc.ButtonContextMenu / ButtonToolbar in the shipped v1/plugins.js:
	// `showOnOptionsType` starts empty and the host only offers the item when the
	// live context type matches a checker (or a checker is the literal "All").
	Matcher.prototype.addCheckers = function () {
		this.showOnOptionsType = Array.prototype.slice.call(arguments);
		return this;
	};

	// Asc.ButtonContextMenu and Asc.ButtonToolbar differ in the shipped
	// v1/plugins.js (`q` vs `r`); the kind is recorded so tests can address the
	// document right-click menu without relying on caption text.
	function ButtonContextMenuItem(parent) {
		Matcher.call(this, parent);
		this.itemType = "contextMenu";
	}
	ButtonContextMenuItem.prototype = Object.create(Matcher.prototype);
	ButtonContextMenuItem.prototype.constructor = ButtonContextMenuItem;

	function ButtonToolbarItem(parent) {
		Matcher.call(this, parent);
		this.itemType = "toolbar";
	}
	ButtonToolbarItem.prototype = Object.create(Matcher.prototype);
	ButtonToolbarItem.prototype.constructor = ButtonToolbarItem;
	// MIRROR(r.prototype.toItem, 9.4.0.130-1):
	// `r.prototype.toItem` stamps the item type on top of the shared projection.
	ButtonToolbarItem.prototype.toItem = function () {
		var item = Matcher.prototype.toItem.call(this);
		item.type = "button";
		return item;
	};

	// MIRROR(ButtonContextMenu.prototype.onContextMenuShow, 9.4.0.130-1):
	// Reproduces `ButtonContextMenu.prototype.onContextMenuShow` from the shipped
	// v1/plugins.js, including the detail that made the live menu dead: the host
	// recurses into `childs` through the *same* checker gate, so a child with an
	// empty `showOnOptionsType` is dropped and the submenu comes out empty.
	harness.composeContextMenu = function (contextType) {
		function composes(item) {
			var checkers = item.showOnOptionsType || [];
			for (var i = 0; i < checkers.length; i++) {
				if (checkers[i] === contextType || checkers[i] === "All") {
					return true;
				}
			}
			return false;
		}
		function build(item) {
			// `items` is omitted when the node has no children: that is what the
			// host turns into a plain, immediately-clickable row (see toItem above).
			var composed = { id: item.id, text: item.text };
			if (item.children.length) {
				composed.items = [];
				item.children.forEach(function (child) {
					if (composes(child)) {
						composed.items.push(build(child));
					}
				});
			}
			return composed;
		}
		var items = [];
		harness.roots.forEach(function (root) {
			if (root.itemType === "contextMenu" && composes(root)) {
				items.push(build(root));
			}
		});
		return { items: items };
	};

	// MIRROR(r.prototype.toToolbar, 9.4.0.130-1):
	// Reproduces `r.prototype.toToolbar` from the shipped v1/plugins.js: a root with
	// `parent === null` becomes the **tab** and its own `toItem()` is never emitted,
	// so every ribbon button is a child of the root. That is why a plugin cannot
	// make the tab itself an action.
	//
	// The "items only when there are children" rule appears in three places here
	// (`Matcher.prototype.toItem`, `build()` in composeContextMenu, and this
	// projection) on purpose: each mirrors a *different* host function, and the
	// point of the mirror is to reproduce the host's own structure rather than to
	// share a helper with itself.
	harness.composeToolbar = function () {
		var tabs = [];
		harness.roots.forEach(function (root) {
			if (root.itemType !== "toolbar" || root.parent !== null) {
				return;
			}
			tabs.push({
				id: root.id,
				text: root.text,
				items: root.children.map(function (child) {
					return child.toItem();
				})
			});
		});
		return { tabs: tabs };
	};

	// Every timer the fake window arms is recorded, so a test can tell a
	// cleared backstop from an orphaned one (the command timeout is armed
	// before `callCommand` and must be cleared by the first answer).
	var timers = [];
	harness.timers = timers;
	function setTimer(handler, delay) {
		var record = { delay: delay, cleared: false, fired: false, handle: null };
		timers.push(record);
		record.handle = setTimeout(function () {
			record.fired = true;
			handler();
		}, delay);
		// Pending timers (the command timeout, the publish backstop) must not
		// keep the test process alive, hence unref - they still fire while the
		// loop is busy with other tests.
		if (record.handle && typeof record.handle.unref === "function") {
			record.handle.unref();
		}
		return record.handle;
	}
	function clearTimer(handle) {
		timers.forEach(function (record) {
			if (record.handle === handle) {
				record.cleared = true;
			}
		});
		clearTimeout(handle);
	}

	function PluginWindow() {
		var self = this;
		// The real host generates a uuid per PluginWindow instance, so a fresh
		// instance is what makes a second report a *new* window.
		this.id = "window-" + harness.windows.length;
		this.events = {};
		this.attachEvent = function (name, handler) {
			self.events[name] = handler;
		};
		this.command = function () {};
		this.activate = function () {};
		this.show = function (variation) {
			harness.windows.push({ id: self.id, variation: variation });
		};
		// MIRROR(PluginWindow.prototype.close, 9.4.0.130-1):
		// Mirror of PluginWindow.prototype.close(): executeMethod("CloseWindow").
		this.close = function () {
			harness.windowCloses.push(self.id);
		};
	}

	var Asc = {
		plugin: {
			info: {},
			attachEvent: function (name, handler) {
				harness.events[name] = handler;
			},
			tr: function (text) {
				return text;
			},
			executeMethod: function () {},
			// FAITHFUL(async seam): the real host answers callCommand
			// asynchronously and evaluates the command in the editor page at
			// some later point - reading the shared `Asc.scope` payload slot at
			// *evaluation* time, which is exactly what lets a second run in
			// flight swap payloads. The harness therefore defers both the
			// evaluation and the callback (a microtask by default, `commandDelay`
			// ms when asked) and reads `Asc.scope` only when the command runs.
			// Knobs for the seam's failure shapes: `commandDelay`,
			// `commandNeverAnswers`, `commandRaw` (answer with a raw string),
			// `commandOverlaps` (re-enter `run` before this command answers,
			// once per harness).
			// The real host stringifies the command and evaluates it inside the
			// editor page, so the harness recompiles the source in the simulated
			// editor realm instead of calling it in the test realm.
			callCommand: function (commandFn, isClose, isCalc, callback) {
				harness.executedCommands.push({ isClose: isClose, isCalc: isCalc });
				// A host whose editor is still loading never answers; used to
				// reproduce the startup window in which menu registration is
				// dropped. `commandNeverAnswers` is the same shape on demand.
				if (options.editorReady === false || options.commandNeverAnswers) {
					return;
				}
				if (typeof options.commandOverlaps === "function" && !overlapped) {
					overlapped = true;
					options.commandOverlaps();
				}
				function deliver() {
					if (options.commandRaw !== undefined) {
						if (typeof callback === "function") {
							callback(options.commandRaw);
						}
						return;
					}
					context.__scope = Asc.scope || {};
					var wrapper =
						"(function () { var Asc = {}; Asc.scope = __scope; var scope = Asc.scope; return (" +
						commandFn.toString() +
						")(); })()";
					var result;
					try {
						result = vm.runInContext(wrapper, context, { filename: "command.js" });
					} catch (error) {
						harness.errors.push(error);
						result = JSON.stringify({ error: "threw: " + error.message });
					}
					if (typeof callback === "function") {
						callback(result);
					}
				}
				if (typeof options.commandDelay === "number") {
					setTimer(deliver, options.commandDelay);
				} else {
					Promise.resolve().then(deliver);
				}
			}
		},
		Buttons: {
			registerToolbarMenu: function () {
				harness.toolbarRegistered = true;
			},
			registerContextMenu: function () {
				harness.contextMenuRegistered = true;
			},
			updateToolbarMenu: function (id, caption) {
				harness.toolbarUpdates.push({ id: id, caption: caption });
			},
			registerFloatActionButtons: function () {}
		},
		ButtonToolbar: ButtonToolbarItem,
		ButtonContextMenu: ButtonContextMenuItem,
		ButtonFloatAction: Matcher,
		PluginWindow: PluginWindow,
		Editor: {
			getType: function () {
				return "word";
			},
			callMethod: function () {
				return Promise.resolve();
			}
		}
	};

	var windowStub = {
		Asc: Asc,
		location: {
			href: "file:///plugins/latex-math/index.html",
			pathname: "/plugins/latex-math/index.html"
		},
		localStorage: createStorage(),
		document: { getElementById: createWindowElement, addEventListener: function () {} },
		navigator: {},
		// Pending timers (the command timeout, the publish backstop) are tracked
		// in `harness.timers` and unref'd so they cannot keep the test process
		// alive - they still fire while the loop is busy with other tests.
		setTimeout: setTimer,
		clearTimeout: clearTimer,
		console: console,
		OnlyOfficeLatexMath: core,
		OnlyOfficeLatexMathLocate: locate
	};
	windowStub.window = windowStub;

	if (options.exposeAscBuilder) {
		windowStub.AscBuilder = { Word: { Api: editor.apiDocument } };
	} else {
		context.Api = editor.apiDocument;
	}
	if (options.editorExposedAsWindowEditor) {
		windowStub.editor = editor.editorApi;
	}

	// MIRROR(window.parent frame chain, 9.4.0.130-1):
	// The plugin's background frame is a child frame in the editor window, so it can
	// reach the editor's own document through `parent.document` - measured live
	// against 9.4.0.130-1 (plan section 2.2). The chain is modelled here so the
	// ancestor walk and the capture-phase listener registration are testable, and so
	// a host that blocks the access can be reproduced with `parentAccessThrows`.
	var parentDocuments = [];
	function createDocumentStub(label) {
		var stub = {
			label: label,
			listeners: { keydown: [], keyup: [] },
			addEventListener: function (type, handler, capture) {
				if (stub.listeners[type]) {
					stub.listeners[type].push({ handler: handler, capture: !!capture });
				}
			},
			removeEventListener: function () {}
		};
		parentDocuments.push(stub);
		return stub;
	}
	function createFrameStub(document, parent) {
		return { document: document, parent: parent };
	}

	var editorDocument = createDocumentStub("editor");
	var apiDocument = createDocumentStub("api");
	var apiFrame = createFrameStub(apiDocument, null);
	var editorFrame = createFrameStub(editorDocument, apiFrame);
	// `window.parent` of a top-level frame is the frame itself, which is what makes
	// the plugin's walk terminate.
	apiFrame.parent = apiFrame;
	windowStub.parent = editorFrame;

	// CONVENIENT: an invented stress-host shape, not a measured 9.4.0.130-1
	// behaviour - the knob exists so the plugin's degradation path is testable.
	// A host that keeps plugins on an opaque origin: every reach into the parent
	// throws, and the plugin must degrade instead of breaking.
	if (options.parentAccessThrows) {
		Object.defineProperty(windowStub, "parent", {
			get: function () {
				throw new Error("SecurityError: Blocked a frame with origin file:// from accessing a frame");
			}
		});
	}
	// The other opaque-origin shape, and the one the shipped AI plugin hits: the
	// frame is reachable but its `document` throws, so the walk counts a refusal
	// and continues to the next ancestor.
	if (options.parentDocumentThrows) {
		Object.defineProperty(editorFrame, "document", {
			get: function () {
				throw new Error("SecurityError: Blocked a frame with origin onlyoffice://plugin");
			}
		});
	}

	// Delivers a key event the way the host does: a capture-phase listener on the
	// *editor* document sees it first (that document owns the hidden TEXTAREA the SDK
	// types into), and it is the modifier flags a real keystroke carries - which, as
	// measured, are all false for a chord.
	function makeKeyEvent(spec) {
		spec = spec || {};
		var event = {
			key: spec.key || "",
			code: spec.code || "",
			keyCode: spec.keyCode || 0,
			ctrlKey: !!spec.ctrl,
			altKey: !!spec.alt,
			shiftKey: !!spec.shift,
			metaKey: !!spec.meta,
			repeat: !!spec.repeat,
			altGraph: !!spec.altGraph,
			stopped: false,
			prevented: false,
			stopPropagation: function () {
				event.stopped = true;
			},
			preventDefault: function () {
				event.prevented = true;
			},
			getModifierState: function (name) {
				return name === "AltGraph" ? event.altGraph : false;
			}
		};
		return event;
	}

	function dispatchKey(type, spec) {
		var event = makeKeyEvent(spec);
		editorDocument.listeners[type].slice().forEach(function (entry) {
			entry.handler(event);
		});
		return event;
	}

	harness.parentDocuments = parentDocuments;
	harness.pressKey = function (spec) {
		return dispatchKey("keydown", spec);
	};
	harness.releaseKey = function (spec) {
		return dispatchKey("keyup", spec);
	};
	// MIRROR(key event delivery, 9.4.0.130-1):
	// The chord as the host actually delivers it: the modifier keydown, then the
	// bound key carrying no modifier flag at all, then the keyups.
	harness.pressAltChord = function (code, key) {
		var altDown = dispatchKey("keydown", { key: "Alt", code: "AltLeft", keyCode: 18, alt: true });
		var chord = dispatchKey("keydown", { key: key, code: code, keyCode: key === "l" ? 76 : 77 });
		dispatchKey("keyup", { key: key, code: code });
		dispatchKey("keyup", { key: "Alt", code: "AltLeft", keyCode: 18 });
		return { altDown: altDown, chord: chord };
	};

	context.window = windowStub;
	context.self = windowStub;
	context.console = console;
	context.setTimeout = setTimeout;
	context.clearTimeout = clearTimeout;
	context.Promise = Promise;
	context.JSON = JSON;
	context.Date = Date;
	context.Object = Object;
	context.Array = Array;

	vm.createContext(context);
	vm.runInContext(COMMANDS_SOURCE, context, { filename: "commands.js" });
	vm.runInContext(REPORT_RECORD_SOURCE, context, { filename: "report-record.js" });
	vm.runInContext(CODE_SOURCE, context, { filename: "code.js" });

	return {
		window: windowStub,
		Asc: Asc,
		harness: harness,
		// The desktop host calls `init` while the editor is still booting and
		// `onTranslate` a moment later, once it is up: only then are menus
		// accepted. Most tests want that full sequence.
		init: function () {
			Asc.plugin.init();
			Asc.plugin.onTranslate();
			return harness;
		},
		initOnly: function () {
			Asc.plugin.init();
			return harness;
		},
		translate: function () {
			Asc.plugin.onTranslate();
			return harness;
		},
		// There is one conversion and it always acts on the selection.
		convertSelection: function () {
			return windowStub.OnlyOfficeLatexMathApi.convertSelection();
		},
		// The seam under test: `run` is the only way plugin code reaches the
		// editor page. `timeoutMs` overrides the 30 s backstop so timeout paths
		// cost milliseconds.
		runCommand: function (name, payload, timeoutMs) {
			return windowStub.OnlyOfficeLatexMathCommands.run(name, payload, timeoutMs);
		},
		composeToolbar: function () {
			return harness.composeToolbar();
		},
		// The hotkey surface. `pressAltChord` replays the *real* sequence measured in
		// plan section 2.3: the modifier keydown, then the bound key with every
		// modifier flag false, then the keyups.
		pressKey: function (spec) {
			return harness.pressKey(spec);
		},
		releaseKey: function (spec) {
			return harness.releaseKey(spec);
		},
		pressAltChord: function (code, key) {
			return harness.pressAltChord(code, key);
		},
		countParentListeners: function (type) {
			return parentDocuments.reduce(function (total, doc) {
				return total + doc.listeners[type || "keydown"].length;
			}, 0);
		},
		listenerCounts: function () {
			return parentDocuments.map(function (doc) {
				return { label: doc.label, keydown: doc.listeners.keydown.length, keyup: doc.listeners.keyup.length };
			});
		},
		attachHotkeys: function () {
			windowStub.OnlyOfficeLatexMathApi.attachHotkeys();
		},
		getHotkeyStatus: function () {
			return windowStub.OnlyOfficeLatexMathApi.getHotkeyStatus();
		},
		createHotkeyMatcher: function () {
			return windowStub.OnlyOfficeLatexMathApi.createHotkeyMatcher(
				windowStub.OnlyOfficeLatexMathApi.getHotkeys()
			);
		},
		// `Asc.plugin.button(id, windowId)` is what the host's injected router
		// calls for the dialog's header X (-1) and for every footer button. The
		// plugin must define it or the router throws and the window never closes.
		pressWindowButton: function (id, windowId) {
			return Asc.plugin.button(id, windowId);
		},
		openReport: function () {
			windowStub.OnlyOfficeLatexMathApi.showLastReport();
			return harness;
		},
		getLastReport: function () {
			return windowStub.OnlyOfficeLatexMathApi.getLastReport();
		},
		getSettings: function () {
			return windowStub.OnlyOfficeLatexMathApi.getSettings();
		},
		findToolbarItem: function (text) {
			var root = harness.roots[0];
			if (!root) {
				return null;
			}
			return (
				root.children.filter(function (child) {
					return child.text === text;
				})[0] || null
			);
		}
	};
}

module.exports = { createHarness: createHarness, createStorage: createStorage };
