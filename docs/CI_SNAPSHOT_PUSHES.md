# CI for generated snapshot pushes

The quality snapshot (`.quality.json`)
merges in its own PR, and its push would otherwise run the whole matrix over a
tree that differs from the green one only in that file. When the newest green
run is exactly the push's first parent (`ci-base-sha.js` exports
`CI_PREDECESSOR_GREEN_SHA`) and the complete two-tree diff against it
(`--no-renames`, so a rename into another path is listed) holds only
generated-data paths, the planner returns the generated-data plan: the impact
job (admission, hidden-content, import-case, plan, syntax) and the ordinary
`CI Gate` run, every test job is skipped, and the plan reason names the first
parent. A missing or non-parent green run, an empty or unreadable diff or any
other path keeps the full plan. The plan is `native_gated`, so it publishes no
`Full CI Gate`, and Main health will not close a "main is red" issue on a run
whose `Server tests` jobs did not succeed: only a complete run closes it.

See [CI_TEST_SELECTION.md](CI_TEST_SELECTION.md) for the rest of the impact planner.
