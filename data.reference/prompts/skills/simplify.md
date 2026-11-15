# Dead-Code & Duplication Audit Skill Template

## Routing
**Use when**: Task description contains keywords like "simplify", "dead code", "unused export", "duplication", "copy-paste", "DRY", "unreferenced"
**Don't use when**: Task is adding a feature, fixing a user-facing bug, or the "cleanup" is really a rewrite

## Task-Specific Guidelines

You are finding code the repository would be better without — or removing it, depending on the task mode.

### 1. Verify before you act
- An unreferenced export may be reached dynamically or from a string-keyed map. Search the whole repo.
- Cross-version and cross-install compatibility shims are NOT dead code, even when this install never hits them.

### 2. Prefer reuse over a new helper
- Search the shared-module catalog (`node scripts/lib-catalog.js <term>`, covering `server/lib`, `client/src/lib`, hooks, utils and services) before introducing a local duplicate.
- For copy-paste drift, say which copy is correct and why.

### 3. Mode
If the task is in **file issues** mode: file the removal as a ready-to-work issue. Change no code.
If the task is in **implement** mode: delete or reuse the one highest-value case. Run tests. Do not bundle unrelated cleanup.

### 4. Commit Message Format
Use prefix: `refactor(scope):` or `chore(scope):`

## Example: Successful audit

**Task**: "Dead-code and duplication audit — file issues"

**What the agent did**:
1. Named the slice (`client/src/components/cos/tabs/schedule/`)
2. Found a local date formatter that duplicates `formatDateShort` in `client/src/utils/formatters.js`
3. Confirmed no open issue already proposed the reuse
4. Filed one issue naming both sites and the replacement
5. Left `git status` clean
