# Soul System

Digital twin identity scaffold management for creating and testing aligned AI personas.

## Overview

LLMs can embody specific personas, but creating comprehensive identity documents and testing alignment across different models is manual and error-prone. The Soul System provides a structured approach to capturing, validating, and deploying personality models.

## Architecture

- **Digital Twin Service** (`server/services/digitalTwin.js`): Document management, testing, enrichment
- **Digital Twin Routes** (`server/routes/digital-twin.js`): REST API endpoints mounted under `/api/digital-twin/*`
- **Digital Twin Page** (`client/src/pages/DigitalTwin.jsx`): Overview, Documents, Test, Enrich, Export tabs

## Features

### Five-Tab Interface

1. **Overview Tab**: Dashboard showing soul health score, document counts, test scores, enrichment progress, and quick actions
2. **Documents Tab**: Sidebar-based document editor for managing soul markdown files by category (core, audio, behavioral, enrichment)
3. **Test Tab**: Multi-model behavioral testing against 14 predefined tests, with side-by-side result comparison
4. **Enrich Tab**: Guided questionnaire across 10 categories that generates soul document content from answers
5. **Export Tab**: Export soul for use in external LLMs (System Prompt, CLAUDE.md, JSON, individual files)

### CoS Integration

- Soul context automatically injected into agent prompts when enabled
- Settings control `autoInjectToCoS` and `maxContextTokens`
- Prompt template `cos-agent-briefing.md` includes `{{soulSection}}`

## Directory Structure

```
data/digital-twin/
├── meta.json              # Document metadata, test history, settings
├── SOUL.md                # Core identity
├── Expanded.md            # High-fidelity spec
├── BEHAVIORAL_TEST_SUITE.md  # 14 behavioral tests
├── AUDIO*.md              # Audio preferences
├── MEMORIES.md            # Generated via enrichment
├── FAVORITES.md           # Generated via enrichment
└── PREFERENCES.md         # Generated via enrichment
```

## Enrichment Categories

| Category | Description |
|----------|-------------|
| Core Memories | Formative experiences |
| Favorite Books | Books that shaped thinking |
| Favorite Movies | Films that resonate |
| Music Taste | Cognitive infrastructure |
| Communication | How to give/receive info |
| Decision Making | Approach to choices |
| Values | Core principles |
| Aesthetics | Visual preferences |
| Daily Routines | Structure habits |
| Career/Skills | Professional expertise |

### Additional Categories (M33.1)

- **non_negotiables**: Principles and boundaries that define your limits
- **decision_heuristics**: Mental models and shortcuts for making choices
- **error_intolerance**: What your digital twin should never do

## Validation & Analysis

1. **Completeness Validator**: Checks for 6 required sections (identity, values, communication, decision making, non-negotiables, error intolerance), shows percentage complete with actionable suggestions
2. **Contradiction Detector**: AI-powered analysis to find inconsistencies between soul documents, with severity levels and resolution suggestions

## Dynamic Testing

- AI generates behavioral tests based on soul content
- Targets values, communication style, non-negotiables, and decision patterns
- Returns structured tests with prompts, expected behaviors, and failure signals

## Writing Sample Analysis

- Paste writing samples to extract authentic voice patterns
- Analyzes: sentence structure, vocabulary, formality, tone, distinctive markers
- Generates WRITING_STYLE.md document content

## Context Optimization

- **Document Weighting**: Priority slider (1-10) on each document
- Higher weighted documents preserved first when context limits force truncation

## API Endpoints

| Route | Description |
|-------|-------------|
| GET /api/digital-twin | Status summary |
| GET /api/digital-twin/documents | List documents |
| POST /api/digital-twin/documents | Create document |
| PUT /api/digital-twin/documents/:id | Update document |
| DELETE /api/digital-twin/documents/:id | Delete document |
| GET /api/digital-twin/tests | Get test suite |
| POST /api/digital-twin/tests/run | Run single-model tests |
| POST /api/digital-twin/tests/run-multi | Run multi-model tests |
| GET /api/digital-twin/enrich/categories | List enrichment categories |
| POST /api/digital-twin/enrich/question | Get next question |
| POST /api/digital-twin/enrich/answer | Submit answer |
| POST /api/digital-twin/export | Export soul |
| GET /api/digital-twin/validate/completeness | Check soul completeness |
| POST /api/digital-twin/validate/contradictions | Detect contradictions |
| POST /api/digital-twin/tests/generate | Generate dynamic tests |
| POST /api/digital-twin/analyze-writing | Analyze writing samples |

## Related Features

- [Digital Twin](./digital-twin.md) - Quantitative personality modeling
- [Chief of Staff](./chief-of-staff.md) - Uses soul context in agent prompts
