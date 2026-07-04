# Cross-Domain Insights Engine (M42 P5)

Design spike for connecting genome ↔ health ↔ taste ↔ identity ↔ creative output
into narrative insights surfaced in Brain. Resolves the four design questions from
issue #738 against the **actual** PortOS codebase and lays out a phased plan a future
`/claim` can pick up.

## Status: partially shipped, design not yet written

This milestone has been built incrementally as ad-hoc `INS-XX` tasks **without a
unifying design**, which is exactly the gap this spike closes. What exists today:

| Piece | Status | Where |
|-------|--------|-------|
| INS-01 Genome ↔ blood correlations (rule-based) | shipped | `server/services/insightsService.js` `getGenomeHealthCorrelations()` |
| INS-02 Taste ↔ identity themes (LLM) | shipped | `insightsService.js` `generateThemeAnalysis()` → `data/insights/themes.json` |
| INS-04 Cross-domain narrative (LLM) | shipped | `insightsService.js` `refreshCrossDomainNarrative()` → `data/insights/narrative.json` |
| `/insights` surface (4 tabs) | shipped | `client/src/pages/Insights.jsx`, `client/src/components/insights/*` |
| REST routes | shipped | `server/routes/insights.js`, validation `insightRefreshSchema` in `server/lib/validation.js` |
| Nav manifest entries | shipped | `server/lib/navManifest.js` (`nav.insights*`) |
| **INS-03 Health ↔ goals** | **missing** | — |
| **Insight disposition (dismiss / accept) data model + UX** | **missing** | — |
| **Structured "facts table" the LLM consumes** | **missing** (prompts hand-roll free text) | — |
| **Brain digest integration** | **missing** | — |

So the engine *renders* three independently-generated analyses, but it has no concept
of a **discrete, dismissable, accept-able insight**, no health↔goals pairing, and no
structured contract feeding the LLM. The sections below specify those four missing
pieces and the model that unifies them.

---

## Q1 — Which signal pairs to correlate first

**Decision: ship the four pairs below, in this order.** Each pairing is justified by (a)
the data already existing in PortOS, (b) a non-trivial correlation worth surfacing, and
(c) the user being able to *act* on it.

| # | Pair | Source services | Why first | Method |
|---|------|-----------------|-----------|--------|
| 1 | **Genome ↔ Health (blood)** | `genome.js` `getGenomeSummary()`, `meatspaceHealth.js` `getBloodTests()` | Already shipped (INS-01); highest-confidence because both sides are objective lab data. The `CATEGORY_BLOOD_MAP` (cardiovascular, iron, methylation, diabetes, thyroid, nutrient) already aligns curated markers to analytes. | Rule-based, no LLM — deterministic and auditable. |
| 2 | **Taste ↔ Creative output** | `taste-questionnaire.js` `getTasteProfile()`, Creative Catalog (`catalogDB.js`) + Universe/Series/Writers-Room records | The whole point of taste profiling is to inform creative production; this closes the loop the digital-twin doc describes. Stated aesthetic preferences vs. what the user actually *makes*. | LLM — qualitative theme extraction (extends INS-02 beyond identity into produced work). |
| 3 | **Health ↔ Goals** (the missing INS-03) | `meatspaceHealth.js` (workouts, body history, blood pressure, blood panels), `identity/goals.js` `getGoals()` + `goalProgress.js` `getGoalProgressSummary()` | Goals frequently *are* health goals (weight, fitness, longevity); pairing measured biometrics against stated goal progress is the most directly actionable insight surface. | Hybrid — rule-based progress deltas feed an LLM "are you on track / what's drifting" summary. |
| 4 | **Genome ↔ Longevity** | `genome.js` (the `longevity` marker category already exists: FOXO3A et al. in `curatedGenomeMarkers.js`), `meatspaceHealth.js` epigenetic tests | Longevity is a named GOALS.md ambition and the genome data is already categorized. Pairs protective/risk longevity variants with epigenetic-age measurements. | Rule-based correlation + LLM narrative framing. |

**Explicitly deferred** (data too sparse or correlation too weak to be honest right now):
genome↔taste, calendar↔health (sleep/activity timing), messages-tone↔personality.
These re-enter the queue once their source data has more density.

