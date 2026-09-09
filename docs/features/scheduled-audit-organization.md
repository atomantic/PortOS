# Scheduled audit names, labels, and order

All tasks in `AUDIT_DEFINITIONS` belong to the `better-*` display-name family.
On install/update, schedule responses derive these names from the catalog.
Existing task IDs remain stable: saved prompts, provider pins, cadence, execution
history, run-after references, app overrides, API calls, and bookmarked task IDs
continue to work. No task is newly enabled or automatically run.

The newly prefixed display names are: better-security, better-code-quality,
better-test-coverage, better-performance, better-accessibility,
better-documentation, better-ui-bugs, better-mobile-responsive,
better-error-handling, better-typing, better-console-errors, better-ux,
better-data-safety, better-simplify, better-module-hygiene, better-api-contract,
better-react-lifecycle, better-observability, and better-copy. The six existing
better-* names remain unchanged.

Operational tasks (claims, review pipelines, reconciliation, releases, repo sync),
planning/ideation, private security assessment, JIRA, and media generation retain
their names: they have distinct execution or security contracts and are not
members of the configurable audit catalog. Independent code-reviewer A/B tasks
also retain their identities; they are general review workflows.

Shipped labels include codebase-improvement, slashdo, and the audit's mapped
slashdo lenses. The slashdo label means alignment with that library's audit
family, not that dispatch necessarily invokes a slash command. Custom labels
are optional schedule metadata, saved in the existing task config; absent means
empty, and clearing uses an empty array. This additive field requires no layout
conversion or seed rewrite. Shipped labels and names are derived in memory, so
older schedules gain them without overwriting any customization. Labels do not
change dispatch, issue labels, eligibility, or failure backoff.

The label filter is linkable with `?label=slashdo`. It intersects the status
filter and text search; search accepts old IDs, display names, descriptions,
and both shipped and custom labels. Shipped labels remain available even when
custom labels are cleared.

## Recommended order for one code area

The bundled `lib/slashdo/lib/better-audit.md` runs the test audit after the other
selected audit scopes so it can consume their findings; those other audit
scopes are independent. Follow that for an issues-only audit batch. The sequence
below concerns **implementing changes in the same area**: tests still need to
protect behavior before a refactor begins.

This is engineering guidance, not a dependency graph or a claim that every repo
needs every pass. Existing evidence and urgent defects take priority.

1. Broad code-quality triage if needed; ensure tests detect behavior and add
   missing boundary coverage. Fix security, data-loss, and runtime defects first.
2. **Structural drift**: consolidate sources of truth before polishing code
   that may disappear. **Simplify**: remove dead and duplicate code next.
3. **Module hygiene**: establish ownership, reuse, and boundaries. Remove
   unnecessary dependencies once the surviving owners are clear.
4. **Complexity**: remeasure branching in surviving functions and simplify the
   costly ones. **Cognitive load**: review readability of the final shape.
5. Revalidate runtime behavior and meaningful tests; measure performance where
   there is a demonstrated bottleneck. Refresh documentation after changes land.

Thus module hygiene generally precedes function-level cyclomatic complexity,
and structural drift generally precedes both. A localized hot function can be
improved independently when it has no ownership or source-of-truth problem.
API, React, accessibility, UI, copy, and observability passes follow the needs of
the changed area rather than a universal rank. Work on disjoint areas may run
independently; serialize overlapping edits, merge, and reassess before the next
pass. A completed audit that only files issues has not completed remediation.
The page repeats the relevant recommendation alongside each audit description;
custom bylines remain intact and existing run-after settings are unchanged.
