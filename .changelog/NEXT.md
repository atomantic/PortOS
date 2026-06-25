# Unreleased

## Editorial checks

- **[issue-1612] Cleared findings now point you at the next step instead of a blank list.** When every editorial finding on a series had been accepted or dismissed (or before any check has run), the triage view either showed a screen of collapsed "0 open" groups or a bare "run the checks" line — with no hint at what to do next. The empty/cleared state now surfaces a contextual next-steps block: **Re-run checks** (kicks off all enabled checks without leaving the page), **Refresh reverse outline**, and **Continue in the pipeline** (where Series Autopilot and the visual stages live). The "all cleared" banner renders above the resolved groups so you can still review or undo, and it's suppressed while a filter or muted check is narrowing the view (that case keeps its own "no matches" messaging). (`client/src/components/pipeline/editorial/EditorialFindingsTriage.jsx`, `client/src/pages/PipelineEditorialChecks.jsx`)
