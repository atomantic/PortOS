# Shared AI Library Plan

This document outlines a plan for creating a shared library to DRY up AI provider, model, and prompt template patterns across PortOS-style Express/React/Tailwind projects.

## Problem Statement

Most PortOS-style apps use the same patterns for:
1. **AI Provider Configuration**: CLI and API provider types with models, endpoints, API keys
2. **Model Selection**: Tiered model selection (light/medium/heavy) based on task complexity
3. **Prompt Templates**: Mustache-like templating with variable substitution
4. **Run Execution**: Dual execution system (CLI spawn vs API fetch)
5. **Provider UI Components**: Dropdowns, forms, settings panels

This creates significant code duplication across projects, making maintenance difficult and bug fixes inconsistent.

## Current Implementation Analysis

### Files That Would Move to Shared Library

#### Server-Side (Express)
| File | Purpose | Lines (approx) |
|------|---------|----------------|
| `server/services/providers.js` | Provider CRUD, testing, model refresh | ~300 |
| `server/services/runner.js` | CLI/API run execution, streaming | ~400 |
| `server/lib/validation.js` (partial) | Provider/Run Zod schemas | ~100 |

#### Client-Side (React)
| File | Purpose | Lines (approx) |
|------|---------|----------------|
| `client/src/pages/AIProviders.jsx` | Provider management UI | ~500 |
| `client/src/services/api.js` (partial) | Provider API client functions | ~100 |

#### Shared Patterns
| Pattern | Location | Description |
|---------|----------|-------------|
| Provider Schema | `data.sample/providers.json` | JSON structure for provider configs |
| Prompt Templates | `data/prompts/` | File-based prompt system |
| Model Tiering | `server/services/subAgentSpawner.js` | Task-to-model routing logic |

## Proposed Library Architecture

### Package: `@portos/ai-toolkit`

A modular npm package with the following structure:

```
@portos/ai-toolkit/
├── package.json
├── src/
│   ├── index.js                 # Main exports
│   │
│   ├── server/                  # Express middleware and services
│   │   ├── index.js
│   │   ├── providers.js         # Provider service (CRUD, test, refresh)
│   │   ├── runner.js            # Run execution (CLI/API)
│   │   ├── prompts.js           # Prompt template service
│   │   ├── modelSelector.js     # Tiered model selection logic
│   │   ├── routes/
│   │   │   ├── providers.js     # Express routes for providers
│   │   │   ├── runs.js          # Express routes for runs
│   │   │   └── prompts.js       # Express routes for prompts
│   │   └── validation.js        # Zod schemas
│   │
│   ├── client/                  # React components and hooks
│   │   ├── index.js
│   │   ├── components/
│   │   │   ├── ProviderList.jsx
│   │   │   ├── ProviderForm.jsx
│   │   │   ├── ProviderDropdown.jsx
│   │   │   ├── ModelDropdown.jsx
│   │   │   ├── RunPanel.jsx
│   │   │   └── PromptEditor.jsx
│   │   ├── hooks/
│   │   │   ├── useProviders.js
│   │   │   ├── useRuns.js
│   │   │   └── usePrompts.js
│   │   └── api.js               # API client functions
│   │
│   └── shared/                  # Code used by both server and client
│       ├── types.js             # TypeScript/JSDoc type definitions
│       ├── constants.js         # Shared constants
│       └── utils.js             # Utility functions
│
├── templates/                   # Sample data files
│   ├── providers.sample.json
│   └── prompts/
│       └── stage-config.json
│
└── README.md
```

### Key Design Decisions

#### 1. Modular Imports
Allow importing only what you need:

```javascript
// Server usage
import { providerService, createProviderRoutes } from '@portos/ai-toolkit/server';

// Client usage
import { ProviderDropdown, useProviders } from '@portos/ai-toolkit/client';

// Full bundle
import { server, client } from '@portos/ai-toolkit';
```

#### 2. Configuration-First Design
The library should be configurable via a single config object:

```javascript
// server/index.js
import { createAIToolkit } from '@portos/ai-toolkit/server';

const aiToolkit = createAIToolkit({
  dataDir: './data',                    // Where to store providers.json, prompts/
  providersFile: 'providers.json',      // Provider storage filename
  promptsDir: 'prompts',                // Prompt templates directory

  // Socket.IO integration (optional)
  io: socketIOInstance,

  // Custom model selection logic (optional override)
  modelSelector: (task, provider) => {
    // Custom logic
    return { model: 'custom-model', tier: 'custom', reason: 'custom-logic' };
  },

  // Event hooks (optional)
  hooks: {
    onProviderCreated: (provider) => {},
    onRunStarted: (run) => {},
    onRunCompleted: (run, output) => {},
    onRunFailed: (run, error) => {}
  }
});

// Mount routes
app.use('/api/providers', aiToolkit.routes.providers);
app.use('/api/runs', aiToolkit.routes.runs);
app.use('/api/prompts', aiToolkit.routes.prompts);

// Access services directly if needed
const provider = await aiToolkit.services.providers.getById('my-provider');
```

