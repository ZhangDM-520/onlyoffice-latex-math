# Engineering notes — LaTeX math plugin

Measured against **onlyoffice-git 9.4.0.130-1** (built from
`~/Projects/Gentoo_Style_Arch/packages/git/onlyoffice-git`), upstream sdkjs pinned at
`0cd3e72a8c88c512666157bb452a4ba7b4213617`.

Everything below was reproduced live in the real editor; nothing here is inferred from docs.

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
the host only attaches a click event for items that registered one.

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
* Chromium caches the plugin script; clear `data/cache/{Cache,Code Cache}` after installing.

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

## 3. Verification log (live, GUI)

| Check | Result |
| :--- | :--- |
| Ribbon tab `LaTeX math` at cold start, no interaction | present; 8 items render |
| *Convert document* on a 13-`$` fixture | `Converted: 4 / 4`; `$10`, `$20`, `\$5` untouched |
| Display equation via `$$…$$` | `m:oMathPara` in the saved OOXML |
| Document right-click → *LaTeX math* → *Convert whole document* | clicked by hand, report window opened, 4/4 |
| *Convert selection* (first paragraph only) | `2 LaTeX spans found`, `Outside the selection: 2`, 2/2 converted |
| One undo after a run | all four source paragraphs restored verbatim |
| Save (`Ctrl+S`) and inspect the `.docx` | 6 `<m:oMath`, 2 `<m:oMathPara`, exactly 3 `$` left (currency + escape) |
| Reopen the saved file | equations load as native, editable math |
| Paragraph icons at scale 1.25 (5 scales shipped) | entry, ribbon row and menu all render; the tab itself cannot have one (§1.6) |
| Report window close affordances | header X, footer *Close* and `Esc` each close it; a second report is a fresh window with current numbers |
| Reports silent by default | conversion opens no window (`openReport=false`); *Show last report* opens one on demand |
| **Reported bug**: `$$x=1$$` not detected | before: `Scanned: 0 paragraphs` / `Skipped paragraphs whose text offsets cannot be mapped: 3` / `Nothing to convert.` — after: `Scanned: 3 paragraphs, 1 LaTeX spans found (1 display)`, `Converted: 1 / 1` |
| The same document's paragraph offsets, read live | all three `aligned: false`; `collectParagraphs` keeps 3, `unusable: 0` |
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

**Open item, not caused by this phase** (recorded 2026-09-20): converting the live ` $$x=1$$` paragraph
above produced a saved file whose leading space is gone. Before: one run,
`<w:t xml:space="preserve"> $$x=1$$</w:t>` (a leading space inside the text). After: an **empty** run,
`<m:oMathPara>` (x=1), three empty runs. In the inline case
(previous row) both spaces survived, so the suspicion is the display path or the save serializer rather
than the span offsets — but `plugin/scripts/{scan,commands}.js` are **untouched** by the hotkey work
(`git diff --name-only`), so this is pre-existing and was not investigated further. Worth a dedicated
look: a conversion must not consume neighbouring characters.

## 4. Test layout

`node --test tests/` → 99 tests.

* `scan.test.js` — the delimiter core: escapes, currency guard, `$$` precedence, unterminated spans,
  blank-line rejects, offset planning, and the paragraph-offset filter (a paragraph whose length
  comparison fails must still be scanned; only an unreadable one is set aside).
* `plugin-harness.js` — a fake browser window plus a fake editor; it mirrors the host's *gates*, not
  just the API surface: `callCommand` stays silent while the editor is "booting", `addCheckers`
  records checkers, and `composeContextMenu(type)` reproduces `onContextMenuShow` including the
  recursion into children. That last mirror is what would have caught the empty-submenu bug. It also
  models the frame chain (`parent.document` with capture-phase listener recording) and
  `parentAccessThrows`, and `pressAltChord` replays the real two-event sequence of §1.10.
* `hotkey.test.js` — the chord: the matcher's rules (exact modifier set, repeat, `AltGr`, staleness,
  keyup, intervening key) and the host-level behaviour (a plain `l`/`m` and `Ctrl+L` are never claimed,
  one chord converts once, collapsed selection converts nothing, `Ctrl+A` then the chord converts the
  document, the silent-report setting is respected, the listener attaches once per document, and a
  blocking host degrades instead of throwing).
* `fake-editor.js` — models the measured read shape of §1.7: a paragraph's **own** range carries its
  trailing `\r\n` while a sub-range ending at the same offset does not, so `aligned` is false for every
  paragraph exactly as on the host. A harness too kind here is what let the gate ship.
* `integration.test.js` — publication timing, backstop, caption refresh, both conversion modes, the
  owner-reported document (`a=∑▒n_i` + empty paragraph + ` $$x=1$$`), spans refused per offset drift,
  the report window's close affordances and the silenced-by-default report.
* `icons.test.js` / `png.js` — every icon slot exists at all five scales as a valid, non-blank PNG
  (a minimal PNG decoder, so the check is host-independent).
* `report.test.js` — the report payload survives the host's URL mangling and corrupted input.
