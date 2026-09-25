# Engineering notes — LaTeX math plugin

Measured against **onlyoffice-git 9.4.0.130-1** (built from
`~/Projects/Gentoo_Style_Arch/packages/git/onlyoffice-git`), upstream sdkjs pinned at
`0cd3e72a8c88c512666157bb452a4ba7b4213617`.

Everything below was reproduced live in the real editor; nothing here is inferred from docs.

## How to read this note

Two kinds of content live here, deliberately interleaved by section:

* **§1 Host facts** and **§2 Debugging recipes** are *normative*: they decide how the plugin is built
  and how to measure anything about it. Read these before changing code.
* **§3 Verification log**, **§5 Upstream** are *historical*: what was measured when, and what the
  vendor's issue tracker says. Read these when you need evidence, not rules.

Section numbers are **not in visual order** (§1.11, the ribbon rule, sits between §1.2 and §1.3 for
historical reasons; cross-references use the numbers, so they are not renumbered). Reading order for
a newcomer:

1. `README.md` *Code map* — the script files and the two coordinate systems.
2. **§1.7** (positions vs characters) and **§1.8** (delimiter rules) — the two facts every scanner
   change depends on.
3. **§1.1, §1.2, §1.11** — why the UI is a settings ribbon, one right-click row, and `Alt+L`.
4. **§2** — how to look at the running app instead of guessing.
5. **§3** — what has been proven live, including the row-1/row-2 repro pass (2026-09-23).
6. **§4** — test layout: which file defends which rule.

The `$...$` pairing rules are owned by one decision record,
[`docs/adr/0001-dollar-pairing.md`](adr/0001-dollar-pairing.md): the §1.8 rows, the `scan.js`
docblocks and the REPRO/CONTROL/ACCEPTED fixtures each carry a rule ID and point there, and
`tests/rules.test.js` fails the suite when any of them drifts.

## 1. Host facts that decide the design

### 1.1 Menus must not be published from `Asc.plugin.init`

`AddToolbarMenuItem` sent while the host is still booting the editor is **silently dropped**: no
error, no `.ribtab`, nothing. The only plugin with a ribbon menu that ships in this build (`AI`) waits
for both `init` **and** `onTranslate` before publishing. `code.js` therefore publishes on the first of
several readiness signals (`init`, `onTranslate`, `onThemeChanged`, `onExternalMouseUp`) plus a 1500 ms
backstop, and keeps the caption update behind a `published` flag.

Symptom when this is wrong: the ribbon tab appears only after unrelated interaction, and clicking it
does nothing.

### 1.2 Context-menu items need a *checker*, and so do their children

`ButtonContextMenu.prototype.onContextMenuShow` (v1/plugins.js) copies an item into the host menu only
when

```js
a.type === this.showOnOptionsType[h] || "All" === this.showOnOptionsType[h]
```

`showOnOptionsType` starts **empty**, so an item built without `addCheckers(...)` is skipped. Known
types (`c_oPluginContextMenuTypes`) are None / Target / Selection / OleObject / Image / Shape.

The part that cost a debugging round: the host **recurses into `childs` through the same function**,

```js
if (this.childs) for (...) this.childs[m].onContextMenuShow(a, g)
```

so a parent that passes the gate while its children carry no checker produces an entry that is visible
and whose submenu is **empty** — a click on it does nothing at all. Every item in the tree
(`menuItem()` in `buildContextMenu`) declares `"All"`, and each carries its own `attachOnClick`, since
the host only attaches a click event for items that registered one. Measured again in this phase: an
item **without** children emits no `items` at all (`n.prototype.toItem`: `this.menu && (a.items = …)`),
which the host renders as a plain, immediately clickable row — so the right-click entry is now a single
row, and the recursion above no longer applies to it.

### 1.11 A ribbon button is always a child of the root; the root is the tab

`ButtonToolbar.prototype.toToolbar` (`sdkjs-plugins/pluginBase.js`) branches on the parent:

```js
if (null === this.parent) { var d = {id: this.id, text: t(this.text), items: []}; a.tabs.push(d) }
else                      { d = this.toItem(); a.items.push(d) }
if (this.childs) for (...) this.childs[g].toToolbar(d)
```

The **root** becomes the tab and its own `toItem()` — and therefore its own `attachOnClick` — is never
emitted, so a plugin cannot make its ribbon tab an action; every button in it is a child of the root.
The shipped AI plugin has the same shape (`register.js`: `new Asc.ButtonToolbar()` + children). A child
with its own `menu` array renders with a dropdown; a child without one is a plain button, and
`separator` / `enableToggle` / `pressed` are passed through. Consequences for this plugin: the tab is a
settings surface (report entry + separator + five toggles) and the conversion has no ribbon entry — it
lives on the right-click row and the `Alt+L` chord, both of which act on the selection.

### 1.3 Hotkeys: the host event is dead, the editor's document is not

The word editor calls `g_asc_plugins.onPluginEvent2("onKeyDown", …)` only from the
`isInputHelpersPresent` branch of its key handler, i.e. while a form/content-control input helper owns
the keyboard and only for navigation keys. There is no document-level plugin shortcut, and the shipped
API has no `shortcut` field (`sdkjs-plugins/v1/plugins.js` has no key handling at all).

A `Ctrl+Alt+M` handler that relied on that event was carried here from the first version. It could
never fire, so it has been **removed** — together with `HOTKEY_KEY_CODE` and `isHotkey` — rather than
kept as advertisement. The measurement it was based on stays in this note.

What does work is §1.10: the plugin frame is a child of the editor's main frame, so it can attach a
capture-phase `keydown` listener to `parent.document` itself.

### 1.4 Install-path traps

* The enumerated directory is the **braced** one (`{5B4C1A72-…}`); `"$SYS/$G"` with a brace-less `$G`
  creates a stray that is ignored — and leaves the old copy in place, so "my fix changed nothing".
* `cp -r plugin <dest>` nests `<dest>/plugin/` instead of overwriting.
* **`cp -a plugin/. <dest>` only ever adds.** It never deletes, so a file this repo has stopped shipping
  (a retired icon, a renamed script) stays in the installed copy and the app keeps loading it. Measured
  in this phase: after the icon manifest dropped `document`/`display`, both install roots still held all
  40 PNGs and `diff -r plugin <dest>` was the only thing that showed it. **`rm -rf` the destination
  first**, or use `rsync -a --delete plugin/ <dest>/`.
