# Agent prompt sections

Leaf modules used by `agentPromptBuilder.js`. The builder remains the public facade and owns only full/light prompt orchestration; section-specific behavior lives here.

| Module | Responsibility |
| --- | --- |
| `appContext.js` | JIRA ticket helpers; compatibility exports for read-only app lookup in `../agentAppWorkspace.js`. |
| `completion.js` | Worktree, completion-workflow, and sentinel sections. |
| `constants.js` | Constants shared across full and light prompt paths. |
| `forge.js` | Forge CLI selection for generated workflow text. |
| `instructions.js` | Skill-template routing and bounded instruction-file discovery. |
| `orchestrationDoctrine.js` | The architect doctrine an orchestrated run (#5992) gets — role/provider/model table, delegate-exploration and emit-specs rules, and the six-part spec contract incl. the pass-through `REASONING:` rung. Empty for a `direct` task. |
| `plannerAttribution.js` | The `planner:<model>` label a filing agent stamps, resolved from the run's own provider/model. |
| `reviewLifecycle.js` | Reviewer, CI-gate, and merge sections. |
| `slashdo.js` | Slashdo invocation and procedure expansion. |
| `taskContext.js` | Task, attachment, split-context, and compaction sections. |

CoS dispatch/workspace code should import read-only app resolution from
`../agentAppWorkspace.js`; it owns legacy registry-shape support, name/ID lookup,
null-on-unresolved semantics, and home expansion without registry writes or AI
dependencies. `apps.js#getAppById` is not interchangeable: its registry loader
reconciles persisted defaults and its lookup is ID-only. Keep ticket generation
here; preserve the builder and app-context exports for existing callers.