#### 3. Tailwind Design Token Support
Components should accept a theme prop for custom design tokens:

```jsx
import { ProviderDropdown } from '@portos/ai-toolkit/client';

<ProviderDropdown
  theme={{
    bg: 'port-card',
    border: 'port-border',
    accent: 'port-accent',
    text: 'white',
    textMuted: 'gray-400'
  }}
  value={selectedProvider}
  onChange={setSelectedProvider}
/>
```

Or use CSS variables:

```css
:root {
  --ai-toolkit-bg: #1a1a1a;
  --ai-toolkit-border: #2a2a2a;
  --ai-toolkit-accent: #3b82f6;
}
```

#### 4. Dependency Injection for Storage
Allow custom storage backends:

```javascript
const aiToolkit = createAIToolkit({
  storage: {
    // Default: JSON file storage
    type: 'json',
    dataDir: './data'
  }
  // Or custom implementation
  storage: {
    type: 'custom',
    adapter: myDatabaseAdapter  // Must implement ProviderStorage interface
  }
});
```

#### 5. No Try/Catch (Per Project Guidelines)
All functions should let errors bubble up. The consuming app handles errors via its own middleware.

## Component Specifications

### Server Components

#### `providerService`

```javascript
// Core CRUD
getAllProviders()              // Returns { activeProvider, providers }
getProviderById(id)            // Returns provider or null
getActiveProvider()            // Returns active provider
setActiveProvider(id)          // Sets active provider
createProvider(data)           // Creates new provider
updateProvider(id, data)       // Updates provider
deleteProvider(id)             // Deletes provider (with fallback logic)

// Testing & Refresh
testProvider(id)               // Tests CLI command or API endpoint
refreshProviderModels(id)      // Fetches models from API endpoint

// Vision
checkVisionHealth(id)          // Tests vision capability
```

#### `runnerService`

```javascript
createRun(options)             // Creates run metadata
executeCliRun(run, io)         // Spawns CLI provider
executeApiRun(run, io)         // Calls API endpoint
stopRun(runId)                 // Terminates running process
getRuns(limit, offset, source) // Lists run history
getRunOutput(runId)            // Gets run output
getRunPrompt(runId)            // Gets run prompt
```

#### `promptService`

```javascript
getStages()                    // Lists all prompt stages
getStage(name)                 // Gets stage config + template
updateStage(name, data)        // Updates stage
previewStage(name, variables)  // Renders template with variables
getVariables()                 // Lists all variables
createVariable(key, data)      // Creates variable
updateVariable(key, data)      // Updates variable
deleteVariable(key)            // Deletes variable
```

#### `modelSelector`

```javascript
selectModelForTask(task, provider) // Returns { model, tier, reason }

// Default tiers:
// - heavy: Critical, visual, complex reasoning, long context
// - medium: Standard coding tasks (default)
// - light: Documentation-only tasks (never for coding)
```

### Client Components

#### `<ProviderDropdown />`

```jsx
<ProviderDropdown
  value={providerId}
  onChange={(id) => setProviderId(id)}
  filter={(p) => p.enabled}           // Optional filter
  showType={true}                     // Show CLI/API badge
  placeholder="Select provider..."
/>
```

#### `<ModelDropdown />`

```jsx
<ModelDropdown
  providerId={providerId}
  value={model}
  onChange={(m) => setModel(m)}
  showTiers={true}                    // Show light/medium/heavy badges
/>
```

#### `<ProviderForm />`

```jsx
<ProviderForm
  provider={editingProvider}          // null for create mode
  onSubmit={(data) => saveProvider(data)}
  onCancel={() => setEditing(null)}
/>
```

#### `<RunPanel />`

```jsx
<RunPanel
  providerId={selectedProvider}
  model={selectedModel}
  onRunComplete={(run) => refreshHistory()}
/>
```

#### `<PromptEditor />`

```jsx
<PromptEditor
  stage={selectedStage}
  variables={variables}
  onSave={(template) => saveStage(template)}
/>
```

### Hooks

#### `useProviders()`

```javascript
const {
  providers,          // Provider list
  activeProvider,     // Currently active provider
  isLoading,
  error,
  refetch,
  setActive,          // Set active provider
  testProvider,       // Test connectivity
  refreshModels       // Refresh API models
} = useProviders();
```

#### `useRuns(options)`

```javascript
const {
  runs,
  isLoading,
  error,
  createRun,
  stopRun,
  deleteRun,
  refetch
} = useRuns({ limit: 50, source: 'devtools' });
```

## Migration Strategy

### Phase 1: Extract & Package (Week 1-2)
1. Create new npm package repository
2. Extract server services (providers, runner, prompts)
3. Extract validation schemas
4. Write unit tests for all services
5. Publish as `@portos/ai-toolkit@0.1.0`

