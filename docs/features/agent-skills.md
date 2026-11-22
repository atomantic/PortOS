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
