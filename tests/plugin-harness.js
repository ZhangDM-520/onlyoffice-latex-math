/*
 * Loads the real plugin (`code.js`) into a fake browser window so the whole
 * pipeline can be exercised headlessly: menu registration, the read/apply
 * commands running against the simulated editor, the report payload and the
 * hotkey handler.
 */
"use strict";

var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var core = require(path.join(__dirname, "..", "plugin", "scripts", "scan.js"));
var commands = require(path.join(__dirname, "..", "plugin", "scripts", "commands.js"));

var CODE_SOURCE = fs.readFileSync(path.join(__dirname, "..", "plugin", "scripts", "code.js"), "utf8");

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
	var harness = {
		roots: [],
		contextMenus: [],
		windows: [],
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
		if (parent) {
			parent.children.push(self);
		} else {
			harness.roots.push(self);
		}
	}
	Matcher.prototype.attachOnClick = function (handler) {
		this.onClick = handler;
	};
	Matcher.prototype.click = function () {
		if (this.onClick) {
			return this.onClick();
		}
		return undefined;
	};
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
			var composed = { id: item.id, text: item.text, items: [] };
			item.children.forEach(function (child) {
				if (composes(child)) {
					composed.items.push(build(child));
				}
			});
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

	function PluginWindow() {
		var self = this;
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
			// The real host stringifies the command and evaluates it inside the
			// editor page, so the harness recompiles the source in the simulated
			// editor realm instead of calling it in the test realm.
			callCommand: function (commandFn, isClose, isCalc, callback) {
				harness.executedCommands.push({ isClose: isClose, isCalc: isCalc });
				// A host whose editor is still loading never answers; used to
				// reproduce the startup window in which menu registration is
				// dropped.
				if (options.editorReady === false) {
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
		// Pending timers (the command timeout, the publish backstop) must not keep
		// the test process alive, hence unref - they still fire while the loop is
		// busy with other tests.
		setTimeout: function (handler, delay) {
			var timer = setTimeout(handler, delay);
			if (timer && typeof timer.unref === "function") {
				timer.unref();
			}
			return timer;
		},
		clearTimeout: clearTimeout,
		console: console,
		OnlyOfficeLatexMath: core,
		OnlyOfficeLatexMathCommands: commands
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
		convert: function (mode) {
			return windowStub.OnlyOfficeLatexMathApi.convert(mode);
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