### Phase 2: Client Components (Week 2-3)
1. Extract React components
2. Create hooks for data fetching
3. Add Storybook for component documentation
4. Ensure Tailwind theme compatibility
5. Publish `@portos/ai-toolkit@0.2.0`

### Phase 3: Integration & Testing (Week 3-4)
1. Update PortOS to use the package
2. Test all AI-related functionality
3. Document breaking changes
4. Create migration guide
5. Publish `@portos/ai-toolkit@1.0.0`

### Phase 4: Multi-Project Adoption (Week 4+)
1. Update other PortOS-style projects
2. Collect feedback
3. Iterate on API design
4. Maintain backward compatibility

## API Compatibility

The library maintains API compatibility with the current PortOS implementation:

| Current Endpoint | Library Route | Notes |
|------------------|---------------|-------|
| `GET /api/providers` | Same | No change |
| `PUT /api/providers/active` | Same | No change |
| `POST /api/providers/:id/test` | Same | No change |
| `POST /api/providers/:id/refresh-models` | Same | No change |
| `GET /api/runs` | Same | No change |
| `POST /api/runs` | Same | No change |
| `GET /api/prompts` | Same | No change |

## Configuration Schema

```javascript
const defaultConfig = {
  // Data storage
  dataDir: './data',
  providersFile: 'providers.json',
  promptsDir: 'prompts',
  runsDir: 'runs',

  // Defaults
  defaultTimeout: 300000,        // 5 minutes
  maxConcurrentRuns: 5,

  // Model selection
  modelSelector: defaultModelSelector,

  // Prompt templating
  templateEngine: 'mustache',    // or 'handlebars'

  // API settings
  defaultTemperature: 0.1,
  streamingEnabled: true,

  // Vision support
  visionEnabled: true,
  maxImageSize: 10 * 1024 * 1024, // 10MB

  // Logging
  logLevel: 'info',
  logPrefix: '[AI-Toolkit]'
};
```

## Extensibility Points

### Custom Provider Types
Projects can register custom provider types beyond CLI and API:

```javascript
aiToolkit.registerProviderType('mcp', {
  execute: async (provider, prompt, options) => {
    // Custom MCP server execution
  },
  test: async (provider) => {
    // Test MCP connection
  },
  refreshModels: async (provider) => {
    // Fetch available tools/models
  }
});
```

### Custom Model Selection
Override the default tiered selection:

```javascript
const aiToolkit = createAIToolkit({
  modelSelector: (task, provider) => {
    // Always use opus for this project
    return { model: 'claude-opus-4-5-20251101', tier: 'heavy', reason: 'project-default' };
  }
});
```

### Event Hooks
Subscribe to lifecycle events:

```javascript
aiToolkit.on('run:started', (run) => {
  analytics.track('ai_run_started', { provider: run.providerId });
});

aiToolkit.on('run:completed', (run, output) => {
  usage.recordTokens(run.providerId, estimateTokens(output));
});
```

## Testing Strategy

### Unit Tests
- Each service function tested in isolation
- Mock file system operations
- Mock HTTP requests for API providers
- Mock child_process for CLI providers

### Integration Tests
- Full route testing with supertest
- Real file system operations in temp directory
- Actual CLI execution with mock provider

### Component Tests
- React Testing Library for all components
- Hook testing with @testing-library/react-hooks
- Snapshot tests for UI consistency

## Documentation

### README.md
- Quick start guide
- Installation instructions
- Basic usage examples
- Configuration reference

### API Reference
- Full JSDoc comments on all exports
- TypeScript declarations for IDE support
- Inline code examples

### Storybook
- Interactive component playground
- Props documentation
- Theme customization examples

### Migration Guide
- Step-by-step migration from current implementation
- Breaking changes list
- Code diff examples

## Success Metrics

1. **Code Reduction**: 50%+ reduction in AI-related code per project
2. **Bug Fix Propagation**: Fixes in library apply to all projects
3. **Onboarding Time**: New projects get AI features in <30 minutes
4. **Test Coverage**: >80% coverage on library code
5. **Documentation**: Complete API reference and examples

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking changes affect multiple projects | Semantic versioning, deprecation warnings |
| Performance overhead from abstraction | Benchmark critical paths, optimize hot paths |
| Tailwind class conflicts | Use CSS custom properties, scoped class prefixes |
| Different project requirements | Extensible configuration, escape hatches |
| Maintenance burden | Clear ownership, automated testing, documentation |

## Next Steps

1. **Review this plan** with stakeholders
2. **Create the package repository** at `github.com/atomantic/portos-ai-toolkit`
3. **Start Phase 1** with server-side extraction
4. **Track progress** in the package's PLAN.md

---

*Created: 2026-01-10*
*Status: Draft - Awaiting Review*
