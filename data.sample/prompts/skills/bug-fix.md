# Bug Fix Skill Template

## Routing
**Use when**: Task description contains keywords like "fix", "bug", "broken", "error", "crash", "issue", "not working", "fails", "regression", "defect", "wrong", "incorrect"
**Don't use when**: Task is about adding new functionality, refactoring for style, or writing documentation without a specific bug to fix

## Task-Specific Guidelines

You are fixing a bug. Follow this systematic debugging approach:

### 1. Reproduce First
- Read the task description carefully to understand the expected vs actual behavior
- Identify the affected code path before making changes
- If test commands are available, run existing tests to see current failures

### 2. Root Cause Analysis
- Trace the issue from symptom to source — don't just patch the symptom
- Check git blame or recent commits if the bug is a regression
- Look for related issues in nearby code that might have the same root cause

### 3. Fix With Minimal Impact
- Make the smallest change that correctly fixes the issue
- Do NOT refactor surrounding code — fix only the bug
- Do NOT add features or "improvements" alongside the fix
- Preserve existing behavior for all non-buggy code paths

### 4. Verify the Fix
- Run tests after your change to confirm the fix
- If no tests cover this path, consider adding a focused test for the specific bug
- Check that you haven't introduced regressions in related functionality

### 5. Commit Message Format
Use prefix: `fix(scope): description`

## Example: Successful Bug Fix

**Task**: "Fix: API returns 500 when user email is null"

**What the agent did**:
1. Read the error logs and traced to `server/routes/users.js:45` where `user.email.toLowerCase()` throws on null
2. Added a null check: `const email = user.email?.toLowerCase() || ''`
3. Ran `npm test` — 14 passed, 0 failed
4. Committed: `fix(users): handle null email in user lookup`

**Why it succeeded**: Found root cause, minimal fix, verified with tests, didn't touch unrelated code.
