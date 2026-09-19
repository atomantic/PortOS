# Scope adherence — does this change advance what the product says it is for?

A repository's `PRD.md` and `GOALS.md` state what it is supposed to be. Until now nothing read them. Scope adherence scores one filed issue or one open pull request against those files with the local entailment scorer ([JEV_SETUP.md](../JEV_SETUP.md)) and prints one sentence naming the clause it scored against.

**It is advisory and it will stay advisory.** No auto-close, no gating label, no CI check, no blocked agent. [ETHOS.md](../../ETHOS.md) asks that supervision gates be justified before they are added, and a 4B classifier disagreeing with prose is not a justification. The output exists so a human can go read a named clause and decide — including deciding the classifier is wrong.

## Where it appears

Under an expanded row in an app's **Issues** tab, and under each row in its **Pull Requests** tab, as a *Check scope* button. It runs only on that click:

- The scorer is a ~9 GB local model that loads on first use, so scoring every visible row on mount would be exactly the cold-bootstrap work the AI Provider Usage Policy in [AGENTS.md](../../AGENTS.md) forbids.
- The button is absent entirely when the `jev` instance feature is off (**Settings > Features**), which is the shipped default.

## How a verdict is produced

```
parse PRD.md + GOALS.md           ← server/lib/prdClauses.js. No model.
  ↓ clauses
retrieve top-k candidates         ← BM25 × 2 views, fused with RRF. No model.
  ↓ ≤ k clauses
screenUntrustedContent()          ← Prompt Guard. Unchanged, and not optional.
  ↓ safe
runJevDecision('scope-adherence') ← once per clause. Abstains on a near-tie.
  ↓
one advisory naming the clause
```

An issue or PR body is attacker-controlled text, so it passes phase 1 of the untrusted-content ladder before any model reasons over it — the same contract described in [messages-security](./messages-security.md). Scope adherence is a **phase-2 reasoner**, never a replacement for the screen.

The screen is not the first step, because the two steps above it are inert with respect to that text: reading the operator's own files, and tokenizing the change for an in-process BM25 query. A managed app with no PRD, or a change nothing in the corpus matches, can never produce an advisory — and making it pay a full model-abuse classifier run (possibly a sidecar cold start) to be told so is the only cost on this path that repeats per click. **The exact string that is screened is the exact string that enters every premise**, so the screened text and the scored text cannot drift apart.

### Clause parsing

`server/lib/prdClauses.js` splits each document into one clause per paragraph, top-level list item, blockquote, or table data row. Fenced code, table headers and horizontal rules are dropped — they are syntax, not statements about the product. PortOS's own two files yield ~175 clauses.

A clause id is `<sourceFile>#<heading-path-slug>:<content-hash>` — **no line number and no document ordinal**, so inserting an unrelated paragraph above a requirement does not re-key it. A verdict recorded last week still addresses the same clause today. Two byte-identical clauses under one heading are disambiguated with a `~<n>` suffix.

### Retrieval, not exhaustive scoring

Each clause is a separate forward pass through a 4B model, so scoring all of them would cost minutes for a verdict that cites one. `selectCandidateClauses` builds two BM25 rankings of the same corpus — one from the change's prose (title + body), one from its code-side vocabulary (a changed-file list, when the caller has one) — and fuses them with the `fuseRankingsRRF` the memory retrieval stack already uses. Fusing beats concatenating: whichever view is longer would otherwise dominate the term frequencies. Only the top `k` (default 3) are scored. The Pull Requests tab passes title alone: that listing carries no description, and PortOS branch names (`claim/issue-N`, `cos/<task>/<agent>`) would feed the code-side view noise rather than vocabulary.

### The three hypotheses

Frozen as the `scope-adherence` entry in `server/lib/jevDecisions.js`, beside the four untrusted-content rungs — PortOS's one registry of closed-set questions the local scorer may answer. They are the entire instruction surface of the feature, so one diff shows every question that can be asked, and registering there is also what gives this decision its abstention counters in the jev panel and its scorability contract test. It is the only entry with `source: null`: it asks about the operator's own documents, not about text that arrived on a channel.

