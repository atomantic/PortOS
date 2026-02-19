# Agent Skill System (M40)

Improves CoS agent accuracy and reliability through task-type-specific prompt templates, context compaction, negative example routing, and deterministic workflow skills. Inspired by [OpenAI Skills & Shell Tips](https://developers.openai.com/blog/skills-shell-tips).

## P1: Task-Type-Specific Agent Prompts (Skill Templates)

Created specialized prompt templates per task category with routing, examples, and guidelines:
- **Routing descriptions**: "Use when..." / "Don't use when..." sections in each skill template
- **Embedded examples**: Worked examples of successful completions for each task type
- **Task-specific guidelines**: Security audit includes OWASP checklist; feature includes validation/convention requirements; refactor emphasizes behavior preservation

**Implementation:**
- Added `data/prompts/skills/` directory with 6 task-type templates: `bug-fix.md`, `feature.md`, `security-audit.md`, `refactor.md`, `documentation.md`, `mobile-responsive.md`
- Added `detectSkillTemplate()` and `loadSkillTemplate()` in `subAgentSpawner.js` with keyword-based matching (ordered by specificity -- security/mobile before generic bug-fix/feature)
- Updated `buildAgentPrompt()` to inject matched skill template into both the Mustache template system and the fallback template
- Updated `cos-agent-briefing.md` with `{{#skillSection}}` conditional block
- Templates only loaded when matched to avoid token inflation

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