**Polarity / honesty rule (carry forward from INS-01):** every correlation must keep the
`inferMarkerPolarity` + `confidenceForStatus` discipline already in `insightsService.js`
— surface *patterns and correlations*, never causal/medical claims. New pairs reuse the
same `confidence: { level, color, label, polarity }` shape so the UI badge
(`ConfidenceBadge.jsx`) stays uniform.

---

## Q2 — Where insights land

**Decision: keep the dedicated `/insights` surface as the home, AND feed a curated slice
into the Brain daily digest. Not either/or — a hub + a spoke.**

Rationale:

- The `/insights` page already exists, is nav-registered, and is the right home for the
  *exploratory* view (browse all correlations by domain, refresh on demand). Folding
  everything into the digest would bury the rich per-domain tabs.
- But an insight the user never opens the page to see is worthless. The Brain **daily
  digest** (`brain.js` `runDailyDigest()`) is the existing once-a-day "here's what's
  relevant" surface and is the natural push channel. It already gathers projects/admin/
  people/inbox and emits a ≤150-word `digestText` via the `brain-daily-digest` prompt.

**Integration shape:**

1. The insights engine maintains a queue of **undismissed, high-confidence insights**
   (see Q3 data model). 
2. `runDailyDigest()` pulls the top 1–2 *fresh* (generated since last digest) insights
   and passes them as an additional `pendingInsights` context key to the digest prompt,
   which references them in one sentence with a deep-link to `/insights/<tab>`.
3. The **weekly review** (`runWeeklyReview()`) gets the fuller treatment: a dedicated
   "Patterns this week" section listing newly-surfaced insights, since weekly is the
   natural cadence for slower-moving genome/health/taste signals.

This respects the "single source of truth" principle: insights are *generated and stored*
by `insightsService`, and Brain digest is a *reader* — it never re-derives them.

---

## Q3 — How the user dismisses / accepts an insight

This is the **largest missing piece**. Today an "insight" is just cached LLM text with no
per-item identity, so there's nothing to accept or dismiss. The design introduces a
first-class **Insight record**.

### Data model

Insights become discrete records, persisted under `data/insights/` (the dir
`insightsService.js` already targets). Because insights are per-record, frequently
mutated (disposition flips), and want independent reads, use
`createCollectionStore` from `server/lib/collectionStore.js` (the same pattern migration
034 used for `universeBuilder`) → `data/insights/{id}/index.json` with a type-level
`data/insights/index.json` stamping `schemaVersion`.

```jsonc
{
  "id": "ins_2026-06-03_genome-health_HFE",   // stable, deterministic where possible
  "pair": "genome-health",                     // one of the Q1 pairs
  "title": "Iron-overload carrier + elevated ferritin",
  "narrative": "Your HFE carrier status pairs with ferritin trending high over your last two panels…",
  "confidence": { "level": "weak", "color": "orange", "label": "Carrier", "polarity": "risk" },
  "facts": [ /* the structured rows that produced this — see Q4 */ ],
  "sources": [                                  // mirrors the Ask Source shape (see Q4)
    { "kind": "genome", "id": "genome:rs1800562", "title": "HFE rs1800562", "href": "/meatspace/genome" },
    { "kind": "blood",  "id": "blood:ferritin",   "title": "Ferritin (latest)", "href": "/meatspace/blood" }
  ],
  "disposition": "new",        // "new" | "accepted" | "dismissed" | "snoozed"
  "dispositionAt": null,
  "dismissReason": null,       // optional free text when dismissed
  "snoozeUntil": null,         // ISO date when "snoozed"
  "generatedAt": "2026-06-03T…",
  "generator": "rule" ,        // "rule" | "llm"
  "ai": { "providerId": "…", "modelId": "…" }  // present only when generator === "llm"
}
```

### Disposition semantics (use a sentinel, per CLAUDE.md)

- `new` — surfaced, not yet triaged. Eligible for the daily/weekly digest push.
- `accepted` — user marked it meaningful/true. Stays pinned at the top of its tab; **excluded
  from re-generation churn** (a regenerate must *preserve* an accepted insight's id +
  disposition rather than overwrite it — mirror the LLM-merge "absent vs intentionally
  empty" rule: a regenerated batch that no longer contains an accepted insight does NOT
  delete it, it marks it `stale: true`).
