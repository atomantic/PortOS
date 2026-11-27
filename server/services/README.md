# Server Services

Domain services own multi-step workflows over models, settings, and shared
infrastructure. Import the narrow service module needed by a caller; the
image-generation paths below are useful entry points when tracing render jobs.

## Subdirectory map

A domain with five or more cohesive modules lives in its own named subdirectory (see `portos-add-module`). Import the specific module (no barrels).

| Directory | Owns |
| --- | --- |
| `meatspace/` | MeatSpace health, alcohol/nicotine/substance logs, calendar, daily log and the POST cognitive-training services (`meatspace*.js`). |
| `beeper/` | Beeper mirror: OAuth/credentials, client, sync, conversations, outbox, scheduler, attachments, tribe linking (`beeper*.js`). |
| `agent/`, `cos/` | CoS agent lifecycle, spawning state and the Chief-of-Staff task/tool services. |
| `musicVideo/`, `videoGen/`, `imageGen/`, `audioGen/`, `film/`, `videoTimeline/` | Media generation and music-video render pipelines. |
| `pipeline/`, `storyboards/`, `writersRoom/`, `creativeDirector/`, `fableLoom/` | Story and creative production workflows. |
| `catalog/`, `catalogDB/`, `catalogIdentity/`, `universeBuilder/` | Creative catalog, ingredients and universe records. |
| `voice/` | Voice pipeline (STT/TTS, tools, config). |
| `provider/`, `backup/`, `sharing/`, `identity/`, `worktree/`, `branchReconcile/` | Provider execution, backups, sharing, identity, worktree and branch maintenance. |


## Common entry points

- [Image preparation](imageGen/prepareParams.js) resolves model selection and
  input policy. [Image dispatch](imageGen/index.js) selects the backend.
- [Media queue](mediaJobQueue/index.js) owns admission, cancellation and recovery.
  Register completion hooks before resuming completion recovery.
- [Docker discovery](dockerEngine.js) selects a local engine. The contained
  [executor](dockerContainment.js) applies the install/test runtime policy.
- [Server conventions](../AGENTS.md) cover service boundaries, write serialization
  and provider selection. Search the module catalog with
  `node scripts/lib-catalog.js <term>` from the repository root.
