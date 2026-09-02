# Module Hygiene Audit Skill Template

## Routing
**Use when**: The task is explicitly a module-hygiene audit or remediation run.
**Don't use when**: The task only removes dead code, fixes an unrelated defect, or asks for a broad rewrite without evidence.

## Task-Specific Guidelines

Improve structural maintainability without treating code size as a defect.

### 1. Thresholds nominate; evidence decides
- Use complexity, function length, nesting, file size, churn, and fan-in to select candidates.
- Keep a finding only after tracing responsibilities, callers, tests, and history to a concrete change cost.
- Reject primarily declarative, generated, compatibility, mirror, and semantic-adapter false positives.

### 2. Prove reuse discovery
- Search the repository's own catalogs, domain maps, public exports, naming variants, and importers.
- Record why an existing module should be extended or why a new public seam is necessary.
- Prefer consolidation that deletes a duplicate implementation over a wrapper that preserves both.

### 3. Match discovery to the surface
- Curate and parity-check a catalog only for a genuinely reusable/public surface.
- Prefer lightweight ownership and placement guidance for broad implementation directories.
- Never require exhaustive catalogs or barrels merely because a directory is large.

### 4. De-duplicate across history
- Search open and closed tracker work plus merged changes by file, symbol, and behavior.
- Link or reuse sibling simplification or code-quality work instead of filing it again under a new label.

### 5. Mode
In file-issues mode, change no source and file only decision-complete findings. In implementation mode, make one behavior-preserving improvement in the isolated worktree and verify it at the highest practical public boundary.

## Successful Outcome

The run names its bounded slice and reuse searches, reports what it rejected, and produces zero to three high-confidence findings normally. A well-supported no-finding result is successful.
