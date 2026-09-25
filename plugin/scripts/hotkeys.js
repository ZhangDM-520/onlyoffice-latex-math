/*
 * The hotkey rule set: the pure matcher that turns the editor's raw key stream
 * into the binding it completes (or `null` when the key is not ours).
 *
 * A chord does NOT arrive with its modifiers (measured).
 *
 * Measured with injected keystrokes against 9.4.0.130-1 on Linux/X11 (plan
 * section 2.3, the only input path available when driving the app from a
 * terminal): holding Alt and pressing L delivers *two* events - `Alt` (key
 * "Alt", altKey true) and then `l` with keyCode 76, code "KeyL" and EVERY
 * modifier flag false - and the editor inserts that `l` into the document as
 * text. `Ctrl+Alt+M` behaves identically (both flags false, an `m` inserted).
 * Whether a *physical* chord keeps its flags is untested; Chromium's
 * access-key pass is the likely cause of the loss, and the matcher accepts
 * both shapes so it does not matter.
 *
 * Consequences, and why this matcher is shaped the way it is:
 *   - a chord is recognised from the MODIFIER key presses that precede the
 *     bound key as well as from the bound key's own flags;
 *   - the modifier set must match the binding EXACTLY, which is what keeps a
 *     plain `l` and an ordinary `Ctrl+L` out of the branch;
 *   - a claimed key must be swallowed, or it lands in the document.
 *
 * Do not "simplify" this back to a `keyCode === 76` or `event.altKey` test.
 *
 * Pure and injectable: everything the matcher knows comes from the events
 * handed to it plus the `now` the caller passes (`nowMs` is only a clock
 * helper), so the whole rule set - including the timing - is testable without
 * a browser. The DOM lifecycle (the `window.parent` walk, the capture-phase
 * listeners, the swallow itself) stays in code.js: alone it is a pass-through
 * over frame walking and has no rules worth a file of its own.
 *
 * Loadable both as a CommonJS module (node --test) and as a plain script that
 * exposes `window.OnlyOfficeLatexMathHotkeys` inside the plugin iframe.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.OnlyOfficeLatexMathHotkeys = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

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

	/** The one clock the matcher's caller needs; realm-safe, no window. */
	function nowMs() {
		if (typeof Date !== "undefined" && typeof Date.now === "function") {
			return Date.now();
		}
		return new Date().getTime();
	}

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

	return {
		HOTKEYS: HOTKEYS,
		CHORD_MODIFIER_WINDOW_MS: CHORD_MODIFIER_WINDOW_MS,
		MODIFIER_KEYS: MODIFIER_KEYS,
		MODIFIER_CODES: MODIFIER_CODES,
		nowMs: nowMs,
		createHotkeyMatcher: createHotkeyMatcher
	};
});
