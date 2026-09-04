# Agent prompt sections

Leaf modules used by `agentPromptBuilder.js`. The builder remains the public facade and owns only full/light prompt orchestration; section-specific behavior lives here.

| Module | Responsibility |
| --- | --- |
| `appContext.js` | Managed-app workspace lookup and JIRA ticket helpers. |
| `completion.js` | Worktree, completion-workflow, and sentinel sections. |
| `constants.js` | Constants shared across full and light prompt paths. |
| `forge.js` | Forge CLI selection for generated workflow text. |
| `instructions.js` | Skill-template routing and bounded instruction-file discovery. |
| `orchestrationDoctrine.js` | The architect doctrine an orchestrated run (#5992) gets — role/provider/model table, delegate-exploration and emit-specs rules, and the six-part spec contract incl. the pass-through `REASONING:` rung. Empty for a `direct` task. |
| `plannerAttribution.js` | The `planner:<model>` label a filing agent stamps, resolved from the run's own provider/model. |
| `reviewLifecycle.js` | Reviewer, CI-gate, and merge sections. |
| `slashdo.js` | Slashdo invocation and procedure expansion. |
| `taskContext.js` | Task, attachment, split-context, and compaction sections. |
