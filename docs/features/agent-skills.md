# Agent Skill System (M40)

Improves CoS agent accuracy and reliability through task-type-specific prompt templates, context compaction, negative example routing, and deterministic workflow skills. Inspired by [OpenAI Skills & Shell Tips](https://developers.openai.com/blog/skills-shell-tips).

## P1: Task-Type-Specific Agent Prompts (Skill Templates)

Created specialized prompt templates per task category with routing, examples, and guidelines:
- **Routing descriptions**: "Use when..." / "Don't use when..." sections in each skill template
- **Embedded examples**: Worked examples of successful completions for each task type
- **Task-specific guidelines**: Security audit includes OWASP checklist; feature includes validation/convention requirements; refactor emphasizes behavior preservation

**Implementation:**
- Added shipped `data.reference/prompts/skills/` templates: `bug-fix.md`, `feature.md`, `security-audit.md`, `refactor.md`, `documentation.md`, `mobile-responsive.md`, and `threejs-visual.md`
- Added primary lifecycle routing plus an optional bounded domain guide in `agentPromptBuilder.js`; a Three.js, React Three Fiber, or WebGL scene task receives the visual guide after its lifecycle guidance, so a security task retains its security checklist
- `buildAgentPrompt()` injects matched templates into the API-path briefing
- Templates only load when matched to avoid token inflation; generic WebGL mentions do not trigger the scene guide

## P2: Agent Context Compaction

Long-running agents can hit context limits causing failures. Added proactive context management:
- Pass `--max-turns` or equivalent context budget hints when spawning agents
- Track agent output length and detect when agents are approaching context limits
- Added compaction metadata to agent error analysis so retries can include "compact context" instructions
- Updated the agent briefing to include explicit output format constraints for verbose task types

## P3: Negative Example Coverage for Task Routing

Improved task-to-model routing accuracy by adding negative examples to the model selection logic:
- Documented which task types should NOT use light models
- Added "anti-patterns" to task learning: when a task type fails with a specific model, record the negative signal via `routingAccuracy` cross-reference (taskType x modelTier)
- Surfaced routing accuracy metrics in the Learning tab so the user can see misroutes
- Enhanced `suggestModelTier()` to use negative signal data for smarter tier avoidance

## P4: Deterministic Workflow Skills

For recurring autonomous jobs (daily briefing, git maintenance, security audit, app improvement), encoded the full workflow as a deterministic skill:
- Each skill defines exact steps, expected outputs, and success criteria in `data/prompts/skills/jobs/`
- Prevents prompt drift across runs -- jobs now load structured skill templates instead of inline prompt strings
- Skills are versioned and editable via the Prompt Manager UI (Job Skills tab)
- `generateTaskFromJob()` builds effective prompts from skill template sections (Steps, Expected Outputs, Success Criteria)
- API routes added: GET/PUT `/api/prompts/skills/jobs/:name`, preview via GET `/api/prompts/skills/jobs/:name/preview`

## P5: Skill Registry (agentskills.io, progressive disclosure)

A second, open-ended skill system sits beside the fixed templates above (which keep working unchanged). A skill is an [agentskills.io](https://agentskills.io)-style directory: a `SKILL.md` with YAML frontmatter (`name`, `description`, `version`, `platforms: [macos|windows|linux]`, `tags`, `category`, `requiresTools`, `fallbackForTools`; other keys are kept but ignored) plus optional `references/`, `templates/`, `scripts/` and `examples/` folders. Skills can sit in category folders (`data/skills/devops/deploy/SKILL.md`).

**Progressive disclosure** keeps prompts lean:
- **Level 0**: `{ id, name, description (first 120 chars), category, tier, path, platforms }`. The full (`api`) agent briefing gets this index (at most 50 entries) when any skill is visible. Light-mode TUI/CLI agents can fetch it themselves.
- **Level 1**: the full `SKILL.md` and a manifest of its supporting files.
- **Level 2**: one supporting file. The path must sit under one of the four support folders, and any symlink on the way is refused.

**Tiers, highest precedence first:** `project` (a managed app's `.agents/skills/` and `.claude/skills/`, only when the app turns on **Discover repo skills for agents** in its Workflow settings, i.e. `skillDiscovery: true`), then `local` (`data/skills/`), then `shipped` (`data.reference/skills/`), then `external` (absolute directories in `settings.skills.externalDirs`, set through `PUT /api/skills/config`). When the same name exists in two tiers, the higher tier wins and the lower one is reported as `shadowed`, with one log line per pair. When two skills share a name inside the same tier, a bare-name lookup is refused (`SKILL_AMBIGUOUS`): use the id (`local:writing/notes`) or the tier-relative path. Skills whose `platforms` leave out this host OS are hidden. Symlinked skill directories are never discovered.

**Quarantine:** every `project` and `external` skill (its `SKILL.md` and all supporting text files) runs through the deterministic model-abuse signals in `server/lib/modelAbuseGuard.js` before it can enter the index. Those signals cover hidden or direction-control Unicode, instructions hidden in comments, instruction override, context or credential disclosure, secret exfiltration, encoded instructions, and download-and-execute. A skill with any finding is `quarantined`: it is listed with generic reasons that never quote its text, and it is refused on load (`SKILL_QUARANTINED`). Verdicts are cached in `data/cache/skill-scans.json`, keyed by a SHA-256 over every scanned file, so an edit or a `git pull` triggers a rescan. `local` and `shipped` skills belong to the operator and are not scanned. No model is called anywhere in parsing, scanning or linting.

**Linter (advisory):** create and patch results carry warnings, and a valid skill is never blocked. The warnings are `missing-description`, `long-description` (over 120 chars), `oversized-body` (over 24k chars), `incident-log-shape` (dense issue/PR/date narration) and `references-sprawl` (more than 60 reference files).

**Surfaces:**
- REST (`server/routes/skills.js`): `GET /api/skills[?appId]`, `GET /api/skills/view?ref=…[&file=…][&appId=…]`, `POST /api/skills/manage`, `GET|PUT /api/skills/config`. The writes need operator authority, so a password-free LAN caller is refused.
- CoS tools (`cosToolRegistry.js`): `skills.list` and `skills.view` (agent, mind and UI scopes, under `readPortos`), plus mind-only `skills.manage` behind the default-off **Allow mind to author procedural skills** grant (`manageSkills`). `skills.manage` writes only the `local` tier. Its actions are `create {name, category?, content}`, `patch {name, oldString, newString, replaceAll?}`, `write_file {name, path, content}`, `remove_file {name, path}` and `delete {name}`, each with its own strict schema (`server/lib/skillsValidation.js`).

Code: `server/lib/skills/skillRegistry.js` (parse, discover, precedence, path jail), `server/lib/skills/skillLinter.js`, `server/services/skills/skillScanner.js`, `server/services/skills/skillService.js`.

## P6: Skill Curator (usage telemetry, pin/lock, archival, ledger rollback)

Keeps the `local` tier from drifting and bloating the Level 0 index, and makes any single agent edit or deletion reversible. Every decision is deterministic; the curator never calls a model.

**Usage telemetry** (`data/skills/.usage.json`, one record per skill id): `viewCount`/`lastViewedAt` (every Level 1/2 read), `useCount`/`lastUsedAt` (a read through the `skills.view` agent tool, since the skill's text then enters an agent's prompt), `patchCount`/`lastPatchedAt` (every write), `createdAt`, `createdBy` (`agent` | `user` | `null`), `state` (`active` | `stale` | `archived`), `pinned`, `locked`, `archivedAt`, `adoptedAt`. The Level 0 index is not counted, because it is injected into every full briefing and would make every listed skill look in use. `GET /api/skills` annotates each skill with `usage` and lists archived skills under `archived`. The file is read strictly: when it is unreadable or malformed, the listing reports `usageUnavailable: true` instead of zero counts, and nothing rewrites the file.

**Pin and lock:**
- **Pinned** skills are skipped by the curator. Deleting or archiving one is refused (`SKILL_PINNED`) for every caller. Patches still work, so an agent can keep improving it.
- **Locked** skills refuse every agent write (`patch`, `write_file`, `remove_file`, `delete` → `SKILL_LOCKED`) through the `skills.manage` tool and `POST /api/skills/manage`. Reads are unaffected, and human edits through `POST /api/skills/edit` (the PortOS UI) still succeed. The lock guards against an agent accidentally rewriting a curated skill; it is not an authorization boundary.
- When `.usage.json` cannot be read, the guards cannot be checked, so every agent write and every delete is refused with `SKILL_USAGE_UNREADABLE` (503) until the file is repaired.

**Curator pass** (`server/services/skills/skillCurator.js`): it manages only `local` skills with `createdBy: 'agent'`. A skill gets that flag when an agent creates it, or when a human adopts it explicitly (provenance is declared, never inferred). Pinned skills, locked skills, and skills named by any autonomous job (by id, path or name, in its name, description or prompt, including paused and disabled jobs) are skipped. The idle clock is the latest view, use, patch, restore or creation stamp. A skill that has never been used starts its clock no earlier than its adoption, and a managed skill with no stamp at all starts its clock at the pass that first sees it (the grace floor). After `staleAfterDays` (default 14) idle the skill becomes `stale`. After `archiveAfterDays` (default 30) a stale skill moves into `data/skills/.archive/<path>`. A skill is always stale for at least one pass before it is archived, and any use returns it to `active`. The curator never deletes. Its archive record is keyed `archive:<path>` and remembers the original id, so a new skill created at the old path starts fresh. Restore moves the skill back and is refused when a local skill now holds that name or path (`SKILL_EXISTS`). The pass runs from the default-off **Skill Curator** script job (`job-skill-curator`, daily) or from `POST /api/skills/curator/run`. `{ "dryRun": true }` returns the exact planned transitions without touching disk. The pass fails closed when the usage file or the job store cannot be read.

**Mutation ledger** (`server/services/skills/skillLedger.js`): every local write (create, patch, file add/remove, delete, archive, restore, rollback) appends one entry to `data/skills/.curator_ledger.jsonl`: `{ id, at, actor: curator|agent|user, action, skill, before, after }`. The `before` and `after` manifests list `{ path, sha256, bytes }` relative to `data/skills/`, with the bytes stored once per hash in `data/skills/.ledger_blobs/<sha256>`. The `before` snapshot is taken before the write, and a failed snapshot refuses the write. `POST /api/skills/ledger/:entryId/rollback` restores exactly the files that one entry touched: every `before` file comes back from its blob and every file only in `after` is removed, so a rollback can resurrect a deleted skill without reverting unrelated ones. Before changing anything, the rollback verifies each blob's hash (`SKILL_LEDGER_BLOB_MISSING` if one is missing or damaged) and appends a `rollback` safety entry that snapshots the current state; that entry can itself be rolled back. If any of these steps fails, nothing changes. The ledger and its referenced blobs are capped at `ledgerMaxBytes` (default 5 MB). Compaction drops no-op entries first, then the oldest entries, always keeping the newest one, and then sweeps blobs that no remaining entry references and that are more than an hour old. Pin, lock and adopt are metadata changes recorded in `.usage.json`, not ledger entries.

**Config:** `PUT /api/skills/config` with `{ "curator": { "staleAfterDays", "archiveAfterDays", "ledgerMaxBytes" } }` merges into the stored values. `archiveAfterDays` must stay greater than `staleAfterDays`.

**Routes** (writes need operator authority): `GET /api/skills/curator/status` (thresholds, counts, last pass, job state), `POST /api/skills/curator/run` (`{ dryRun? }`), `POST /api/skills/:ref/:action` (`pin`, `unpin`, `lock`, `unlock`, `archive`, `restore`, `adopt`; `ref` is a URL-encoded id or name; restore also takes the original `local:` id), `POST /api/skills/edit` (the human-edit twin of `/manage`), `GET /api/skills/ledger[?limit&skill]` (newest first, manifests summarized), `POST /api/skills/ledger/:entryId/rollback`.