- `dismissed` — user rejected it (wrong, irrelevant, or already known). Hidden from the
  page and **never re-surfaced**: regeneration checks a dismissed-fingerprint set
  (`pair` + a content hash of the underlying facts) so the same correlation doesn't
  bounce back next refresh.
- `snoozed` — hide until `snoozeUntil`, then revert to `new`. (Resolves the "true but not
  now" case.)

### UX

Reuse the existing tab components; add a disposition control to `InsightCard.jsx`. Per the
user's confirmation-UX preference (no two-click-arm patterns), the controls are **direct
inline actions**, not armed confirmations:

- **Accept** (check) — one click, optimistic; pins the card with an "Accepted" chip.
- **Dismiss** (×) — one click, optimistic; the card collapses to a thin "Dismissed —
  undo" row for the rest of the session (undo restores `new`), then disappears on reload.
- **Snooze** (clock) — opens a tiny inline picker (1w / 1mo / custom), no modal.

Optimistic updates follow the **reactive-UI rule**: mutate local card state immediately,
PATCH in the background, roll back on error. A small reusable `useInsightDisposition`
hook (in `client/src/hooks/`, barrel + README per the maintenance rule) wraps the
optimistic PATCH, analogous to the existing `useLockToggle`.

### Routes (new)

```
GET    /api/insights              — list insight records (filter by ?pair= &disposition=)
POST   /api/insights/generate     — (re)run generation for a pair; preserves accepted, skips dismissed
PATCH  /api/insights/:id          — { disposition, dismissReason?, snoozeUntil? }
```

Validation extends `server/lib/validation.js`: a new `insightDispositionSchema`
(`z.enum(['new','accepted','dismissed','snoozed'])` + optional reason/snoozeUntil) wired
into the PATCH, and a `insightGenerateSchema` (`{ pair, providerId?, model? }`). The
existing `insightRefreshSchema` stays for the legacy narrative/themes refresh endpoints
during the transition.

---

## Q4 — Structured "facts table" vs. raw stage data

**Decision: the LLM receives a structured facts table, NOT raw stage data.** The current
implementation hand-rolls free-text context blocks inline in each prompt
(`refreshCrossDomainNarrative` concatenates `GENOME HEALTH MARKERS:\n…` strings). That is
brittle, untestable, and re-derives the same shaping logic per call. We formalize it.

### Why a facts table

1. **Determinism & testability** — a pure `buildFactsTable(pair)` function is unit-testable
   without an LLM in the loop; the prompt becomes a thin render of validated rows.
2. **Provenance for free** — each fact already carries its source, so the resulting
   insight's `sources[]` (the Ask-style chips) fall out of the same structure rather than
   being reconstructed.
3. **Token discipline** — raw stage records (full blood panels, every taste answer,
   complete genome summary) blow the budget; the facts table is the pre-filtered,
   pre-normalized slice that actually matters for a given pair.

### Schema sketch

A `Fact` row is the atomic unit feeding generation. It deliberately mirrors the **Ask
`Source` shape** (`{ kind, id, title, snippet, relevance, href, meta }` in
`server/services/askService.js`) so the source-chip rendering and provenance contract are
shared across Ask and Insights rather than diverging.

```jsonc
// Fact (one row of the facts table)
{
  "domain": "genome",          // genome | blood | apple-health | taste | goals | creative | longevity
  "key": "rs1800562",          // stable identifier within the domain
  "label": "HFE C282Y",        // human-readable
  "value": "heterozygous",     // normalized value (string | number)
  "unit": null,                // e.g. "ng/mL" for analytes
  "observedAt": "2026-05-01",  // when this datum is from (latest blood draw, etc.)
  "polarity": "risk",          // reuse INS-01 polarity where applicable
  "source": {                  // === Ask Source shape — shared provenance contract
    "kind": "genome",
    "id": "genome:rs1800562",
    "title": "HFE rs1800562",
    "href": "/meatspace/genome"
  }
}
```

```jsonc
// FactsTable (what one pair's generator assembles and hands the LLM)
{
  "pair": "health-goals",
  "facts": [ /* Fact[] — already filtered & normalized for this pair */ ],
  "generatedAt": "2026-06-03T…"
}
```

### Prompt contract

The LLM prompt renders the facts table as a compact, labeled table (not prose blocks) and
is instructed to return **structured insights** (a JSON array of
`{ title, narrative, confidence, factKeys[], strength }`) — where `factKeys[]` references
the rows that justify each insight, so the engine can attach the exact `sources[]` and
`facts[]` to the stored Insight record without the LLM having to re-emit provenance. This
also lets the UI show "based on: HFE, ferritin" deterministically.

Rule-based pairs (genome↔health, genome↔longevity progress deltas) skip the LLM entirely
and synthesize the Insight record directly from the facts table — same record shape,
`generator: "rule"`.

---

## Phased implementation plan

A future `/claim` can pick these up in order. Each phase is independently shippable.

### Phase A — Facts-table foundation (refactor, no user-visible change)
- Add `server/services/insights/factsTable.js` with `buildFactsTable(pair)` and the
  `Fact`/`FactsTable` shapes above. One builder per pair (genome-health builder lifts the
  existing `getLatestBloodValues` + `CATEGORY_BLOOD_MAP` logic out of `insightsService.js`).
- Add `insightsFacts.test.js` covering each builder with fixture data.
- Re-point `refreshCrossDomainNarrative` / `generateThemeAnalysis` to render from facts
  tables instead of hand-rolled context strings (behavior-preserving).
- Barrel + README rows for any new `server/lib` helper.

### Phase B — Insight records + disposition (the core missing model)
- Stand up the `createCollectionStore` for insights → `data/insights/{id}/index.json`;
  seed `data.reference/insights/` and add a migration in `scripts/migrations/` that
  converts the legacy `themes.json` / `narrative.json` caches into discrete records (per
  the distribution-model rule — other installs have those files).
- Add `GET /api/insights`, `POST /api/insights/generate`, `PATCH /api/insights/:id` with
  `insightDispositionSchema` + `insightGenerateSchema` validation.
- Regeneration logic: preserve `accepted`, mark vanished-accepted `stale`, skip
  `dismissed` fingerprints, revert expired `snoozed` → `new`.

### Phase C — Disposition UX
- `useInsightDisposition` hook (optimistic PATCH, rollback on error) + barrel/README.
- Add inline Accept / Dismiss / Snooze controls to `InsightCard.jsx` (direct actions, no
  armed confirmation).
- Update the three tab components to render records from `GET /api/insights` and to pin
  accepted / hide dismissed.

### Phase D — Health ↔ Goals pair (the missing INS-03)
- `factsTable.js` builder pairing `meatspaceHealth` biometrics +
  `server/services/goalProgress.js` (`getGoalProgressSummary`) deltas against
  `server/services/identity/goals.js` goals.
- Hybrid generator: rule-based progress deltas → LLM "on track / drifting" narrative.
- New tab or fold into Cross-Domain tab (decide at impl time based on volume).

### Phase E — Brain digest integration
- `runDailyDigest()` reads top 1–2 fresh `new` insights, passes `pendingInsights` to the
  `brain-daily-digest` prompt (prompt-version bump + `PREVIOUS_DEFAULT_PROMPTS` entry per
  CLAUDE.md, since this changes a shipped prompt's default).
- `runWeeklyReview()` gets a "Patterns this week" section.

### Phase F — Genome ↔ Longevity + Taste ↔ Creative-output pairs
- Two more facts-table builders + generators, reusing everything above.

## Cross-cutting requirements (carry into every phase)

- **No causal/medical claims** — keep the INS-01 polarity/confidence discipline.
- **Distribution model** — `themes.json`/`narrative.json` exist on other installs; any
  storage change needs a migration + seed in `data.reference/`.
- **Sentinel discipline** — `disposition` is an explicit enum; never let "no insights yet"
  collapse into "generation failed" (mirror the `available:false, reason` pattern already
  in `insightsService.js`).
- **Shared provenance** — `Fact.source` and `Insight.sources` reuse the Ask `Source`
  shape so source chips render identically across `/ask` and `/insights`.
- **Reactive + optimistic UI** — disposition changes mutate local state first, PATCH in
  the background.

## Related features

- [Digital Twin](../features/digital-twin.md) — taste/identity/personality source
- [Identity System](../features/identity-system.md) — goals, autobiography, the `/ask` loop
- [Brain System](../features/brain-system.md) — daily digest + weekly review push channel