* Chromium caches the plugin script; clear `data/cache/{Cache,Code Cache}` after installing.
* The launcher is `/usr/bin/desktopeditors` (or `/usr/bin/onlyoffice-desktopeditors`);
  `/opt/onlyoffice/desktopeditors/desktopeditors` is **not** a path.

### 1.5 A plugin window can only be closed through `Asc.plugin.button`

Opening a window runs `pluginMethod_ShowWindow` in sdkjs, which injects the frame id and fires
`asc_onPluginWindowShow` → `controller/Plugins.js: onPluginWindowShow` → `Common.Views.PluginDlg`
(`header: true`). That dialog's header X calls `asc_pluginButtonClick(-1, guid, frameId)`, the click is
posted **to the plugin frame**, and the host's injected router there runs:

```js
case "button":
  k = parseInt(g.button); isNaN(k) && (k = g.button);
  Asc.plugin.button || (-1 !== k) || n !== g.buttonWindowId
      ? Asc.plugin.button(k, g.buttonWindowId)   // ← throws when undefined
      : Asc.plugin.executeCommand("close", "");
```

The router's own frame id is never the window id, so the first branch is always taken: **without
`window.Asc.plugin.button` the X raises a TypeError inside the message handler and nothing closes.**
The only other window-opening plugin in this build (`AI`) defines it. Two further holes in the same
path: `variation.buttons = []` makes `PluginDlg` add class `no-footer` (no Close button at all) and
`PluginDlg` sets `enableKeyEvents: false`, so `Esc` does nothing either. Fix all three: define
`Asc.plugin.button`, pass a footer `buttons: [{ text: "Close", … }]`, and give the page itself a Close
button plus an `Esc` handler (the page must load `../v1/plugins.js`, which publishes
`Asc.plugin.windowID` from its URL, and must **not** load `scripts/code.js` or it would re-register the
menus).

Also: `onApiPluginWindowShow` early-returns when that `frameId` is already open, so reusing one
`PluginWindow` leaves a stale report on screen — close it and construct a fresh window per report.

### 1.6 `%scale%(default)` resolves without a fallback

`Common.UI.iconsStr2IconsObj` (`web-apps/apps/common/main/lib/util/utils.js`) expands the placeholder
in a config into **five** keys (100/125/150/175/200 %), and `Common.UI.getSuitableIcons` picks the key
nearest `applicationPixelRatio() * 100`. It never checks that the file exists and there is **no
fallback** to `icon.png`. On a desktop at scale 1.25 a plugin shipping only `icon.png` and `icon@2x.png`
renders a **blank** entry, with no console error. Shipped plugins carry all five scales — that is the
confirmation. Separately, a plugin's ribbon **tab** cannot have an icon in this build:
`ButtonToolbar.prototype.toToolbar` emits `{id, text, items}` for a parentless item, with no `icons`
field.

### 1.7 A paragraph range counts positions; `GetText()` returns characters plus the mark

This is the one that silently disabled detection for every document. Measured live on a three-paragraph
document (`a=∑▒n_i` from a legacy old-Format equation, an empty paragraph, and ` $$x=1$$`):

| paragraph | text | `GetEndPos - GetStartPos` | `text.length` |
| :--- | :--- | ---: | ---: |
| 0 (holds an equation) | `a=∑▒n_i\r\n` | 19 | 11 |
| 1 (empty) | `\r\n` | 3 | 2 |
| 2 | ` $$x=1$$\r\n` | 11 | 10 |

Probing position → character one offset at a time for paragraph 2:

```
23:[]  24:[ ]  25:[$]  26:[$]  27:[x]  28:[=]  29:[1]  30:[$]  31:[$]  32:[]  33:[]  34:[CRLF]  35:[]
```

So: the **content** maps 1:1 from `GetStartPos` (24-31 for the 8 content characters), then two positions
render as **empty text**, and the paragraph mark renders as a **2-character CRLF from 1 position**. The
consequences, all of which bit us:

* `end - start === text.length` is false for **every** paragraph — including prose with no math — so
  gating detection on it discards the whole document ("Scanned: 0 paragraphs"). Two of the three
  "empty" positions also mean a range that hugs a paragraph end can report more text than the content
  it covers.
* A span planned from the paragraph text at `GetStartPos + index` is nonetheless correct, because the
  1:1 content mapping holds from the paragraph start — which is why verification must be **per span**,
  not per paragraph.
* `ApiParagraph.GetText()` (the plain-text accessor) and `GetRange().GetText()` differ: the paragraph's
  own range carries the trailing mark.

### 1.8 The LaTeX converter accepts anything; the delimiter rules are the only protection

`CLaTeXParser.prototype.Parse` → `GetASTTree2` walks the token list and pushes anything it does not
consume as a literal character:

```js
arrExp.push({ type: Struc.char, value: oData.data, style: oStyle })
```

and `ApiDocument.AddMathEquation` inserts the math element *before* converting (`AddToParagraph(mathPr)`
then `ConvertView(false, mathformat, text)`) and then returns `true` unconditionally — its `false` path
is only `if (!paraMath)`. An expression the converter cannot handle is therefore **not** rejected, and
the plugin has already deleted the source text by then: prose becomes garbage math with no error and no
rollback. This is why `$...$` stays single-line and currency-guarded, and why the "cannot start math"
character list exists at all.

Guard decisions taken while auditing the four delimiter branches (each one is a test now):