| Verdict | Hypothesis |
|---|---|
| `aligned` | The proposed change advances the stated product goal. |
| `unrelated` | The proposed change is unrelated to the stated product goal. |
| `contradicts` | The proposed change works against the stated product goal. |

The premise is the clause first and in full, then the change. Both halves are capped well below the scorer's 32k premise bound — the clause at 2,000 characters and the change at 4,000 — because the change text is byte-identical in all k × 3 forward passes, so an unbounded issue body makes every pass prefill the same thousands of tokens to tell apart clauses that differ by at most 2,000 characters. Measured, that turns a ~5 s click into a ~40 s one.

### Abstention and reporting

The floor is the decision's `minMargin: 0.2`, wider than the scorer's own `0.15` default: `unrelated` and `contradicts` read very differently to a human, and calling a PR "works against" a goal on a hair's separation would burn the feature's credibility faster than saying nothing. Below it the row reads *No advisory*.

When several clauses answer, the reported one is ranked by **informativeness**, not retrieval position: `contradicts` → `aligned` → `unrelated`, widest margin breaking a tie. A contradiction found on the third-ranked clause is the single most useful thing this feature can say, and ranking by margin alone would bury it under a confident `aligned`.

## Privacy

Everything is machine-local. The corpus is two files in a checkout, the scorer is a loopback sidecar, and no verdict, premise, or clause is persisted, federated, or included in a status or capability payload — consistent with the ADR [privacy records machine-local](../decisions/2026-08-08-privacy-records-machine-local.md).

The repository path comes from the loaded app record, never from the request: `POST /api/apps/:id/scope-adherence` takes only `kind`, `title`, `body` and `diffSummary`, and its schema is `.strict()`, so a client-supplied checkout path cannot turn an advisory endpoint into an arbitrary-file reader. An app with no repository is refused rather than silently graded against this install's own PRD.

## Failure modes

| Code | What it means |
|---|---|
| `scope-adherence-disabled` | The `jev` instance feature is off. Nothing was screened or scored. |
| `scope-adherence-change-empty` | The row has no title or description to score. |
| `scope-adherence-corpus-missing` | The checkout has no `PRD.md` or `GOALS.md` (or the app has no repository). |
| `scope-adherence-corpus-unreadable` | The files exist but could not be read — a broken install, not an empty one. |
| `scope-adherence-no-clause` | No stated goal was close enough to the change to be worth a forward pass. |
| `untrusted-content-*` | Phase 1 blocked the content, or the abuse guard could not run. See [messages-security](./messages-security.md). |
| `jev-*` | The scorer itself is unavailable. See [JEV_SETUP.md](../JEV_SETUP.md). |

Each reads as "no advisory" in the UI, never as a verdict.

## What is deliberately not here

- **A trained, project-specific head.** Fitting a small head on the frozen encoder from this install's merged PRs, closed-unmerged PRs and triage corrections — with a hand-labeled gold set and a "must beat both the stock zero-shot and the majority-class baseline to be adopted" rule — is tracked separately. Zero-shot ships first because it is useful on its own and needs no corpus.
- **Any enforcement**, now or later. See the opening paragraph.

## Source

| Piece | File |
|---|---|
| Clause parser | `server/lib/prdClauses.js` |
| The three hypotheses and the abstention floor | `server/lib/jevDecisions.js` (`scope-adherence`) |
| Retrieval, premise composition, route schema | `server/lib/scopeAdherence.js` |
| The ladder (screen → retrieve → decide) | `server/services/scopeAdherence.js` |
| HTTP surface | `server/routes/apps/scopeAdherence.js` |
| UI | `client/src/components/apps/ScopeAdherenceCheck.jsx` |
| Failure labels (client mirror) | `client/src/lib/scopeAdherenceReasons.js` |
