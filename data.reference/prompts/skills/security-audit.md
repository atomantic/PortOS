# Security Audit Skill Template

## Routing
**Use when**: Task description contains keywords like "security", "audit", "vulnerability", "xss", "injection", "owasp", "cve", "penetration", "hardening", "sanitize", "escape", "auth", "authentication", "authorization", "permissions"
**Don't use when**: Task is about general code quality, performance optimization, or adding features unrelated to security

## Task-Specific Guidelines

You are performing a security audit or fixing security issues. Follow this thorough approach:

### 1. Scope the Audit
- Identify which components are in scope (routes, services, client, dependencies)
- Focus on OWASP Top 10 categories relevant to this codebase:
  - **Injection**: SQL/NoSQL/command injection in user inputs
  - **XSS**: Unescaped user content rendered in HTML/React
  - **Broken Auth**: Missing or weak authentication/authorization checks
  - **Sensitive Data**: Secrets in code, logs, or responses
  - **Misconfiguration**: Permissive CORS, missing headers, debug endpoints
  - **Command Injection**: Shell command construction from user input

### 2. Audit Methodology
- Check all route handlers for input validation (Zod schemas)
- Verify the command allowlist in shell execution paths
- Scan for hardcoded secrets, API keys, or credentials
- Check file path handling for directory traversal
- Review CORS and security header configuration
- Examine WebSocket message handling for injection

### 3. Reporting Format
For each finding, document:
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW / INFO
- **Location**: File path and line number
- **Issue**: What the vulnerability is
- **Impact**: What an attacker could do
- **Fix**: Specific remediation with code example

### 4. Fix Priority
- CRITICAL/HIGH: Fix immediately in this task
- MEDIUM: Fix if straightforward, otherwise document
- LOW/INFO: Document only, don't change code

### 5. Commit Message Format
Use prefix: `security(scope): description`

## Example: Successful Security Audit

**Task**: "Audit the API routes for injection vulnerabilities"

**What the agent did**:
1. Scanned all route files in `server/routes/` for input handling
2. Found 2 issues:
   - HIGH: `req.query.name` used directly in file path without sanitization (`server/routes/files.js:23`)
   - MEDIUM: Missing rate limiting on auth endpoint
3. Fixed the HIGH issue by adding path validation against directory traversal
4. Documented the MEDIUM issue in task notes
5. Ran tests to verify fix didn't break functionality
6. Committed: `security(routes): sanitize file path input to prevent directory traversal`

**Why it succeeded**: Systematic scan, prioritized fixes, documented what wasn't fixed, verified no regressions.