| Rule | Decision |
| :--- | :--- |
| A closer preceded by whitespace | **abandons the opener** (`findDollarClose` → `-1`), it does not "keep looking". Keeping looking would turn `Costs $5 and $6 plus $x$ here.` into math spanning from the first `$` to the last — measured. A later, valid span on the same line is still found, because the outer loop re-examines each `$`. |
| A blank line inside `$$…$$` / `\[…\]` | **rejected**, which is what the README always claimed. The scanner sees one paragraph at a time, so a delimiter separated from its partner by an empty line was never closed. A single soft break stays legal (`"$$\na + b\n$$"`). |
| `\(…\)` across a line | **rejected**: `\(…\)` is inline by definition, so it is single-line like `$...$`. Its previous `allowNewline: true` was the odd one out. |
| An empty body | **reported** on all four delimiters. Only the `$$` branch warned, so `\(\)` and `\[\]` were silent no-ops; the inline branch's empty case is reachable too (`$$x$` with the display delimiter switched off). |
| An opener followed by whitespace or by punctuation | **not a span** (`CANNOT_START_MATH` = `)]},.;:?!%'"`, plus the whitespace rule). Pinned by fixtures for both, with the deliberate counter-example `Note($i$)` — an *opening* bracket after the opener is still math. |
| An opener with **no rule about the character before it** | **accepted**, deliberately. `x$y$z` and `f(x)$=y$` are read as math. A preceding-character rule would also reject `text=$x$`, which an author plausibly writes; the guard is not extended without a demonstrated failure. Pinned as a fixture so a later change has to face the decision. |
| A closer a guard refused | reported as `guarded-inline-dollar`, **not** `unterminated-inline-dollar`, and the loop steps past the refused `$` so it is not re-read as an opener. Before: a page of prices produced one bogus "unterminated" per `$` and the report's *Malformed delimiters* line was noise. Genuinely unmatched openers (`Pay $100 now.`) still report as malformed. |
| A candidate closer that is **itself an opener** (`closerIsAlsoAnOpener`) | **Refuses the closer and abandons the *earlier* opener**, warning `guarded-inline-dollar` and advancing by one so the outer loop re-reads the candidate as the opener it is — conditions `DP-closer-0`, `DP-closer-a`, `DP-closer-b`, `DP-closer-w`, `DP-closer-c`; rejected alternatives `DP-closer-b/rej-digit-opened`, `DP-closer-w/rej-spaceless-body`. Rationale, counter-examples and dated ablations: [`docs/adr/0001-dollar-pairing.md`](adr/0001-dollar-pairing.md). |
| A **refused** `$` that is a legitimate opener (`refusedDollarIsAnOpener`) | **Re-reads the refused `$` as an opener** instead of stepping past it, so `cost $5, that will be $x+5$` converts `$x+5$` while `$10-$20` keeps one guarded warning and no phantom — conditions `DP-refused-currency`, `DP-refused-canStart`, `DP-refused-nested`; accepted loss `DP-refused-currency/loss-1`. Rationale, counter-examples and dated ablations: [`docs/adr/0001-dollar-pairing.md`](adr/0001-dollar-pairing.md). |

`aligned` was removed from the read command in the same pass: it was a per-paragraph comparison nothing
read, and keeping a field that *looks* like a gate is how §1.7 happened.

### 1.9 A plugin window's page cannot decide anything at `DOMContentLoaded`

`report.html` loads `../v1/plugins.js`, which does **not** set `Asc.plugin.windowID` synchronously: it
posts an XHR and calls its internal `q()` — the function that reads `windowID` out of the page's URL —
from the response callback (`c.onload`, with an `onerror` fallback). At `DOMContentLoaded` the page
therefore has no `Asc.plugin`. Deciding the Close button there hid it for real users, while `Esc`
continued to work because it re-resolves the API when the key is pressed. Two lessons: read the id from
the URL directly when an early answer is needed, and never let a load-order race decide whether a
control exists.

### 1.10 A chord arrives with its modifiers stripped — the editor types the letter

Measured 2026-09-20 against 9.4.0.130-1 with **real** keystrokes (`xdotool` at the X11/XWayland level,
window focused) and a capture-phase listener on the editor's document, installed from the plugin frame
(`window.parent.document`, which is same-origin and therefore reachable — that is the §1.3 workaround).

`Alt` + `L`:

| # | `key` | `code` | `keyCode` | `altKey` | `ctrlKey` | `modState('Alt')` | `target` |
| -: | :--- | :--- | ---: | :--- | :--- | :--- | :--- |
| 1 | `Alt` | `AltLeft` | 18 | `true` | `false` | `true` | TEXTAREA |
| 2 | `l` | `KeyL` | 76 | **`false`** | `false` | `false` | TEXTAREA |
| 3 | (keyup) `l` | | 76 | `false` | `false` | | |
| 4 | (keyup) `Alt` | | 18 | `false` | `false` | | |

`Ctrl` + `Alt` + `M`:

| # | `key` | `code` | `keyCode` | `altKey` | `ctrlKey` |
| -: | :--- | :--- | ---: | :--- | :--- |
| 1 | `Control` | `ControlLeft` | 17 | `false` | `true` |
| 2 | `Alt` | `AltLeft` | 18 | `true` | `false` |
| 3 | `m` | `KeyM` | 77 | **`false`** | **`false`** |

The bound key therefore carries **no trace** of the chord in these measurements: Chromium on Linux is
the likely consumer of the modifiers (its access-key pass), and the SDK's keyboard sink types the
letter — three `Alt+L` presses left `"We are the lll"` in a scratch document, and one `Ctrl+Alt+M` left
`"…m"`. Whether a **physical** chord behaves the same is untested: injection is the only input path
available when driving the app from a terminal. The plugin accepts both shapes (see below), so the
answer only affects the caveat, not the behaviour.

Consequences, all of them load-bearing:

* a chord can only be recognised from the **modifier keydowns that precede** the bound key as well as
  from the key's own flags; the modifier set must match the binding **exactly**, which is what keeps a
  plain `l` and an ordinary `Ctrl+L` out of the branch;
* the claimed key must be **swallowed** (`stopPropagation` + `preventDefault` in the capture phase on
  `document`, before the event can reach the `TEXTAREA`), or every conversion leaves a stray letter;
* `event.altKey`/`ctrlKey` are still consulted first, so a host that *does* report them (a browser
  build) keeps working — the plugin accepts both shapes;
* if the modifier keydown is ever not delivered, the chord simply never fires. That is the safe
  direction: it cannot fire on a plain keystroke.

The matcher in `plugin/scripts/code.js` implements exactly this and is tested in
`tests/hotkey.test.js`; do not "simplify" it to a `keyCode === 76` or `event.altKey` test.

## 2. Debugging recipes (all used here)

Attach to the running app with `--remote-debugging-port=9222 --remote-allow-origins=*` and talk to it
from Node over the CDP websocket. Frame contexts:

| Context | Frame |
| :--- | :--- |
| 1 | `apps/api/documents/index.html` (host API page) |
| 2 | `apps/documenteditor/main/index.html` (editor shell) |
| 4 | our plugin (`sdkjs-plugins/%7B5B4C1A72…%7D/index.html`) |

* **Is the installed script the one running?** `Debugger.getScriptSource` on the plugin frame and
  compare the byte count / a marker (`addCheckers`). This is how a stale 19825 B copy was caught while
  the repo file was 20488 B.
* **Did a click reach the plugin?** Wrap `Asc.plugin._onCustomMenuClick` and
  `Asc.plugin.event_onContextMenuClick` in the plugin frame; then drive the host dispatch directly
  from the editor frame, which is exactly what the menu does:

  ```js
  window.editor.onPluginContextMenuItemClick('asc.{5B4C1A72-…}', '<item id>')
  ```

