# Prompt Manager

Customizable AI prompts for all backend AI operations with file-based storage and template rendering.

## Architecture

- **Prompt Service** (`server/services/promptService.js`): Template loading, variable substitution, stage configuration
- **Prompt Routes** (`server/routes/prompts.js`): REST API endpoints
- **Prompt Page** (`client/src/pages/PromptManager.jsx`): Stages, Variables, Elements tabs with live preview

## Features

1. **Prompt Stages**: Define different prompts for different AI tasks (detection, analysis, etc.)
2. **Variables**: Reusable content blocks (personas, formats, constraints)
3. **Per-Stage Provider Config**: Each stage can use different AI providers/models
4. **Web UI**: Edit prompts, variables, and preview rendered output
5. **Template Syntax**: `{{variable}}`, `{{#condition}}...{{/condition}}`, arrays

## Directory Structure

```
./data/prompts/
├── stages/              # Individual prompt templates (.md files)
│   ├── app-detection.md
│   ├── code-analysis.md
│   └── ...
├── variables.json       # Reusable prompt variables
└── stage-config.json    # Stage metadata and provider config
```

## Template Syntax

Templates use Mustache-like syntax:

- `{{variable}}` - Simple variable substitution
- `{{#condition}}...{{/condition}}` - Conditional blocks
- `{{#array}}...{{/array}}` - Array iteration

## API Endpoints

| Route | Description |
|-------|-------------|
| GET /api/prompts | List all prompt stages — `{ stages, systemStages }`, where `systemStages` is the CURATED key list from `server/lib/promptSystemStages.js` that the client badges `SYSTEM` and filters on. It is NOT the delete-protected set, which is wider (see below) |
| GET /api/prompts/:stage | Get stage template |
| PUT /api/prompts/:stage | Update stage/template |
| GET /api/prompts/:stage/usage | Delete-safety report — `{ isSystemStage, usedBy, referencedBy, canDelete, warning }`. `isSystemStage`/`usedBy` come from the curated table; `referencedBy` lists the `server/` sources that name the stage, from the generated `server/lib/promptStageCallSites.generated.json`; `canDelete` is false for either (#3335) |
| DELETE /api/prompts/:stage | Delete a stage. Returns 400 `SYSTEM_STAGE_PROTECTED` without `?force=true` when the stage is curated OR referenced by source |
| POST /api/prompts/:stage/preview | Preview compiled prompt |
| GET /api/prompts/variables | List all variables |
| PUT /api/prompts/variables/:key | Update variable |
| POST /api/prompts/variables | Create variable |
| DELETE /api/prompts/variables/:key | Delete variable |

## UI

- `/prompts` - Prompt Manager with tabs for Stages, Variables, Elements
- Live preview with test variables
- Insert variable references

## Measuring what an agent actually reads

A scheduled task's prompt is assembled in layers — the shipped default, the
pre-step block substitutions, then the operating contract `buildAgentPrompt`
adds (worktree, completion workflow, issue-filing labels) — and the layers are
where duplication hides. Render one end to end and rank its sections by size:

```bash
npm run measure:agent-prompt -- claim-issue tui        # light path: split user/system prompt
npm run measure:agent-prompt -- claim-issue api        # full path: instruction files, memory, tools
npm run measure:agent-prompt -- plan-task cli --out /tmp/plan   # also dump the rendered text
```

It uses placeholder app/reviewer values and no database, so the numbers are the
prompt's own cost. Set `REPO=<checkout>` to point the api path's
instruction-file walk at a real tree. On a Claude Code host the root
`AGENTS.md` is loaded natively on top of this, so its size is part of every
run's budget too.

## Related Features

- [Chief of Staff](./chief-of-staff.md) - Uses prompts for agent briefings
- [Memory System](./memory-system.md) - Uses prompts for memory evaluation
