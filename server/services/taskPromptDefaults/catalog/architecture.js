export const prompts = {
  'simplify': `[Improvement: {appName}] Dead-code and duplication audit

Find code {appName} would be better without.

Repository: {repoPath}

{modeInstructions}

Hunt specifically for:

- **Unreferenced code** — exports with no importer, components rendered from
  nowhere, feature flags with one branch permanently dead, config keys nothing
  reads. Verify with a repo-wide search before acting; a dynamic or
  string-keyed reference is easy to miss and a wrong removal is expensive.
- **Re-implemented helpers** — a local function that duplicates something the
  project's shared library catalogs already provide. Cite both, and propose the
  reuse.
- **Copy-paste drift** — near-identical blocks that have diverged, where one copy
  has a fix the other never got. That divergence is a latent bug; say which copy
  is correct.
- **Stale scaffolding** — commented-out blocks, TODOs whose work already
  shipped, migration or compatibility shims whose trigger can no longer occur.

Cross-version and cross-install compatibility code is NOT dead code, even when
this install no longer hits it. Read the project's rules on migrations and
version gates before proposing any such removal.

An unreferenced endpoint, setting, or job that does user-meaningful work may be
an unfinished feature rather than dead code — check whether documentation,
interface text, or a plan describes it. If one does, it belongs to the
incomplete-feature work, which decides whether to finish or remove it; do not
file a deletion here. File splits and responsibility boundaries belong to the
module-hygiene work. Validation, recovery, and process machinery that runs and
works but costs more than the harm it prevents belongs to the over-engineering
work; this audit covers code that nothing runs or that is copied.`,

  'over-engineering': `[Improvement: {appName}] Over-engineering audit

Find process and validation machinery in {appName} that costs more than the
harm it prevents, and recommend removing or simplifying it.

Repository: {repoPath}

{modeInstructions}

Other audits find defects and propose safeguards. This one runs the other way:
it looks for safeguards that already exist and asks whether each earns its
cost. Every finding is a REMOVAL or SIMPLIFICATION, never a new check, layer,
or workflow.

## Cost is measured, not asserted

Each finding needs a number: CI minutes added per run, agent or developer
turnaround, local gate or build time, or the lines and modules that must be
kept correct. Measure with the project's own tooling where you can (CI run
timings, a timed local run, line counts, import graphs) and state how you
measured. "This seems heavy" is not a finding. Speed counts: machinery that
slows CI, the local gate, or an agent's turnaround is paying a cost on every
single run.

## Hunt for

- **Parallel verification of state another system already owns** — code that
  re-checks branch, merge, review, deployment, or build status the code host,
  CI system, package registry, or platform already tracks authoritatively, or
  that re-derives it into a second copy that can drift. Name the owning system
  and what it already guarantees.
- **Recovery machinery with no reachable failure** — archives, ledgers,
  checkpoints, backups-before-delete, or retry and reconciliation layers whose
  triggering failure cannot happen, or has never happened in the history, logs,
  or tests. Show why the failure is unreachable or already handled upstream.
- **Guards that add time without catching regressions** — CI stages, lint or
  structural tests, pre-push gates, or validation passes that duplicate a
  stronger check, run on every change though they only matter for a few paths,
  or have never failed on a real regression. Cite the run time and the
  stronger check that already covers the same failure.
- **Instructions and docs that mandate such processes** — contributor, agent,
  or workflow documentation requiring steps whose machinery above is removable,
  or a checklist longer than the failures it prevents.

## Evidence for "no demonstrated harm"

Search history (\`git log -S\`, issue and change-request references in commit
messages), test names, and logs for the incident the machinery was built for.
If a real incident exists and the machinery still prevents it, keep it. If the
cost exceeds the harm and no incident or reachable failure is found, that
absence is the finding. State what you searched.

## Not yours

- **Code with no behavior** — unreferenced exports, copy-paste duplication,
  stale scaffolding — belongs to the dead-code and duplication audit
  (\`simplify\`). This audit targets process and validation machinery that runs and
  works but is disproportionate, not code that nothing runs.
- Compatibility and migration code for other installs and versions is not
  over-engineering; read the project's rules before proposing its removal.
- Security boundaries, data-loss protections, and checks the project's rules
  require are not candidates unless you can show they duplicate a stronger one.
- Do not assume one code host, CI system, or platform. Name the actual systems
  this repository uses, and keep recommendations valid for them.

## The bar

For each finding give \`file:LINE\` (or the doc and section), what the machinery
verifies or recovers, who or what already owns that guarantee, the measured
cost, the demonstrated harm (or its absence), and the proposed removal or
simplification — including the corrected instruction or doc text when a document
mandates it. Reject removals that trade real safety for speed you cannot
measure.`,

  'module-hygiene': `[Improvement: {appName}] Module hygiene audit

Make {appName} easier to extend by improving responsibility boundaries, reuse,
ownership, and discovery of reusable code. A large codebase is not itself a
problem; the target is code whose organization makes correct changes harder.

Repository: {repoPath}

{modeInstructions}

## Choose one bounded slice

Audit one coherent slice. Rank candidates using several signals together:
size, recent churn, import
fan-in, mixed responsibilities, and whether the preloaded Recent audit slices
block already lists the area. Prefer a slice that block does not name over
repeatedly scanning the same hotspot. Name the chosen slice before investigating it.

These numeric thresholds generate candidates only; crossing one is never a
finding by itself:

- cyclomatic complexity above 15
- a function body above 50 lines
- nesting depth above 4
- a file above 500 lines that appears to mix responsibilities

For declarative UI, schemas, registries, and configuration, distinguish data or
markup volume from branching, state, side effects, and change coupling.

## Prove structural maintenance cost

Keep a candidate only when the code proves at least one concrete consequence:

- one change repeatedly touches unrelated responsibilities
- high-churn behavior is concentrated behind an unstable or oversized boundary
- callers depend on internal details because ownership is unclear
- duplicated behavior has already drifted or makes fixes repeat across copies
- reusable code exists but agents or contributors cannot reliably discover it
- a public surface has no clear owner, placement rule, or compatibility policy

Read the producer, consumers/importers, tests, repository instructions, and
recent history before deciding. A subjective preference for smaller files or a
different folder layout is not a finding.

## Reuse-search proof

Before proposing a new helper, hook, service, component, or primitive:

1. Search the repository's catalogs, README/domain maps, barrels or public
   exports, and likely shared directories.
2. Search semantically related terms as well as the proposed symbol name.
3. Inspect existing candidates and their importers to decide whether one should
   be extended.
4. Record what was searched, why reuse is or is not appropriate, the intended
   public owner, the internal seam, target location, and migration path.

For duplication, cite both locations and prefer a deletion-oriented
consolidation. Do not propose a wrapper that leaves both implementations alive.

## Discoverability without catalog burden

Use the lightest durable discovery mechanism appropriate to the surface:

- A genuinely reusable/public surface may need a curated catalog with a cheap,
  mechanical parity check.
- A broad implementation directory usually needs a lightweight domain map,
  placement rule, or ownership note rather than a barrel or exhaustive manual
  inventory.
- Pages, routes, and application implementations do not need catalogs merely
  because the directory is large.

A proposed catalog must name its consumer and its parity mechanism. Prefer
clear naming and placement, or a generated index, when a handwritten inventory
would become a second maintenance burden.

## Exclusions

Do not file or implement shallow findings against generated, vendored, build,
snapshot, fixture, test, migration, or historical-default sources; primarily
declarative registries or schemas; documented compatibility facades or re-export
barrels; intentional cross-runtime mirrors; semantic adapters; or coherent large
modules with no proven change cost. Compatibility code is not dead code merely
because the current checkout no longer exercises it.

## Ownership and prior-work deduplication

This audit owns responsibility boundaries, module topology, reusable-surface
discoverability, and complexity caused by structural mixing. Pure dead-code
removal and direct copy-paste deletion belong to the repository's simplification
work; broader correctness and registry/generated-source drift belong to its
general code-quality work. Link or reuse a sibling finding instead of filing the
same work under a new category.

Search current open work, closed tracker items, and merged changes by file,
symbol, and behavior—not only by this audit's name. Treat a previously shipped
split, compatibility facade, or deliberate adapter as history to understand,
not as proof the same refactor should be filed again.

## Result quality

Normally produce zero to three high-confidence findings; five is the hard mode
contract maximum, not a quota. Each finding must include exact file:line
evidence, maintenance impact, relevant producers/consumers/tests/history,
reuse-search and prior-work evidence, a decided destination and what remains
behind, compatibility obligations, and acceptance criteria at the highest
practical public boundary.

If the evidence is insufficient, file or change nothing. In every outcome,
report the audited slice, the searches performed, the findings kept, and the
candidates deliberately rejected so a no-finding run still records useful
coverage.`,

  'better-complexity': `[Improvement: {appName}] Cyclomatic complexity audit

Reduce the branching complexity of {appName}'s hottest functions. Complexity is
what makes a function expensive to change safely: every independent path is a
case the next person must hold in their head and a case the tests must cover.

Repository: {repoPath}

{modeInstructions}

## Measure, do not estimate

Cyclomatic complexity is 1 + the number of independent decision points in a
function body. Count, in the function itself and not in the functions it calls:

- \`if\` and \`else if\` (a bare \`else\` adds nothing — it has no test of its own)
- each \`case\` that can be reached independently
- each loop (\`for\`, \`while\`, \`do\`, and comprehension forms)
- each \`catch\` / \`except\` clause
- each short-circuit or conditional operator guarding a distinct outcome
  (\`&&\`, \`||\`, \`??\`, the ternary)

Report the number you counted for every candidate. A finding that says
"complex" without a count is not a finding.

**Length is not complexity.** A 200-line function with three branches is a
different problem, and belongs to the repository's module-hygiene work. A
30-line function with 22 paths is squarely yours.

## Rank by cost, not by score

The worst-scoring function in the repository is not automatically worth
changing. Rank candidates by complexity, by how often the function actually
changes, and by how many callers depend on it:

\`\`\`bash
git log --since='90 days ago' --name-only --format='' | sort | uniq -c | sort -rn | head -40
\`\`\`

Low churn is a ranking factor, never an automatic exclusion. A severe complexity
hotspot can still dominate risk in stable code. Compare the highest measured
counts across the repository before selecting a fix; explain with evidence if
you pass over the raw worst offender. Recent churn and caller reach increase
priority when the measured complexity and impact are otherwise similar.

## Reject these — high branching is correct here

- **Dispatch tables and exhaustive switches over a closed set.** A \`switch\` with
  30 cases mapping a known enum to a known result is a lookup written in control
  flow; splitting it hides the totality the reader wants.
- **Parsers, tokenizers, and format decoders** whose branches mirror a real
  input grammar.
- **Generated, vendored, and migration sources**, and historical compatibility
  ladders whose branches each pin a released behavior.
- **Validation chains** whose branches are one independent rule apiece.
- **A function whose branches are already named** — a flat sequence of guard
  clauses reads linearly no matter what the metric says.

## Name the transformation

Every finding must name which of these it applies, and to what:

- **Guard clauses / early return** — invert a nested condition so the
  exceptional path exits and the happy path un-indents.
- **Extract a named predicate** — replace a multi-clause boolean with one
  function whose name states the rule.
- **Lookup table or dispatch map** — replace an \`if\`/\`else if\` ladder or a
  value-mapping \`switch\` with data.
- **Extract a cohesive step** — pull a self-contained block into a named
  function, but only when the block has a real name that is not "part 2".
- **Collapse duplicated branches** — two arms differing by one value become one
  arm parameterized by that value.
- **Replace a state-flag ladder** with an explicit state map or table.

"Split this up" is not a transformation. "Extract the retry-budget decision into
\`shouldRetry(attempt, err)\`, collapsing 6 paths to 2" is.

## Behavior preservation is the contract

A complexity reduction that changes behavior is a bug, not an improvement. For
every finding, state what pins the behavior today: the existing tests covering
the function, or — when the paths are untested — the test that must be written
FIRST, at the highest practical public boundary rather than against the
extracted helper. Report the before and after path counts.

Give each finding exact \`file:LINE\` evidence, the counted complexity, the churn
and caller evidence that made it worth changing, the named transformation, and
what proves behavior is unchanged.`,

  'better-cognitive-load': `[Improvement: {appName}] Cognitive load and readability audit

Find the code in {appName} that is hardest to understand, and say precisely what
a reader must hold in their head to change one line of it safely.

Repository: {repoPath}

{modeInstructions}

This audit is about **reader cost**, which no metric captures. Sibling work owns
the measurable shapes: counted branching, function length, nesting depth, file
size, and responsibility boundaries are not your findings. Start from the files
a newcomer reads first — entry points, primary route or command handlers, the
modules with the most importers — and from whatever the repository's history
shows is changed most often.

## Hunt for

- **Mixed abstraction levels in one function** — high-level orchestration
  interleaved with raw query text, byte manipulation, or DOM detail, so the
  reader switches altitude mid-paragraph.
- **Flag arguments** — a boolean or enum parameter that makes one function do
  two unrelated jobs, so every call site is a puzzle and the body is a fork.
- **Names that lie or say nothing** — \`data\`, \`tmp2\`, \`handle\`, \`doStuff\`;
  abbreviations that need tribal knowledge; a name describing the implementation
  where the caller needs the intent.
- **Negated booleans** — \`notDisabled\`, \`hideNothing\`, \`skipUnlessMissing\` —
  anything forcing double-negative reasoning at a call site.
- **Excessive code comments** — redundant narration, stale explanations,
  commented-out code, and verbose walkthroughs of obvious control flow. Read the
  surrounding code before deciding what to remove or shorten. Keep concise context
  that cannot be inferred from names and code paths: why, invariants, non-obvious
  constraints, safety rationale, external contracts, and justified workarounds.
  Preserve licenses, tool directives, meaningful type/JSDoc metadata, public API
  documentation, and needed rationale. Prefer clearer code when it can express
  the same information. Do not use comment counts or length quotas as targets.
  This is code-comment maintenance, not a rewrite of user-facing documentation.
  In file-issues mode, report concrete examples and the proposed cleanup without
  editing source; in implement mode, remove or tighten excessive comments and
  review the diff for behavior preservation.
- **Action at a distance** — module-level mutable state, implicit ordering
  requirements between calls ("you must call init first"), and side effects
  hidden behind names that read as pure.
- **Defensive soup** — chains of optional access and \`|| fallback\` that obscure
  which values are actually possible, and casts papering over a contract nobody
  wrote down.
- **A contract you cannot state in one sentence** — if you cannot say what a
  function guarantees without reading its body twice, that is the finding.

## Do not file

- Formatting, quote style, import order, line length, or anything a formatter or
  linter owns.
- A rename of a public export without a backward-compatible re-export path.
- Personal preference between two equally readable spellings.
- A restructuring whose only argument is that you would have written it
  differently.

## Every finding names the cost it removes

State the transformation (extract, invert, rename, table-ize, early-return,
make-the-state-explicit) **and** the specific reader cost it deletes: what the
next person currently has to know, look up, or keep in their head, and will not
have to after the change. A finding calling code "confusing" or "hard to follow"
without naming what specifically must be held in mind is not actionable — drop
it.

Quote the code with \`file:LINE\`, give the proposed shape, and keep behavior
identical. This audit never changes what the code does.`,
};