* **What does the host receive?** The composition entry point is `Asc.plugin._events.onContextMenuShow`
  (`attachEvent("onContextMenuShow", …)` in `registerContextMenu`). Calling it with a fake
  `{ type: 1 }` payload and inspecting the resulting `AddContextMenuItem` argument shows the real
  submenu tree — `{"t":"LaTeX math","n":2}` means two children made it through the gate.
* **Creating a selection from outside** for selection-scoped tests: run Builder code in the editor
  realm through the plugin, `Asc.plugin.callCommand(function(){ Api.GetDocument().GetAllParagraphs()[0]
  .GetRange(0, n).Select(); }, …)`. `Api` does not exist in the editor page global scope — only inside
  a `callCommand` body.
* `Ctrl` cannot be delivered with `xdotool` in this XWayland setup; call the API the toolbar button
  calls instead (`window.editor.Undo()` for undo).
  **Amended 2026-09-20:** the modifiers *are* delivered — what was missing was window focus.
  `xdotool windowactivate` fails here (`XGetWindowProperty[_NET_ACTIVE_WINDOW] failed`, niri does not
  provide EWMH activation), but `xdotool windowfocus --sync <id>` works, and afterwards
  `xdotool key ctrl+alt+m` arrived as a real `Control`↓ `Alt`↓ `m`↓ sequence (§1.10). Do not conclude
  from `windowactivate` failing that input cannot be injected.
* **Watching what the editor's keyboard actually receives** — install a logging listener in the editor's
  document *from the plugin frame*, which is the only frame that can reach it:

  ```js
  (function () {
    var d = window.parent.document;
    window.__keylog = [];
    d.addEventListener("keydown", function (e) {
      window.__keylog.push({
        key: e.key, code: e.code, kc: e.keyCode,
        alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey,
        loc: e.location, repeat: e.repeat,
        modAlt: e.getModifierState && e.getModifierState("Alt"),
        modGr: e.getModifierState && e.getModifierState("AltGraph"),
        tgt: e.target && e.target.tagName
      });
    }, true);
    d.addEventListener("keyup", function (e) { window.__keylog.push({ up: e.key, kc: e.keyCode }); }, true);
    return d.title;
  })()
  ```

  Then inject a real keystroke (`xdotool windowfocus --sync <id>; xdotool key alt+l`) and read
  `JSON.stringify(window.__keylog)` back over CDP. This is how §1.10 was measured. Note the log survives
  only until the app restarts, so clear it (`window.__keylog = []`) between runs.
* **Cleaning up after a keystroke probe**: the probes type real letters into the document. Read the
  paragraph text through `callCommand` (§1.7 recipe), then `xdotool key BackSpace` once per stray
  character and re-read to confirm rather than assuming.
* **Reading positions and text out of a live document** (this is how §1.7 was measured) — run it
  through the plugin's own `callCommand`, since `Api` is only in scope there:

  ```js
  Asc.plugin.callCommand(function () {
    var out = [];
    Api.GetDocument().GetAllParagraphs().forEach(function (p) {
      var r = p.GetRange();
      out.push({ start: r.GetStartPos(), end: r.GetEndPos(), text: r.GetText() });
    });
    return JSON.stringify(out);
  }, false, false, function (v) { window.__last = v; });
  ```

  Then probe one offset at a time with `doc.GetRange(k, k + 1).GetText()` to see which positions carry
  characters, which are empty and which hold the mark.
* **Did a menu change actually reach the host?** Ask the host, not the plugin: call the composition
  entry points and inspect their argument — `Asc.plugin._events.onContextMenuShow({type: 1})` for the
  right-click tree (an item with **no** `items` key is a plain row; a `{"t":"LaTeX math","n":N}` root
  means N children passed the checker gate) and `_events.onToolbarMenu`/`AddToolbarMenuItem` for the
  ribbon, where `items` is the flat list of the tab. The harness mirrors both
  (`composeContextMenu`/`composeToolbar`), but only the live host proves the wiring.
* **Icon set drift**: `python3 tools/make-icons.py` regenerates *and* prunes — it deletes anything under
  `plugin/resources/` that the manifest no longer owns, because `--check` iterates the manifest and can
  therefore never see a retired slot's leftovers (40 of them, after the ribbon was reduced to settings).

* **Driving the app from a script.** Helpers live next to each other (`cdp.mjs`, `sh.mjs <ctx>
  <expr>`, `ctx.mjs`, `dbg.mjs`) and talk to `http://127.0.0.1:9222`. `cdp.mjs` resolves the **page
  target**, enables `Runtime`, and evaluates with an explicit `contextId` — because the editor shell and
  the plugin are **iframes of one target**, not targets of their own, so `/json` alone shows only the
  host page and a waiting loader and looks like "no editor frame". `ctx.mjs` dumps
  `Runtime.executionContextCreated` after `Runtime.enable` (existing contexts are replayed), which is
  how the host / editor shell / plugin / shipped-AI contexts are identified each time. **Context ids are not stable across boots** — one boot gave 1/2/4/5, the next gave 1/3 — so never hard-code them: enumerate, then match on `origin` (`file://` for the host and shell, `onlyoffice://plugin` for the shipped AI plugin) and on the frame id, and confirm the plugin frame by evaluating something only our frame has, such as `window.OnlyOfficeLatexMathApi`.
  `dbg.mjs` enables `Debugger`, finds the `scan.js` `scriptId`, and reads `Debugger.getScriptSource` —
  the only reliable way to prove the *running* script is the one just installed.
  Launch in a subshell or the harness kills the GUI when the call returns, and **pass
  `--remote-debugging-port=9222 --remote-allow-origins=*` on the first launch**: a later
  `desktopeditors <file>` forwards the file, but a first launch *without* the flags starts a second
  process with no CDP at all.
* **`callCommand` must be serialized.** Two invocations in flight at once answer
  `unparsable-command-result` or `no response from editor` (the plugin routes one settle callback), so
  select-then-convert is two round trips with a gap, never `Promise.all`.

## 3. Verification log (live, GUI)

Everything below was measured against a live build. Rows marked **(5)** are from the phase that made
the selection the only unit of conversion, the right-click entry a single row and the ribbon a settings
tab.

