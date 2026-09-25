# ADR 0001 — The dollar-pairing rules are owned here

* **Status:** adopted, 2026-09-25 (candidate 4 of the maintainability pass, `docs/NOTE.md` §6).
* **Scope:** the two pairing decisions in `plugin/scripts/scan.js` — `closerIsAlsoAnOpener` and
  `refusedDollarIsAnOpener` — and everything the rest of the repo is allowed to say about them.

## Context

The five + three pairing conditions were documented in four places: the two docblocks in
`plugin/scripts/scan.js` (conditions, rejected alternatives), `docs/NOTE.md` §1.8 (two ~700-word
table rows, ablation counts included), `README.md` *How detection decides* rule 4 (a lossy
compression of both), and the REPRO/CONTROL/ACCEPTED fixtures in `tests/scan.test.js` (the pins).
Keeping them in sync was a manual duty, and it had already failed: the row that said *"against the
128-test suite"* went stale the moment the suite grew. This record is now the **sole owner of the
rule prose**. Every other mention is a pointer carrying rule IDs, and `tests/rules.test.js` makes
drift a test failure rather than a review duty.

Rule IDs are **append-only**. A changed decision gets a new ID (or a `/suffix` entry), and the old
entry is amended with a pointer — never silently rewritten, because fixtures elsewhere pin the old
meaning.

## Rule manifest

The machine-read block below is the authoritative ID list: one line per rule, `ID | decision`.
`tests/rules.test.js` parses exactly this fence, so an ID that is not listed here does not exist.

```manifest
DP-closer-0 | The current opener's body is non-empty — abandoning it must cost a real span (`$$x$` keeps its `empty-span` diagnosis).
DP-closer-a | The candidate `$` can start math — a closer with nothing to open is never reinterpreted.
DP-closer-b | An even count of unescaped `$` remains from the candidate — the current opener is the odd one out.
DP-closer-w | The current opener's body contains whitespace — a spaceless body is a token, and first-open/first-close decides.
DP-closer-c | A nested close succeeds with a non-empty body — abandoning the opener must yield a span, not nothing.
DP-closer-b/rej-digit-opened | Rejected alternative: treating digit-opened spans as currency — it kills `$5$` and `$2 + 3$`.
DP-closer-w/rej-spaceless-body | Rejected alternative: requiring a spaceless body to identify the stealing opener — it misses `value=$x$`.
DP-refused-currency | A refusal the digit guard fired for is a price — never re-offered as an opener.
DP-refused-canStart | The refused `$` can start math — stated at the decision point, behaviourally redundant with the loop.
DP-refused-nested | A nested close exists with a non-empty body; a nested refusal still counts as a candidate.
DP-refused-currency/loss-1 | Accepted loss: `cost $5, and $10$ is wrong` stays text — a missed span is visible prose, a wrong span is not.
```

## Rationale

### A candidate closer that is itself an opener — `closerIsAlsoAnOpener`

Reported by a reader of `DesktopEditors#2062`: the closer guards only ever inspected the candidate
itself, never the `$` being taken from someone else, so `It costs $5, and the value=$x$ here.`
converted `$5, and the value=$` to math and left `x$ here.` as prose **with no warning at all** —
correct math eaten, which is worse than a dubious span. The fix refuses the candidate closer,
abandons the *earlier* opener, reports it as `guarded-inline-dollar`, and advances by exactly one —
never past the candidate — so the outer loop re-reads the candidate as the opener it is.

All five conditions are required; each covers a case the others miss:

* **`DP-closer-0`** — the current opener's body is non-empty, so it would have produced a span at
  all. When the body is empty `pushSpan` reports `empty-span`, which is the accurate diagnosis for
  `$$x$` with display switched off — and the outer loop advances by one anyway, so the later `$` is
  re-read as an opener without this rule's help. Firing first would merely relabel a real condition.
* **`DP-closer-a`** — the `$` at the candidate can actually start a span, so there is something to
  reinterpret (`$x$ costs $5.` must not fire: the candidate is followed by a space and has nothing
  to open).
