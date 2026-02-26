# Security Hardening Audit (2025-02-19)

PortOS is an internal/VPN app so auth, CORS, rate limiting, and HTTPS are out of scope. These items address real bugs, crash risks, and secret leaks that matter regardless of network posture.

**Status: All 10 items resolved.**

## S1: Patch npm dependency CVEs ✅

- All actionable CVEs resolved
- Remaining: 1 low-severity pm2 ReDoS (GHSA-x5gf-qvw8-r2rm, CVSS 4.3) — no fix published by maintainers, not exploitable via PortOS routes
- Client: 0 vulnerabilities

## S2: Sanitize provider API responses ✅

- `sanitizeProvider()` in `server/routes/providers.js` strips `apiKey`, redacts `secretEnvVars` values to `'***'`, returns `hasApiKey: boolean`
- All GET endpoints use sanitization

## S3: Whitelist env vars in PTY shell spawn ✅

- `buildSafeEnv()` in `server/services/shell.js` uses `SAFE_ENV_PREFIXES` allowlist — no `...process.env` spread

## S4: Fix mutex lock bug + extract shared utility ✅

- `createMutex()` in `server/lib/asyncMutex.js` with proper `try/finally`
- Used by both `cos.js` and `memory.js`

## S5: Add Zod validation to Socket.IO events ✅

- `server/lib/socketValidation.js` has Zod schemas for all socket events
- `validateSocketData()` helper used in `socket.js`

## S6: Sanitize error context in Socket.IO broadcasts ✅

- `sanitizeContext()` in `server/lib/errorHandler.js` strips sensitive fields (apikey, token, secret, password, etc.) with circular-reference protection

## S7: Guard unprotected JSON.parse calls ✅

- Replaced bare `JSON.parse` with `safeJSONParse` from `lib/fileUtils.js` in 7 files (8 call sites): `agentContentGenerator.js`, `pm2Standardizer.js`, `automationScheduler.js`, `git.js` (2), `aiDetect.js`, `memoryClassifier.js`, `clinvar.js`
- `digital-twin.js` and `cos.js` were already using `safeJSONParse`

## S8: Add iteration limit to cron parser ✅

- `MAX_CRON_ITERATIONS = 525960` iteration counter in `server/services/eventScheduler.js`
- `validateCronFieldRange()` upfront validation, early `null` return on invalid expressions

## S9: Extract validation boilerplate to helper ✅

- `validateRequest(schema, data)` helper in `lib/validation.js` now used across 80 call sites in 12 route files

## S10: Fix parseInt missing radix ✅

- Fixed 45+ call sites across 18 files (routes, services, client, tests)