| Check | Result |
| :--- | :--- |
| **(5)** Warnings are bucketed | *Malformed delimiters* (a real typo to fix) and *Left as text by a guard* (the guard working) are separate report lines. Before: `Cost $5, save $2, math $x$ here.` produced two `unterminated-inline-dollar` warnings and the report told the author their LaTeX was broken |
| **(5)** A lone unmatched `$` | `Pay $100 now.` still reports `Malformed delimiters: {"unterminated-inline-dollar":1}` — the bucketing must not hide a genuine typo |
| **(5)** Right-click tree **as the host composes it** | `Asc.plugin._events.onContextMenuShow({type:1})` → `AddContextMenuItem` with **one** item, `{"id":…,"text":"LaTeX math","lockInViewMode":true,"disabled":false,"icons":…}`. There is **no `items` key**, i.e. a plain clickable row, not a submenu — and it still passes the checker gate |
| **(5)** Ribbon tab **as the host composes it** | `AddToolbarMenuItem` → one tab, `items` = `Show last report`, `✓ $...$` (with `separator`), `✓ $$...$$`, `✓ \(...\)`, `✓ \[...\]`, `✗ Report window`. No conversion entry exists; the tab is the root, so it cannot carry one anyway (§1.11) |
| **(5)** Icons actually rendered in the ribbon DOM | six, all at `…/big/*@1.25x.png` (the active display scale): `report`, `inline-dollar`, `display-dollar`, `inline-paren`, `display-bracket`, `report-off`. No `document`/`display` reference survives |
| **(5)** The single conversion on a two-paragraph fixture | `Scanned: 2 paragraphs, 3 LaTeX spans found (1 display)` → `Converted: 3 / 3`, `Display math requested: 1, display mode applied via: logic-document`, `Delimiters still present: 0` |
| **(5)** `Ctrl+S` on that run, OOXML inspected | 3 `<m:oMath>` (x=1, y=2, a), 2 `<m:oMathPara>` (the display pair), text runs `Inline ` / ` and display` / `here.` / `A ` / ` B and keep $10 and $20.` — the **only two `$` left in the whole file are the currency pair**, so the guard held through the save. No stray chord letter |
| Ribbon tab `LaTeX math` at cold start, no interaction | present; items render |
| *Convert document* on a 13-`$` fixture (entry now retired) | `Converted: 4 / 4`; `$10`, `$20`, `\$5` untouched |
| Display equation via `$$…$$` | `m:oMathPara` in the saved OOXML |
| One undo after a run | all four source paragraphs restored verbatim |
| Save (`Ctrl+S`) and inspect the `.docx` | 6 `<m:oMath`, 2 `<m:oMathPara`, exactly 3 `$` left (currency + escape) |
| Reopen the saved file | equations load as native, editable math |
| Paragraph icons at scale 1.25 (5 scales shipped) | entry, ribbon row and menu all render; the tab itself cannot have one (§1.6) |
| Report window close affordances | header X, footer *Close* and `Esc` each close it; a second report is a fresh window with current numbers |
| Reports silent by default | conversion opens no window (`openReport=false`); *Show last report* opens one on demand |
| **Reported bug**: `$$x=1$$` not detected | before: `Scanned: 0 paragraphs` / `Skipped paragraphs whose text offsets cannot be mapped: 3` / `Nothing to convert.` — after: `Scanned: 3 paragraphs, 1 LaTeX spans found (1 display)`, `Converted: 1 / 1` |
| The same document's paragraph offsets, read live | every paragraph's range span is **shorter than its own text** (the mark is two characters in `text`, one position in the range) — the comparison the old gate relied on is false here for all three, which is why it is no longer computed |
| Legacy equation (`a=∑▒n_i`) beside the conversion | its OMML byte-identical; the paragraph only gains `highlight none` on an empty run, from the editor's own save |
| `Ctrl+S` after the fix | one `m:oMathPara` for the converted span, no `$` left in the file |
| One undo after the fixed run | ` $$x=1$$` restored verbatim |
| The report page's own *Close* button | was **hidden** in the real host (SDK publishes `windowID` from an XHR callback, later than `DOMContentLoaded`); now visible and closing |
| Hotkey attach, cold start | plugin console: `Alt+L attached to 2 document(s)`; `getHotkeyStatus()` → `{attached: 2, blocked: 0, chords: ["Alt+L"]}`; the marker `onlyOfficeLatexMathHotkey` is present on the editor document |
| **`Alt+L` for real** (`xdotool`, selection = a paragraph holding `A $x=1$ B`) | report: *Convert selection*, `Scanned: 3 paragraphs, 1 LaTeX spans found (0 display)`, `Converted: 1 / 1`, `Delimiters still present: 0`. Saved OOXML: `A ` + `m:oMath(x=1)` + ` B` — the math is where the source was, **both neighbouring spaces survive**, and there is **no stray `l`** anywhere |
| `Alt+L` on a **display** span (` $$x=1$$`, the owner's original repro, live) | paragraph became `m:oMathPara`; the saved file has no `$` left. See the open item below |
| Plain `l` and `Ctrl+L`, injected with the real chord's own method | the letter is **typed into the document** (not claimed, not swallowed) and nothing is converted — the guard behaves as designed |
| Silent reports during a hotkey run | `Asc.plugin._windows` is empty; `settings.openReport` stays `false`, so the chord opens nothing |
| Injected `Ctrl`/`Alt` chords (the caveat) | `xdotool key ctrl+alt+m` and `key alt+l` both lose their modifiers *for the letter event* (§1.10), which is why the live negative control for `Ctrl+L` cannot distinguish "modifier arrived and was ignored" from "modifier was never delivered". The exact-modifier-set rule is asserted in `tests/hotkey.test.js` instead |

### (6) Live pass — 2026-09-23, closing the `895ef72` gap

App launched with `--remote-debugging-port=9222 --remote-allow-origins=*`; contexts **1** host,
**2** editor shell, **4** plugin (§2). Fixture `phase8-fixture.docx`, four paragraphs built from
scratch (no `.docx` existed in the repo), opened via `desktopeditors <file>` **after** the instance
with the debug port was already up — a first attempt with only the file argument silently started a
second instance with no CDP, which showed as "no editor frame" until the contexts were enumerated
properly. **Never drive `callCommand` concurrently**: two parallel invocations produced
`unparsable-command-result` and `no response from editor`; sequential + 500 ms works.

| Check | Observed |
| :--- | :--- |
| The running script is the fixed build | `Debugger.getScriptSource` on the plugin frame → marker **`refusedDollarIsAnOpener` PRESENT**; installed file **md5 `66760f31733332000ed3c92308eb8e2e`, 21899 B** — byte-identical to the repo. CDP reported **21893 B** for the same file: a 6-byte engine artifact, so a raw byte count is a *discriminator* (a stale copy once differed by 663 B) but not an identity check — compare hashes |
| **REPRO** `cost $5, that will be $x+5$`, selected and converted | `Converted: 1 / 1`, `Delimiters still present: 0`, `Undo point created: yes`. Saved OOXML: `cost $5, ` + `<m:oMath>x+5</m:oMath>`; literal `$x+5$` **gone**, the price `$5` intact. **This is the defect phase 8 exists for — it converted nothing before** |
| **The hole** `cost $5, then $10 and 20$ here`, selected and converted | `0 LaTeX spans found`, `Nothing to convert`, `Left as text by a guard: {"guarded-inline-dollar":1}`. Saved text byte-identical with all three `$` — no equation out of two prices |
| **Invariant** `It costs 5$ and 6$ later.`, selected and converted | `0 LaTeX spans found`, no span, no phantom — saved text intact. **No guard warning of its own**: its `$` are never openers (they follow a digit and precede `.`), so the `guarded:1` visible in this report belongs to row 1, not to this paragraph |
| **Rejected alternative** `Compare $5$ vs $6$.`, selected and converted | `Converted: 2 / 2`; `<m:oMath>5</m:oMath>` and `<m:oMath>6</m:oMath>`, literals `$5$`/`$6$` gone |
| Saved OOXML totals (`DesktopOfflineAppDocumentStartSave(false)` in ctx **2**) | **3 `<m:oMath>`, 0 `<m:oMathPara>`** (all four inputs inline), file 1719 → **25480 B**, **no stray chord letter** |
| §8 pass criteria | `node --test tests/` → **127** at the time of the pass, **128** after the review fix below; `diff -r plugin <dest>` **clean on both roots**, verified immediately after install |

**Consequence observed while doing this, not a regression:** once row 1's `$x+5$` is converted, its
neighbouring price `$5` is left with no partner, so the *next* scan reports
`Malformed delimiters: {"unterminated-inline-dollar":1}` for an ordinary price. That matches the
recorded decision that a genuinely unmatched `$` still reports as malformed — but the author now sees
their own price called malformed *as a result of a successful conversion*. Report-only; no conversion is
affected. Flagged for the reviewer rather than changed here.

**The standing `895ef72` live-verification gap is now closed**: the scanner's user-visible behaviour has
been confirmed against a real document in the real editor, not only by unit tests.

**Open item, not caused by this phase** (recorded 2026-09-20): converting the live ` $$x=1$$` paragraph
above produced a saved file whose leading space is gone. Before: one run,
`<w:t xml:space="preserve"> $$x=1$$</w:t>` (a leading space inside the text). After: an **empty** run,
`<m:oMathPara>` (x=1), three empty runs. In the inline case
(previous row) both spaces survived, so the suspicion is the display path or the save serializer rather
than the span offsets — but `plugin/scripts/{scan,commands}.js` are **untouched** by the hotkey work
(`git diff --name-only`), so this is pre-existing and was not investigated further. Worth a dedicated
look: a conversion must not consume neighbouring characters.

### Live pass — 2026-09-23, the two repro rows

Fresh boot with `--remote-debugging-port=9222 --remote-allow-origins=*`, renderer cache cleared, both
roots reinstalled `rm -rf` + `cp -a` (`diff -r` clean). `Debugger.getScriptSource` md5 = repo for
`scan.js`, `code.js` and `commands.js`, so the frame runs the installed fix. Fixture `repro.docx`:
`$x$y$` / equation-object `x` + literal `$y$` / `control $a$`.

| Check | Observed |
| :--- | :--- |
| **Row 2, build before the fix** | `Converted: 0 / 1`, `Skipped (text-mismatch): 1`, `  - text-mismatch @10 expected="$y$"` — APPLY_BODY refused the span because `planReplacements` mixed the paragraph's position start with char offsets (the equation costs 3 positions for the 1 character it renders, so the real `$y$` sits at 12..15) |
| **Row 2, after** | `Converted: 1 / 1`, no skip line, paragraph text `x y`: the equation object was kept and the literal `$y$` became equation `y` |
| **Row 1, after** | `Converted: 1 / 1`, paragraph text `xy$` — oMath(`x`) plus the orphan `y$` still visible, i.e. **pair x**. The row's literal "single math-italic xy" symptom was never reproduced on this build and stays **unproven** (stale build when the spec was written) |
| Control paragraph | untouched, `control $a$` still literal |
| Suite | `node --test tests/` → **132**; red-first was captured by stashing just the source fix (3 repro fixtures + the updated collect pin fail on the old code) |

## 4. Test layout

`node --test tests/` runs the whole directory: the delimiter core plus the fixtures added red-first
for the two repro rows and the keystroke property, the harness mirrors, and the rule map. Dated
counts live only in [`docs/adr/0001-dollar-pairing.md`](adr/0001-dollar-pairing.md)'s Evidence
section; `tests/rules.test.js` keeps live counts out of this file and the README.

* `scan.test.js` — the delimiter core: escapes, currency guard, `$$` precedence, unterminated spans,
  the blank-line rule, the guard decisions (a whitespace-preceded closer abandons its opener without
  poisoning the line; a currency run cannot drag a later real span into math; and a candidate closer
  that is itself an opener abandons the *earlier* one instead of stealing its `$` — with `$a$and$b$`
  as the parity counter-example — and a *refused* `$` that turns out to be a real expression's opener
  (`cost $5, that will be $x+5$`, with the mixed-convention and phantom-`unterminated` controls),
  offset planning, and the
  paragraph-offset filter (a paragraph whose length comparison fails must still be scanned; only an
  unreadable one is set aside).
* `plugin-harness.js` — a fake browser window plus a fake editor; it mirrors the host's *gates*, not
  just the API surface: `callCommand` stays silent while the editor is "booting", `addCheckers`
  records checkers, `composeContextMenu(type)` reproduces `onContextMenuShow` including the recursion
  into children, and `composeToolbar()` reproduces `toToolbar` (the root becomes the tab). Both
  projections mirror the shipped `toItem`, which emits `items` **only** for a node with children — the
  property that makes a single-row right-click entry and a flat ribbon tab possible at all. It also
  models the frame chain (`parent.document` with capture-phase listener recording) and
  `parentAccessThrows`, and `pressAltChord` replays the real two-event sequence of §1.10.
* `hotkey.test.js` — the chord: the matcher's rules (exact modifier set, repeat, `AltGr`, staleness,
  keyup, intervening key) and the host-level behaviour (a plain `l`/`m` and `Ctrl+L` are never claimed,
  one chord converts once, collapsed selection converts nothing, `Ctrl+A` then the chord converts the
  document, the silent-report setting is respected, the listener attaches once per document, and a
  blocking host degrades instead of throwing).
* `fake-editor.js` — models the measured read shape of §1.7: a paragraph's **own** range carries its
  trailing `\r\n` while a sub-range ending at the same offset does not, so a range span never equals the
  text length, exactly as on the host. A harness too kind here is what let the old gate ship.
* `integration.test.js` — publication timing, backstop, caption refresh, the one conversion (over a
  selection, or a `selectAll()` helper that stands in for `Ctrl+A`), the owner-reported document
  (`a=∑▒n_i` + empty paragraph + ` $$x=1$$`), spans refused per offset drift, the single-row
  right-click entry, the settings-only ribbon, the report window's close affordances and the
  silenced-by-default report.
* `icons.test.js` / `png.js` — every icon slot exists at all five scales as a valid, non-blank PNG
  (a minimal PNG decoder, so the check is host-independent).
* `rules.test.js` — the dollar-pairing drift check: every `DP-*` token in code and docs exists in
  the [`docs/adr/0001-dollar-pairing.md`](adr/0001-dollar-pairing.md) manifest, every manifest ID has
  a `// rule:`-annotated fixture in `scan.test.js`, and neither the README nor this file states a
  numeric test count.
* `report.test.js` — the report record's URL seam, driven by producer bytes (the recorded window
  URL of a real conversion run through the harness): the payload survives the host's URL mangling
  and corrupted input, `encode`/`decode` round-trip, and both pages load `report-record.js` before
  the script that consumes it.

