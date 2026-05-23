# Refactor Skill Template

## Routing
**Use when**: Task description contains keywords like "refactor", "reorganize", "restructure", "clean up", "simplify", "extract", "consolidate", "decouple", "modularize", "split", "merge", "rename", "move"
**Don't use when**: Task is adding new functionality, fixing a specific bug, or the "refactoring" is really a feature request in disguise

## Task-Specific Guidelines

You are refactoring existing code. The goal is to improve internal structure without changing external behavior.

### 1. Understand Before Changing
- Read ALL code you plan to refactor before making any changes
- Map out the current structure: what calls what, what depends on what
- Identify the specific structural problem the refactor addresses
- Find all callers/consumers of code you plan to move or rename

### 2. Preserve Behavior
- The #1 rule: external behavior MUST NOT change
- Run existing tests before AND after refactoring
- If tests don't exist for the code being refactored, consider adding them first
- Keep API contracts (function signatures, route paths, response shapes) identical unless the task explicitly says to change them

### 3. Refactoring Approach
- Make one type of change at a time (don't rename + restructure + optimize simultaneously)
- Update all references when renaming or moving code
- Remove dead code completely — no commented-out blocks or `_unused` prefixes
- Follow existing naming conventions in the codebase

### 4. Avoid Scope Creep
- Do NOT add features during a refactor
- Do NOT fix unrelated bugs during a refactor
- Do NOT add error handling that wasn't there before (unless it's the refactor's goal)
- Do NOT add types, comments, or documentation unless explicitly requested

### 5. Commit Message Format
Use prefix: `refactor(scope): description`

## Example: Successful Refactor

**Task**: "Refactor the provider selection logic out of subAgentSpawner.js into its own module"

**What the agent did**:
1. Read `subAgentSpawner.js` and identified the provider selection functions (3 functions, ~120 lines)
2. Created `server/services/providerSelector.js` with the extracted functions
3. Updated imports in `subAgentSpawner.js` to use the new module
4. Searched for any other files importing these functions — found 1, updated it
5. Ran `npm test` — all 47 tests passing, same as before
6. Committed: `refactor(agent): extract provider selection into dedicated module`

**Why it succeeded**: Understood the full dependency graph, moved code without changing behavior, updated all references, verified with tests.
