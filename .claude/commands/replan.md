# Replan Command

You are tasked with reviewing and updating the PLAN.md file and ALL documentation to keep them clean, current, and action-oriented. You also generate new work items when the backlog is depleted.

## Your Responsibilities

### 1. Review PLAN.md Structure
- Read the entire PLAN.md file
- Identify completed milestones (marked with [x]) that have detailed documentation
- Identify sections that should be moved to permanent documentation
- Check if Next Actions section has actionable items remaining

### 2. Extract Documentation from Completed Work
For each completed milestone with substantial documentation:
- Determine the appropriate docs file (ARCHITECTURE.md, API.md, PM2.md, TROUBLESHOOTING.md, etc.)
- Extract the detailed documentation sections
- Move them to the appropriate docs file with proper formatting
- If creating a new docs file, follow the existing docs structure

**Files to consider:**
- `docs/ARCHITECTURE.md` - System design, data flow, services architecture
- `docs/API.md` - API endpoints, schemas, WebSocket events
- `docs/PM2.md` - PM2 patterns and process management
- `docs/PORTS.md` - Port allocation and conventions
- `docs/VERSIONING.md` - Version format, release process
- `docs/GITHUB_ACTIONS.md` - CI/CD workflow patterns
- `docs/CONTRIBUTING.md` - Code guidelines, git workflow
- `docs/TROUBLESHOOTING.md` - Common issues and solutions
- `docs/features/*.md` - Individual feature documentation

### 3. Clean Up PLAN.md
After moving documentation:
- Replace detailed milestone documentation with a brief summary (1-3 sentences)
- Add a reference link to the docs file where details were moved
- Keep the milestone checklist status ([x] for completed)
- Remove redundant or outdated information
- Keep the Quick Reference section up to date

**Example transformation:**
```markdown
Before:
- [x] M16: Memory System

### Architecture
- **Memory Service** (`server/services/memory.js`): Core CRUD, search, and lifecycle operations
- **Embeddings Service** (`server/services/memoryEmbeddings.js`): LM Studio integration
[... 50 more lines of detailed docs ...]

After:
- [x] M16: Memory System - Semantic memory with vector embeddings for CoS agent context. See [Memory System](./docs/features/memory-system.md)
```

### 4. Maintain All Documentation Files
Review and update ALL docs files to ensure accuracy:

**Core Documentation:**
- `docs/ARCHITECTURE.md` - Verify system diagrams match current implementation
- `docs/API.md` - Ensure all endpoints are documented with current schemas
- `docs/PM2.md` - Check PM2 patterns match ecosystem.config.cjs
- `docs/PORTS.md` - Verify port allocations are current
- `docs/VERSIONING.md` - Confirm version process is accurate
- `docs/GITHUB_ACTIONS.md` - Check CI/CD workflows match .github/workflows/
- `docs/CONTRIBUTING.md` - Verify code guidelines match CLAUDE.md
- `docs/TROUBLESHOOTING.md` - Add any new issues discovered

**Feature Documentation (`docs/features/`):**
- Cross-reference each feature doc with its implementation
- Update API tables if endpoints changed
- Add new features that lack documentation
- Remove docs for features that were removed

**Maintenance Tasks:**
1. Run `ls docs/` and `ls docs/features/` to see all doc files
2. For each doc, check if it references current file paths
3. Verify code examples still work
4. Update version numbers if mentioned
5. Ensure internal links between docs are valid

### 5. Update Documentation Index
- Ensure the Documentation section in PLAN.md lists all docs files
- Add any new docs files you created
- Verify all links are correct

### 6. Focus on Next Actions
At the end of PLAN.md:
- Add a "## Next Actions" section if it doesn't exist
- List 5-8 concrete next steps based on:
  - Incomplete milestones
  - Recent git commits
  - Areas that need attention
  - Documentation gaps
  - Test coverage gaps
- Make these action items specific and actionable

### 7. Generate New Work When Backlog is Depleted
If the Next Actions list is nearly empty (fewer than 3 items) or all items are completed:

