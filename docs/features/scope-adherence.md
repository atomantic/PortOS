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

## An optional project-specific head

Zero-shot is the default and the only thing a fresh install runs. Optionally, an operator can fit a small classifier on the **frozen** encoder using this machine's own history, so the scorer learns *this* codebase's notion of in-scope rather than answering from the stock checkpoint's general priors.

Nothing about the advisory contract changes. A head emits the checkpoint's own three labels, in the same order, so `decideFromScores`, the `minMargin: 0.2` floor and the informativeness ranking are byte-identical whether one is adopted or not. There is still no auto-close, no gating label, and no CI check.

### Where the corpus comes from

`scripts/jev-corpus.js` (and the panel's Train button, through the same `services/jevCorpusBuilder.js`) reads four weak signals off the forge with `gh`:

| Source | Weak verdict | Why it is evidence |
|---|---|---|
| merged PRs on the default branch | `aligned` | the maintainer wanted it |
| closed-unmerged PRs | `unrelated` | they did not |
| issues closed `not planned` | `unrelated` | they did not |
| issues labelled `future` | `unrelated` | parked rather than refused |

Each row is paired with the clauses the SAME retriever picks at inference time, and the premise is composed by the SAME helpers — so a corpus row asks exactly the question the scorer is asked in production. The output is open-jev **Route A** JSONL (`{"context", "options", "label"}`), which keeps `openjev eval` usable as an independent cross-check on a corpus PortOS built.

**Every label is weak.** A merged pull request is evidence the maintainer wanted it, not an annotation that it advances the clause the retriever happened to pair it with. The held-out split, the two baselines and the adoption gate below exist precisely because "the head trained fine" proves nothing on its own.

Two sources named in the original proposal are deliberately absent, and the reasons are worth keeping:

- **The jev shadow-mode counters** record counts only — decision id, bucket, agreement flag, never a premise. That is exactly what makes shadow mode safe to leave on, and it also means they contain no labelled example and never will. They are carried on the corpus manifest as a readiness signal an operator can read, not folded in as rows.
- **`messageTriageRules.js`** corrections are email-sender keyed and belong to the `message-triage` decision, whose cutover waits on its own shadow-mode evidence. The builder is decision-generic so those callers can be added without reshaping anything.

### The split refusal

`splitCorpus` assigns train/gold by each example's **own content hash** — deterministic across machines and rebuilds, so a reported score can be reproduced by the person reading it. `assertSplitDisjoint` then **refuses** a split whose halves share an example key, or whose gold set is under 20 rows. A gold set contaminated by its training split reports a score that is partly memorization, and that score is the only evidence the adoption gate reads, so the refusal is a hard stop before anything is written — not a warning beside a corpus somebody might still train on. `dedupeCorpus` runs first, because a goal re-stated across `PRD.md` and `GOALS.md` produces the same question twice and would otherwise land in both halves by definition of the hash.

### Training

`scripts/train_jev_head.py` runs in the existing `venv-jev`, under the same hardened environment the sidecar gets — `HF_HUB_OFFLINE=1`, no API keys, no forge token, no arbitrary `PYTHONPATH`. **The encoder is frozen and never updated.** Frozen-encoder outputs are cached once per `(pair, model revision)` under `data/jev/embeddings/`, so a hyperparameter sweep costs seconds rather than re-paying a 4B forward pass per pair. The head is a linear classifier by default, or one hidden layer, over the last token's final hidden state; weights ship as bounded JSON so the compatibility check, the backup retention decision and code review are all inspectable.

Weak labels map the chosen option to `entailment` and the others to `neutral`, **not** `contradiction`: an option the maintainer did not take is unsupported by the change, not refuted by it — and training the third label on evidence that never meant refutation would teach the head to say *contradicts*, which is the one verdict this feature reports that a human would go and argue with.

### The adoption rule: beat BOTH baselines

A training run produces a **candidate** and three accuracies on the held-out gold set. It never promotes anything.

| Number | What it is |
|---|---|
| trained | the fitted head |
| stock zero-shot | the checkpoint's own classifier — needs no corpus, no training run, no privacy argument |
| majority class | always predicting the most common gold label |

`headBeatsBaselines` (`server/lib/jevHead.js`) requires the trained head to beat **both**, strictly. Beating only the majority class means it learned the label prior and nothing about the product; beating only zero-shot while losing to a constant prediction means the gold split is skewed enough that accuracy is not measuring anything, and the head would be adopted on the strength of that imbalance. Ties lose.

The gate is enforced in `adoptJevHead`, server-side. The panel also disables the button, but a hidden button is a suggestion — the refusal has to be on the function every surface goes through.

**A real outcome of a training run is that no head ships.** That is an acceptable result, not a failure.

### Revision compatibility

A head records the encoder revision it was fit on, and both the Node loader (`isHeadCompatible`) and the Python sidecar (`jev_head_kit.validate_head`) refuse one that does not match the installed checkpoint. Embeddings from a different revision are a different vector space: applying a head across one produces confident numbers with nothing anywhere to signal they are meaningless. An incompatible head falls back to the stock classifier and says so in the panel, rather than reading as "no head trained".

### Privacy and backup

Everything under `data/jev/` is a derived record of private repository history and is **machine-local**: never federated, never in a peer sync, never in a status or capability payload. The covered-path table in the ADR [privacy records machine-local](../decisions/2026-08-08-privacy-records-machine-local.md) names it, and `server/services/sharing/jevNeverFederates.test.js` is the guard. Cross-install or federated training is refused, not unimplemented.

Backup tiers are decided explicitly ([BACKUP.md](../BACKUP.md)): corpora and cached embeddings are regenerable bulk and are excluded, while **trained heads are retained** — a head is not regenerable once its corpus is stale.

## What is deliberately not here

- **Fine-tuning the encoder.** Frozen encoder plus a small head, only.
- **Trained heads for the triage decisions.** The same machinery serves them; that cutover belongs with those callers once their shadow-mode logs have accumulated.
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
| Failure labels | `server/lib/scopeAdherenceReasons.js` (re-exported to the client) |
| Trained-head contract and the adoption gate | `server/lib/jevHead.js` |
| Corpus schema, split and the overlap refusal | `server/lib/jevCorpus.js` |
| Corpus builder (forge reads) | `server/services/jevCorpusBuilder.js`, CLI `scripts/jev-corpus.js` |
| Head store, adoption, discard | `server/services/jevHeads.js` |
| Training orchestration | `server/services/jevTraining.js` |
| Trainer and shared pooling/head application | `scripts/train_jev_head.py`, `scripts/jev_head_kit.py` |