## 5. Upstream: the same gap, and where it is tracked

Math input is confined to the **equation container** upstream, and that is a product decision rather
than a missing call: `Insert ▸ Equation` (or `Alt+=`) comes first, and only inside the placeholder do
Math AutoCorrect and `LaTeX` + `Linear` → `Professional` apply. Cite these instead of re-deriving them
(all fetched 2026-09-21):

| Source | Quote |
| :--- | :--- |
| Help Center, [*Insert equation*](https://helpcenter.onlyoffice.com/docs/userguides/document_editor/InsertEquation.aspx) | "**Note**: currently, equations cannot be entered using the linear format, i.e., `\sqrt(4&x^3)`." |
| Help Center, [*AutoCorrect features*](https://helpcenter.onlyoffice.com/docs/userguides/document_editor/MathAutoCorrect.aspx) | "**Math AutoCorrect**: *When working with equations*, you can insert a lot of symbols, accents, and mathematical operation signs typing them on the keyboard … then press Spacebar." |
| Community forum, staff, 2025-11-20 | "Math AutoCorrect options are only available when working with equations (Insert > Equation). **It is not supposed to change anything in main content of the document.**" |
| Community forum, staff, 2025-07-09 | "Math AutoCorrect only works within equations. **Outside of it (just as text) it will not work.**" |

No upstream item asked for the body-text case, so one was filed:

* **`ONLYOFFICE/DocumentServer#3809`** — *Auto-convert LaTeX in document text (`$...$`, `$$...$$`) into
  math equations*, filed 2026-09-21 as a `feature_request.yml` issue. It asks for on-demand conversion of
  the **selection** (whole document = `Ctrl+A` first) plus an optional, off-by-default as-you-type
  trigger, names the currency guard, and cites this repo as the working reference implementation.
* Cross-linked from **`ONLYOFFICE/DesktopEditors#2062`** (`issuecomment-5754084806`) — the open macOS
  LaTeX bug whose reporter asked for inline `$...$` twice; the comment marks the scope boundary.

The corpus, so nobody re-treads it:

| Item | State | Scope | Same as body-text conversion? |
| :--- | :--- | :--- | :--- |
| `DocumentServer#2717` *LaTeХ formatig* | open, `feature request`, updated 2026-05-20 | A shortcut (`alt+enter`) to format *the current equation*, instead of Equation Settings. Vendor logged it (internal 67781). | no — in-equation |
| `DocumentServer#3250` auto-format latex equation writing | closed **duplicate of #2717** | `Enter` should convert linear→professional. | no |
| `DesktopEditors#2096` shortcut for plain-text ↔ display | closed **duplicate of #2717** | A key for the same Equation Settings switch. | no |
| `DesktopEditors#2062` LaTeX input on macOS | open, reopened, last activity 2026-08-11 | A macOS render bug. Contains two asides: "Optional: support for inline LaTeX ( `$...$` ) inside text, not only inside equation blocks" and "if is possible to select latex code and click Insert-math formula and there is automatically conversion into math formula in editor". | partial, never triaged as a feature |
| `DocumentServer#2507` (comment, 2023-12-10) | open, `feature request` | "automatically convert the detection of LaTex syntax or unicodeMath syntax strings **in the entire text** into professional mathematical formulas with just one click". Staff: "please create a separate problem for your issue" — it was never filed (`author:ywcprogramer` → 0 issues). | **the same request, never filed** |
| `DocumentServer#1709`, `#1623` | closed *completed* / *fixed* | LaTeX and linear input *inside* the equation editor; delivered in 8.0.1. | no |
| `DocumentServer#3678` *LaTeX conversion* | open, `confirmed-bug` | linear↔professional round-trip bug in Presentations. | no |
| `DocumentServer#2473`, `#2944`, `#2176`, `#1268`, `#1259`, `#3732`, `#3776`, `#3661`, `#3445`, `#1996`, `#2228`, `#2380`, `#969`; `DesktopEditors#99`, `#874`, `#361`, `#1960` | open/closed | Symbols, layout, numbering, shortcuts — all inside the equation editor. `#1960` is the adjacent *sentiment* (a user wanted `->` → `→` in body text; told it is equations-only). | no |
| `DesktopEditors#2042`, `DocumentServer#2104` | open / closed | The MathType *plugin*, and MathType files. | no |
| DocumentServer **Discussions** (all 76 enumerated) | — | Deployment Q&A only; `search type:DISCUSSION` for latex/math/mathml/omml → 0. | no |
| `onlyoffice.github.io`, `web-apps`, `sdkjs`, `office-js-api`, `DocSpace`, `desktop-sdk` issue search | — | No body-conversion request. | no |
| Community forum (19 `latex` hits, incl. `#4429` 3965 views, `#3641`, `#20798`, `#13060`, `#8711`) | — | Typesetting bugs, mode confusion, "Text AutoCorrect like Math AutoCorrect", Markdown headings. | no |

Precedent that makes the ask credible, and the two things to reuse if it ever lands:

* The vendor's own macro post — [*Use an ONLYOFFICE macro to convert selected text into a LaTeX
  equation*](https://community.onlyoffice.com/t/use-an-onlyoffice-macro-to-convert-selected-text-into-a-latex-equation/11333)
  (2024-10-31) — is the selection-only case of exactly this, via `GetRangeBySelect()` +
  `AddMathEquation(text, "latex")`. It is ONLYOFFICE documenting our primitive and stopping one step
  short.
* The marketplace already accepts *in-flight* work of this shape: `mathpix` (calls `AddMathEquation`),
  and `lizardtypst` ("real-time Typst rendering", merged 2026-04-18, "inspired by Iguana LaTeX").

Re-running the check (the forum **moved to `community.onlyoffice.com`** — `forum.onlyoffice.com` 301s):

```bash
gh search issues --owner ONLYOFFICE --limit 25 '<term>'      # issues, all forks/repos
gh api "search/issues?q=org:ONLYOFFICE+<term>+in:body"       # body text, not just titles
gh api graphql -f query='{ search(query:"repo:ONLYOFFICE/DocumentServer <term>", type: DISCUSSION, first:20) { discussionCount } }'
curl -sSL 'https://community.onlyoffice.com/search.json?q=<term>'    # -L matters: 301
```

**Consequences for this repo.** (a) Nothing here should be filed on `#2717` — that is the *in-equation*
umbrella. (b) If `#3809` is implemented, the plugin's remaining value is only builds older than the
release that ships it, so re-check before adding features. (c) Anyone arguing that the behaviour
"should already work" is answered by the quote table above, not by the user guide alone.

## 6. Architecture review — 2026-09-25 (maintainability pass)

A `/improve-codebase-architecture` walk of the work through `84bbda8`, aimed at making the project
easy to pick up for later maintainers. The visual report with before/after diagrams is written to
the OS temp dir per the skill (nothing lands in the repo); the durable output is this table.
Vocabulary is the `codebase-design` one: **module**, **interface**, **depth**, **seam**, **leak**.

| # | Candidate | Strength | Where the friction is |
| :- | :--- | :--- | :--- |
| 1 | One owner for "where is this span in the document" | **Strong** | The char-offset ↔ position mapping is implemented in five mutually-referential places (scan.js `positionOf`, code.js `RESOLVE_BODY`, commands.js guard, fake-editor geometry, README + §1.7). The pure scanner documents the glue's data format. The row-2 drift bug lived exactly here and passed every scan test. **Landed 2026-09-25**: `plugin/scripts/locate.js` owns the mapping (its header is the vocabulary), `scan.js` is pure character domain, the probe lives in `commands.js` behind `locate.plan`'s `resolve` seam, and `tests/locate.test.js` pins the seam (fallback, partial proof, map invariants, placement labels). |
| 2 | Split `code.js` at its own section banners | **Landed 2026-09-26** | The fused concerns got owners: `hotkeys.js` (the pure matcher + tables), `report-text.js` (all report wording — "a guard is not malformed" is wording policy and lives with the words), `settings.js` (the stored record and the derived scanner options, including the stale-record `openReport` rule). `convertSelection` is now the pipeline `read → decide → plan → apply → verify → render` — stages only sequence, policy is the pure `decide(snapshot, settings)`, `verify` is a named stage — and code.js keeps what the review refused to split: menus, lifecycle, report windows, the composition root. |
| 3 | One owner for "run this in the editor page" | **Landed 2026-09-25** | The seam was split: `RESOLVE_BODY` orphaned in code.js while its siblings lived in commands.js, the string-body seam compiling against a `PRELUDE` the bodies cannot see, the harness running commands *synchronously* so the real timeout/clobber/unparsable behaviour was untested. `plugin/scripts/commands.js` now owns the whole seam — the bodies plus `run(name, payload)` — dispatching one `callCommand` at a time over the shared `Asc.scope` slot (a queued run behind a hung one waits out its timeout instead of fail-fast supersede displacing its answer) and answering the error taxonomy `timeout`/`unparsable-command-result`/`clobbered`/`callCommand-unavailable`/`callCommand-threw`. The harness answers asynchronously (`commandDelay`/`commandNeverAnswers`/`commandRaw`/`commandOverlaps`), so those paths are pinned. (First step landed 2026-09-25 with candidate 1: `RESOLVE_BODY` moved next to its siblings.) |
| 4 | One decision record for the dollar-pairing rules | **Strong** (docs only) | The five + three conditions are prose in four places and kept in sync by hand; the ablation counts restated in §1.8 go stale whenever the suite moves. Rule IDs in code + a fixture↔rule map would make drift mechanical to catch. |
| 5 | Doubles declare which host contracts they mirror | Speculative | `plugin-harness.js` / `fake-editor.js` mix measured host behaviour with conveniences (the asynchronous `callCommand` mirrors the seam's shape but its knobs — delay, never-answers, raw answers, overlap hooks — are conveniences); a host upgrade leaves every test green. |
| 6 | One owner of the report record shape | **Landed 2026-09-26** | The payload had no shared definition: `makeReport`/`reportLine` produced it, `report.js` consumed it, `report.test.js` hand-built it — so producer and consumer could drift silently while every test stayed green. `plugin/scripts/report-record.js` now owns the record shape and its URL serialization (`make`/`encode`/`decode`/`textOf`), loaded by script tag in both realms (realm-safe: it registers nothing; `report.html` still never loads `code.js`). `code.js` keeps the report *authoring* (`reportLine`/`summarizeSkipped` — conversion wording, not record layout) and `report.js` the page behaviour; neither names a field. `tests/report.test.js` is fed producer bytes (the recorded window URL of a real conversion run through the harness), with one hand-built corrupt payload kept as the non-record case, plus the `decode(encode(make()))` round trip and a byte-for-byte pin of the encoder's output. The report window's close lifecycle is now described once, in `report-record.js`'s header. |

What is already good and should survive any refactor: `scan.js` is a genuinely deep pure core;
the write path is defence-in-depth (`text-mismatch`, `misplaced-after-insert`, back-to-front
application); the harness recompiles command strings in a separate realm; `createHotkeyMatcher` is
pure and injectable; the ablation methodology (drop a condition, count failures) is rare and keeps
the guard rules honest.

Doc updates from this pass: README gained a *Code map* (four script files, the two coordinate
systems, where to look first); this note gained a *How to read this note* map above §1. Candidate 4
landed 2026-09-25: [`docs/adr/0001-dollar-pairing.md`](adr/0001-dollar-pairing.md) is the sole owner
of the dollar-pairing prose, the §1.8 rows and `scan.js` docblocks carry rule IDs as pointers, and
`tests/rules.test.js` fails on drift.