* **`DP-closer-b`** — an **even** count of unescaped `$` remains from the candidate, so that `$` has
  a natural partner ahead and the *current* opener is the odd one out. This is what keeps `$a$and$b$`
  as two spans — there the remainder is 3, and reinterpreting would cost a real span to make one
  bogus one. The suffix count in `dollarFrom` makes the test O(1) instead of quadratic.
* **`DP-closer-w`** — the current opener's body contains **whitespace**, so the opener is an
  unmatched `$` that has swallowed prose. On a spaceless body both candidate pairings are
  token-local and reading order decides instead — first open, first close, the rule TeX follows:
  `$x$y$` pairs `x` and leaves the trailing `$` visible, rather than promoting the prose token `y`
  to math and stranding the author's `$x$` (live repro row 1). Every steal this rule exists for has
  a whitespace-bearing body (`"$5, and the value="`), so all pinned cases still fire.
* **`DP-closer-c`** — the nested probe actually closes with a non-empty body, so abandoning the
  current opener yields a span rather than nothing (on `$5 and$x$10` the later `$` is
  currency-guarded, and firing would be strictly worse than leaving the price alone).

Row 1's literal symptom — "`$x$y$` collapsed into a single math-italic xy" — was a stale build and
is **unproven** on the current one (measured live 2026-09-23); the semantic defect it pointed at is
real and is what `DP-closer-w` decides.

Rejected alternatives, both measured:

* **`DP-closer-b/rej-digit-opened`** — refusing a *digit-opened* span as currency. It kills `$5$`
  and `$2 + 3$`, both real math (`Compare $5$ vs $6$.` converted both in the live pass).
* **`DP-closer-w/rej-spaceless-body`** — requiring a spaceless body to identify the stealing opener.
  It does not catch `value=$x$` at all: every steal this rule exists for has a whitespace-bearing
  body. `DP-closer-w` is the *inverse* of it — there the body's shape was meant to *identify* the
  stealing opener; here a spaceless body *vetoes* abandoning it, because no prose can be swallowed.

`$` in prose is simply not decidable by one character rule, which is why conversion stays scoped to
the author's selection.

### A guard-refused `$` that is a legitimate opener — `refusedDollarIsAnOpener`

The invariant behind stepping past a refused `$` is sound: re-offering it would let `$10-$20` report
a guarded span *plus* a phantom `unterminated-inline-dollar`. It fails when the refusal came from the
**whitespace** guard rather than the currency one, because then the refused `$` may be the opener of
a real expression. The guarded arm used to step past its refused `$` unconditionally
(`i = closeInline.index + 1`), which on `cost $5, that will be $x+5$` landed **past the `$` that
opens `$x+5$`** — the sentence converted nothing while reporting one guarded warning. Isolating the
expression into its own paragraph "fixed" it only because the price is then not in the per-paragraph
scan. Root cause: the arm equated *"not a closer"* with *"not an opener"*. The whitespace rule itself
stays (the `Costs $5 and $6 plus $x$ here.` decision depends on it) — the **reaction** now branches.

Three conditions, each doing work the others cannot:

* **`DP-refused-currency`** — a refusal where the next character is a digit is a *price* and is
  never re-offered. `findDollarClose` checks the digit first, so this identifies exactly which guard
  fired. Without it, a US-style price pairs with a European-style suffix into one equation out of
  two prices (`cost $5, then $10 and 20$ here` → `$10 and 20$`), which is the worst outcome this
  scanner can produce: deleted prose, no rollback. Its cost is `DP-refused-currency/loss-1`.
* **`DP-refused-canStart`** — the refused `$` must be able to start math. Kept deliberately for
  readability even though it is behaviourally redundant: when it is false, visiting `refused` as an
  opener is impossible, so `i = i + 1` and `i = refused + 1` both land on `refused + 1`. It names
  the intent where the decision is taken instead of leaving it to be re-derived from the loop below.