**Discovery Methods:**
1. **Analyze Recent Commits**: Run `git log --oneline -20` to see recent work and identify follow-up tasks
2. **Check Test Coverage**: Look for untested or under-tested code areas
3. **Review TODOs**: Run `grep -r "TODO\|FIXME\|HACK" server/ client/src/ --include="*.js" --include="*.jsx"` to find inline tasks
4. **Audit Dependencies**: Check for outdated packages with `npm outdated`
5. **Security Scan**: Identify potential security improvements
6. **Performance Opportunities**: Look for optimization targets
7. **UX Polish**: Identify UI/UX improvements needed
8. **Documentation Gaps**: Find undocumented features or outdated docs
9. **Code Quality**: Identify refactoring opportunities (duplication, complexity)
10. **Feature Roadmap**: Review COS-GOALS.md for mission-aligned features

**New Work Categories to Consider:**
- **Technical Debt**: Code cleanup, refactoring, removing deprecated patterns
- **Testing**: Unit tests, integration tests, E2E tests
- **Performance**: Caching, query optimization, bundle size
- **Security**: Input validation, auth hardening, dependency updates
- **Accessibility**: ARIA labels, keyboard navigation, screen reader support
- **Documentation**: API docs, user guides, architecture diagrams
- **DevEx**: Better error messages, logging improvements, dev tooling
- **Features**: New functionality aligned with project goals

**Output Format for New Items:**
```markdown
## Next Actions

1. **[Category] Brief Title** - Detailed description of what needs to be done and why
2. **[Category] Brief Title** - Detailed description...
...
```

**Prioritization:**
- Security issues → Critical priority
- Broken functionality → High priority
- Technical debt → Medium priority
- Polish/nice-to-have → Low priority

### 8. Commit Your Changes
After reorganizing:
- Use `/gitup` to commit changes with a clear message like:
  ```
  docs: reorganize PLAN.md and update documentation

  - Moved M## documentation to docs/features/
  - Updated docs/API.md with new endpoints
  - Updated PLAN.md to focus on next actions
  - Generated new work items
  ```

## Guidelines

- **Be thorough**: Read all completed milestones and assess documentation value
- **Be surgical**: Only move substantial documentation (>20 lines), keep brief summaries in PLAN
- **Be organized**: Group related content in docs files with clear headings
- **Be consistent**: Match the style and format of existing docs files
- **Be helpful**: Make it easy to find information by adding clear references
- **Be proactive**: Always ensure there are 5+ actionable next items
- **Be comprehensive**: Review ALL docs, not just PLAN.md

## Example Output Structure

After running `/replan`, the PLAN.md should have:
```markdown
# Port OS - Implementation Plan

## Quick Reference
[... existing quick reference ...]

### Milestones
- [x] M0-M15: Core features complete - See [ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- [x] M16: Memory System - See [Memory System](./docs/features/memory-system.md)
- [x] M17-M32: Advanced features - See respective docs
- [ ] M33: Next feature...

### Documentation
- [Architecture Overview](./docs/ARCHITECTURE.md)
- [API Reference](./docs/API.md)
- [Memory System](./docs/features/memory-system.md)
- [Brain System](./docs/features/brain-system.md)
- [...more docs...]

## Next Actions

1. **[Feature] Complete M7 Templates** - Implement template management UI and app scaffolding
2. **[Testing] Add Soul Service Tests** - Cover edge cases in soul document management
3. **[Security] Dependency Audit** - Run npm audit and update vulnerable packages
4. **[Docs] Update API.md** - Add missing /api/soul/* endpoints
5. **[Performance] Optimize Memory Search** - Profile and improve BM25 index performance
6. **[DevEx] Improve Error Messages** - Add context to validation errors in routes
7. **[Feature] Memory Consolidation** - Implement automatic memory deduplication
8. **[Polish] Mobile Navigation** - Fix responsive layout issues on smaller screens
```

## Notes

- Don't delete information - move it to appropriate docs files
- Keep API endpoint tables consolidated in API.md
- Keep architectural diagrams and data flow in ARCHITECTURE.md
- Create feature-specific docs in docs/features/ for complex systems
- Preserve all historical information but organize it better
- Update CLAUDE.md if any commands or conventions changed
- Always leave the project with 5+ actionable Next Actions items
- Review ALL docs files each time, not just those related to recent work
- Check for broken internal links between docs
- Ensure code examples in docs still match current implementation
- Update version references if they've changed
- Add new discoveries from TODOs/FIXMEs to Next Actions
- Cross-reference COS-GOALS.md for mission-aligned work generation
