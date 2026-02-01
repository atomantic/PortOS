# Prompt Manager

Customizable AI prompts for all backend AI operations with file-based storage and template rendering.

## Architecture

- **Prompt Service** (`server/services/prompts.js`): Template loading, variable substitution, stage configuration
- **Prompt Routes** (`server/routes/prompts.js`): REST API endpoints
- **Prompt Page** (`client/src/pages/Prompts.jsx`): Stages, Variables, Elements tabs with live preview

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
| GET /api/prompts | List all prompt stages |
| GET /api/prompts/:stage | Get stage template |
| PUT /api/prompts/:stage | Update stage/template |
| POST /api/prompts/:stage/preview | Preview compiled prompt |
| GET /api/prompts/variables | List all variables |
| PUT /api/prompts/variables/:key | Update variable |
| POST /api/prompts/variables | Create variable |
| DELETE /api/prompts/variables/:key | Delete variable |

## UI

- `/prompts` - Prompt Manager with tabs for Stages, Variables, Elements
- Live preview with test variables
- Insert variable references

## Related Features

- [Chief of Staff](./chief-of-staff.md) - Uses prompts for agent briefings
- [Memory System](./memory-system.md) - Uses prompts for memory evaluation