* **`DP-refused-nested`** — a nested `findDollarClose` must have found *some* candidate with a
  non-empty body, so re-offering is worth the re-read. Without a candidate at all,
  `cost $5, see $blah and more` gains a phantom `unterminated` beside the guarded one — the exact
  failure the invariant exists to prevent. A nested result which is *itself* guarded still counts as
  a candidate: refusing here would walk past `$x` in `cost $5, see $x and $10` and then call the
  trailing price `unterminated`, hiding a real attempt while reporting a price as malformed — the
  opposite of what the malformed bucket is for (this branch was caught by the phase-8 code review,
  was not in the original plan, and has its own fixture). The span decision is never taken from this
  helper; it only decides where the loop resumes, and the normal guards apply from there.

Parity (`dollarFrom`) is deliberately **not** applied here, unlike `closerIsAlsoAnOpener`: there it
decides which of two competing openers is the odd one out, whereas here the current opener has
already produced nothing, so abandoning it costs no span — and an odd remainder would wrongly refuse
`cost $5, be $x+5$ and $10`, where `$x+5$` is followed by a third price.

**Accepted loss — `DP-refused-currency/loss-1`:** `cost $5, and $10$ is wrong` stays text, nothing is
converted: the `$10$` behind the price is real math the currency rule leaves alone. A missed span
stays visible text the author can select and convert by hand; a wrong span deletes prose with no
rollback. Recovering it would need a rule about the shape of the body, and such a rule would also
refuse `$2 + 3$` there. Pinned as a fixture so the decision cannot drift silently.

## Evidence

Dated ablation counts live **here and nowhere else** — the moment they are restated in README or
`docs/NOTE.md` they go stale, which is exactly what happened to the "128-test suite" sentence this
record replaces. `tests/rules.test.js` bans numeric test counts from those two files.

**2026-09-23, phase 8 (`c2b14cd`…`3964e08`), against the then-current 128-test suite** — moved here
verbatim from `docs/NOTE.md` §1.8: dropping the currency check → **126/128** (its own two fixtures);
restoring `|| nested.guarded` → **127/128** (its own fixture); the naive "always resume one step" →
**122/128**, six failures of which exactly one is pre-existing
(`a guard rejection is reported as guarded, not as a malformed delimiter`), so the invariant is
enforced by a test that already existed.

**2026-09-25, this ADR, against the 132-test suite** — each condition disabled on its own and the
full suite run; failures listed by fixture:

| Condition dropped | Failing fixtures |
| :--- | :--- |
| `DP-closer-w` | `REPRO row 1: $x$y$ pairs the first expression and leaves the orphan visible`, `REPRO row 1: the odd run never eats the good $z$ behind it` |
| `DP-refused-currency` | `CONTROL: a US price and a European 20$ never pair into one equation`, `ACCEPTED: a compact $10$ behind a price stays text (measured)` |
| `DP-refused-nested` | `CONTROL: re-offering happens only when the refused $ actually closes` |
| `DP-closer-0`, `DP-closer-a`, `DP-closer-b`, `DP-closer-c`, `DP-refused-canStart` | none |

The zero rows are the measured **overlap** between conditions, not dead code. `$a$and$b$` is kept by
`DP-closer-w` when `DP-closer-b` is off, and by `DP-closer-b` when `DP-closer-w` is off;
`DP-closer-0` and `DP-closer-a` re-decide at the pairing site what `pushSpan` and the opener gate
already decide (their counter-cases relabel or lose a span rather than fail a fixture);
`DP-refused-canStart` is provably redundant with the loop. Each condition keeps its own rationale
line above because the overlap is exactly what disappears silently first when someone "simplifies"
the rule.

## Consequences

* The rule prose lives here only. `plugin/scripts/scan.js` carries a three-line summary at each
  function head and one manifest line per condition; `README.md` rule 4 and `docs/NOTE.md` §1.8
  carry a one-line decision, the rule ID and a link here.
* Every fixture that pins a rule carries `// rule: <ID>` in `tests/scan.test.js`; those annotations
  are the fixture ↔ rule map.
* `tests/rules.test.js` fails when a `DP-*` token appears outside this manifest, when a manifest ID
  loses its annotated fixture, or when README / `docs/NOTE.md` state a numeric test count.
* IDs are append-only (see Context). Removing a manifest line is a decision to un-own a rule and
  must remove its fixtures' annotations in the same change — which the drift test will notice.
