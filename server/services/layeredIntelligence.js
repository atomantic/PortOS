/**
 * Layered Intelligence Loop — deterministic backbone.
 *
 * A perpetual, per-managed-app self-improvement loop (Engine B autonomous script
 * job). On a schedule the handler reads each enabled app's goals + telemetry,
 * asks a reasoning model (default: local LLM) for the single most-valuable
 * improvement, and this module's DETERMINISTIC helpers file that as a tracker
 * issue (GitHub / GitLab / Jira / PLAN.md) for a coding agent to pick up later.
 *
 * The reasoning model never touches code — it returns structured JSON only; every
 * side effect (dedup, scope-gating, pause, filing) is deterministic handler code
 * so the "model must not make direct code changes" contract holds by construction.
 *
 * The pure helpers (config defaults, scope-gating, slug/dedup, pause resolution,
 * reasoner-output validation, prompt building, filer dispatch) are side-effect-free
 * and unit-tested. The I/O functions (gather, forge/jira/plan filers) take injectable
 * deps so tests can drive them without a live LLM, `gh`, or filesystem.
 *
 * See docs/plans/2026-07-07-layered-intelligence-loop.md for the full design.
 */

import { spawn } from 'child_process';
import { join, resolve, relative, isAbsolute } from 'path';
import { readFile, writeFile, appendFile, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { DAY, tryReadFile, readJSONFile, safeJSONParse, PATHS } from '../lib/fileUtils.js';

// Tracker labels + slug marker. The slug is the stable dedup key the reasoner
// chooses; it is embedded in each filed issue body so a later run (or the
// reasoner reading open issues) can self-avoid duplicates.
export const LI_LABEL = 'layered-intelligence';
export const LI_BLOCKING_LABEL = 'layered-intelligence:blocking';

// Closed issues carrying a matching slug suppress a re-proposal for this long,
// so the loop doesn't immediately re-file something the user just resolved.
export const CLOSED_SUPPRESSION_MS = 30 * DAY;

// Every proposal scope the reasoner may return. The handler enforces WHERE each
// lands (see PROPOSAL_SCOPE_TARGETS) and gates meta/self scopes to PortOS only.
export const PROPOSAL_SCOPES = ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self'];

// Scopes that may only be filed when the sweeping app IS the PortOS install
// itself (they extend / improve the loop, which lives in the PortOS repo).
export const PORTOS_ONLY_SCOPES = ['loop-meta', 'portos-self'];

/**
 * The default per-app config. PortOS (isPortos) additionally gets the meta/self
 * scopes so the loop can extend itself; every other app is capped at its own
 * improvement + data-gap scopes. Off by default — the loop is a user-enabled
 * scheduled automation (AI-provider "no cold-bootstrap" policy).
 */
export function defaultLayeredIntelligenceConfig(isPortos = false) {
  return {
    enabled: false,
    intervalMs: DAY,
    providerId: null,
    model: null,
    sources: {
      goals: true,
      cosMetrics: true,
      healthReport: true,
      planMd: true,
      openIssues: true,
      custom: []
    },
    rules: '',
    allowedScopes: isPortos
      ? ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self']
      : ['app-improvement', 'app-data-gap']
  };
}

/**
 * Merge an app record's stored `layeredIntelligence` over the defaults so a
 * partial config (or none) still yields a complete, safe config. `sources` is
 * merged one level deep so a stored `{ sources: { goals: false } }` doesn't wipe
 * the other source toggles.
 */
export function getEffectiveConfig(app) {
  const isPortos = !!app?.isPortos;
  const base = defaultLayeredIntelligenceConfig(isPortos);
  const stored = (app?.layeredIntelligence && typeof app.layeredIntelligence === 'object' && !Array.isArray(app.layeredIntelligence))
    ? app.layeredIntelligence
    : {};
  const merged = { ...base, ...stored };
  merged.sources = {
    ...base.sources,
    ...(stored.sources && typeof stored.sources === 'object' ? stored.sources : {})
  };
  if (!Array.isArray(merged.sources.custom)) merged.sources.custom = [];
  if (!Array.isArray(merged.allowedScopes)) merged.allowedScopes = base.allowedScopes;
  return merged;
}

/**
 * Whether a proposal scope is allowed for this app. A hallucinated or
 * hand-edited scope cannot escape this gate: it must be a recognized scope, be
 * in the app's `allowedScopes`, and — for meta/self scopes — the app must BE the
 * PortOS install. Double-enforced regardless of what the prompt told the model.
 */
export function isScopeAllowed({ scope, allowedScopes = [], isPortos = false }) {
  if (!PROPOSAL_SCOPES.includes(scope)) return false;
  if (PORTOS_ONLY_SCOPES.includes(scope) && !isPortos) return false;
  return allowedScopes.includes(scope);
}

/** The HTML-comment slug marker embedded in a filed issue/ticket body. */
export function slugMarker(slug) {
  return `<!-- lil-slug: ${slug} -->`;
}

/** Extract a `lil-slug` marker's value from a body string (null if absent). */
export function extractSlugFromBody(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/<!--\s*lil-slug:\s*([a-z0-9][a-z0-9-]*)\s*-->/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Normalize a reasoner-chosen slug to a stable kebab id. Returns null for a
 * non-string or an input that reduces to empty (so a bad slug is a no-op, never
 * a mystery label).
 */
export function normalizeSlug(slug) {
  if (typeof slug !== 'string') return null;
  const norm = slug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return norm || null;
}

/**
 * Deterministic dedup guard. Given the slug of the proposed item and the live
 * tracker's existing issues (each `{ slug, state, closedAt }`), suppress the
 * proposal when a match is open, OR closed within CLOSED_SUPPRESSION_MS.
 *
 * `slug` matching is case-insensitive on the normalized slug. `existingIssues`
 * may carry either a parsed `slug` or a raw `body`/`title` we extract from.
 */
export function isProposalDuplicate({ slug, existingIssues = [], now = Date.now() }) {
  const target = normalizeSlug(slug);
  if (!target) return false;
  for (const issue of existingIssues) {
    const issueSlug = issue.slug
      ? normalizeSlug(issue.slug)
      : extractSlugFromBody(issue.body) || extractSlugFromBody(issue.title);
    if (issueSlug !== target) continue;
    const state = (issue.state || '').toLowerCase();
    if (state === 'open') return true;
    // Closed within the suppression window still suppresses.
    const closedAt = issue.closedAt ? Date.parse(issue.closedAt) : NaN;
    if (Number.isFinite(closedAt) && now - closedAt <= CLOSED_SUPPRESSION_MS) return true;
    // Closed long ago (or unknown close time treated as long ago) → allow re-file.
  }
  return false;
}

/**
 * Whether the app is currently PARKED — i.e. has at least one OPEN blocking
 * issue. When parked, the sweep skips the app entirely (no gather, no reason),
 * resuming automatically once the blocking issue closes. Fully tracker-derived.
 */
export function isAppParked(blockingIssues = []) {
  return blockingIssues.some(i => (i.state || '').toLowerCase() === 'open');
}

/**
 * Validate + normalize the reasoner's JSON. Returns
 * `{ analysis, proposal, pause }` with invalid pieces dropped (never throws):
 *   - `proposal` kept only when it has a recognized scope + a normalizable slug
 *     + a non-empty title. `slug` is normalized in place.
 *   - `pause` kept only when it has a reason AND a resolvable target: an integer
 *     issue number, or `"this"` WITH a surviving proposal to block on. A
 *     `pause.blockOnIssue: "this"` with a null proposal is invalid → dropped.
 */
export function validateReasonerResponse(parsed) {
  const out = { analysis: '', proposal: null, pause: null };
  if (!parsed || typeof parsed !== 'object') return out;
  if (typeof parsed.analysis === 'string') out.analysis = parsed.analysis;

  const p = parsed.proposal;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const slug = normalizeSlug(p.slug);
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (PROPOSAL_SCOPES.includes(p.scope) && slug && title) {
      out.proposal = {
        scope: p.scope,
        slug,
        title,
        body: typeof p.body === 'string' ? p.body : '',
        value: typeof p.value === 'string' ? p.value : ''
      };
    }
  }

  const pause = parsed.pause;
  if (pause && typeof pause === 'object' && !Array.isArray(pause)) {
    const reason = typeof pause.reason === 'string' ? pause.reason.trim() : '';
    const target = pause.blockOnIssue;
    const isThis = target === 'this';
    const num = Number.isInteger(target) ? target : (typeof target === 'string' && /^\d+$/.test(target) ? Number(target) : null);
    // "this" requires a surviving proposal to block on; else an explicit issue number.
    if (reason && ((isThis && out.proposal) || num)) {
      out.pause = { blockOnIssue: isThis ? 'this' : num, reason };
    }
  }
  return out;
}

/**
 * Resolve `pause.blockOnIssue` to a concrete issue number. `"this"` maps to the
 * number of the issue just filed from the proposal; an integer passes through.
 * Returns null when it can't resolve (e.g. `"this"` but nothing was filed).
 */
export function resolveBlockOnIssue(pause, filedIssueNumber) {
  if (!pause) return null;
  if (pause.blockOnIssue === 'this') return filedIssueNumber ?? null;
  return Number.isInteger(pause.blockOnIssue) ? pause.blockOnIssue : null;
}

/**
 * Which filing path a resolved work tracker uses. Branches the handler up front
 * so a `plan` app never hits the forge-only label/issue paths.
 *   github / gitlab → 'forge'   (gh / glab issue create + labels)
 *   jira            → 'jira'     (createTicket + description slug marker)
 *   plan (fallback) → 'plan'     (append slug-tagged PLAN.md checklist item)
 */
export function filerForTracker(resolved) {
  if (resolved === 'github' || resolved === 'gitlab') return 'forge';
  if (resolved === 'jira') return 'jira';
  return 'plan';
}

/** Whether a resolved tracker supports pause (an issue to block on). `plan` doesn't. */
export function trackerSupportsPause(resolved) {
  return filerForTracker(resolved) !== 'plan';
}

/**
 * Build the JSON-only reasoning prompt for one app. Deterministic: given the
 * gathered sources, open issues, and config, produces the exact string sent to
 * the model. Meta/self scopes are only offered when the app is PortOS.
 */
export function buildPrompt({ app, config, sources = {}, openIssues = [], isPortos = false }) {
  const allowed = (config.allowedScopes || []).filter(s =>
    isScopeAllowed({ scope: s, allowedScopes: config.allowedScopes, isPortos })
  );
  const scopeLines = allowed.map(s => `  - ${s}`).join('\n');
  const sourceBlocks = Object.entries(sources)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `### ${k}\n${v.trim()}`)
    .join('\n\n');
  const openList = openIssues.length
    ? openIssues.map(i => `- #${i.number ?? '?'} [${i.slug || extractSlugFromBody(i.body) || 'no-slug'}] ${i.title || ''}`).join('\n')
    : '(none)';

  return `You are the Layered Intelligence reasoner for the app "${app.name}". Analyze the app's goals and telemetry and decide the SINGLE highest-value improvement to propose this run — signal, not noise. You never write code; you return structured JSON that a deterministic system files as ONE tracker issue.

Rules & guidance from the operator:
${config.rules?.trim() || '(none)'}

Allowed proposal scopes (you MUST pick one of these for any proposal):
${scopeLines || '  (none — return proposal: null)'}
${isPortos ? '' : 'Note: meta/self scopes are unavailable on this app; frame any data need as an "app-data-gap" against this app.\n'}
Already-open tracked issues (DO NOT duplicate these — reuse their slug only if genuinely the same work):
${openList}

Gathered sources:
${sourceBlocks || '(no sources available — you may propose an app-data-gap to add telemetry)'}

Respond with JSON only (no markdown fences):
{
  "analysis": "brief reasoning summary",
  "proposal": {              // null if nothing worth filing this run
    "scope": "<one allowed scope>",
    "slug": "kebab-stable-id",
    "title": "short imperative title",
    "body": "markdown detail for the coding agent",
    "value": "why this is the single highest-value item now"
  },
  "pause": {                 // null if not pausing
    "blockOnIssue": "this" or <existing issue number>,
    "reason": "why the loop should pause on this app until resolved"
  }
}`;
}

// ---------------------------------------------------------------------------
// I/O layer — gather + filers. Injectable deps keep these testable.
// ---------------------------------------------------------------------------

/** Run a CLI, resolving `{ code, stdout, stderr }` (never rejects). */
function runCli(cmd, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('close', code => done({ code, stdout, stderr }));
    child.on('error', err => done({ code: -1, stdout: '', stderr: err.message }));
  });
}

/**
 * Run a user-authored `cmd` telemetry source through the shell in the app repo,
 * resolving `{ code, stdout, stderr }` (never rejects). Time-boxed so a hanging
 * command can't stall the whole sweep; output clamping is the caller's job. Runs
 * with `shell: true` on purpose — the operator authors the command (e.g.
 * `git log --oneline -20`), consistent with the app's existing free-form
 * startCommands/buildCommand (single trusted operator). cwd confines it to the
 * app repo.
 */
export function runShellCommand(cmd, { cwd, timeoutMs = 15000, maxBytes = 8000 } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, { shell: true, cwd, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL' });
    let stdout = '', stderr = '', capped = false;
    // Cap stdout WHILE streaming and kill the child once we have enough — a runaway
    // or endless command (`yes`, a looping metrics script) would otherwise buffer
    // gigabytes into memory before the timeout fires. The gathered telemetry is
    // sliced to maxBytes anyway, so a killed-at-cap command still yields usable
    // output; report code 0 in that case so the caller keeps the truncated result.
    child.stdout?.on('data', d => {
      if (capped) return;
      stdout += d.toString();
      if (stdout.length >= maxBytes) { stdout = stdout.slice(0, maxBytes); capped = true; child.kill('SIGKILL'); }
    });
    child.stderr?.on('data', d => { if (stderr.length < maxBytes) stderr += d.toString(); });
    child.on('close', code => done({ code: capped ? 0 : code, stdout, stderr }));
    child.on('error', err => done({ code: -1, stdout: '', stderr: err.message }));
  });
}

/**
 * Fetch an `http` telemetry source, returning its response body text or null
 * (never throws — a dead/slow/erroring endpoint degrades to an omitted source).
 * Time-boxed GET, follows redirects; a non-2xx response is treated as no data.
 * `fetchImpl` is injectable so tests never hit the network.
 */
export async function fetchHttpSource(url, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Keep the abort timer armed across BOTH the fetch AND the body read: a server
  // that returns headers fast but then dribbles (or never finishes) the body would
  // otherwise hang res.text() forever if we cleared the timer on fetch-resolve. The
  // signal aborts the body stream too, so a stalled read rejects → caught → null.
  const text = await (async () => {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!res || !res.ok || typeof res.text !== 'function') return null;
    return res.text();
  })().catch(() => null);
  clearTimeout(timer);
  return typeof text === 'string' ? text : null;
}

/**
 * The stable `out` key for a custom telemetry source: `custom:<label|ref|url|cmd>`.
 * Prefers an operator-provided `label`, else the type's identifying field. Returns
 * null for an unrecognized/empty source (a no-op, never a mystery key).
 */
export function customSourceKey(custom) {
  if (!custom || typeof custom !== 'object') return null;
  const label = typeof custom.label === 'string' ? custom.label.trim() : '';
  const base = label
    || (custom.type === 'file' ? custom.ref
      : custom.type === 'http' ? custom.url
        : custom.type === 'cmd' ? custom.cmd
          : null);
  return (typeof base === 'string' && base.trim()) ? `custom:${base}` : null;
}

/**
 * Gather the enabled Layer-1 sources for one app into a `{ key: string }` map.
 * Deterministic reads only (files + CoS metric JSON); NO LLM calls. Missing
 * files degrade to omitted keys, never throws. `openIssues` is gathered
 * separately by the handler (it shells out to the forge).
 */
export async function gatherSources(app, config, { cosPath = PATHS.cos, fetchImpl = globalThis.fetch, runCommand = runShellCommand } = {}) {
  const out = {};
  const src = config.sources || {};
  const repo = app.repoPath;

  if (src.goals && repo) {
    const goals = await tryReadFile(join(repo, 'GOALS.md'));
    if (goals) out.goals = goals.slice(0, 8000);
  }
  if (src.planMd && repo) {
    const plan = await tryReadFile(join(repo, 'PLAN.md'));
    if (plan) out.planMd = plan.slice(0, 8000);
  }
  if (src.healthReport && repo) {
    const health = await tryReadFile(join(repo, 'HEALTH_REPORT.md'));
    if (health) out.healthReport = health.slice(0, 8000);
  }
  if (src.cosMetrics) {
    const learning = await readJSONFile(join(cosPath, 'learning.json'), null);
    if (learning?.byTaskType) {
      out.cosMetrics = JSON.stringify(learning.byTaskType).slice(0, 4000);
    }
  }
  for (const custom of src.custom || []) {
    if (!custom || typeof custom !== 'object') continue;
    const key = customSourceKey(custom);
    if (!key) continue;
    if (custom.type === 'file' && typeof custom.ref === 'string' && repo) {
      const safe = await confineToRepo(repo, custom.ref);
      if (!safe) {
        console.warn(`⚠️ Layered Intelligence: custom source "${custom.ref}" escapes repo — skipped`);
        continue;
      }
      const content = await tryReadFile(safe);
      if (content) out[key] = content.slice(0, 8000);
    } else if (custom.type === 'http' && typeof custom.url === 'string') {
      const text = await fetchHttpSource(custom.url, { fetchImpl });
      if (text && text.trim()) out[key] = text.slice(0, 8000);
      else console.warn(`⚠️ Layered Intelligence: custom http source "${custom.url}" returned no data — skipped`);
    } else if (custom.type === 'cmd' && typeof custom.cmd === 'string' && repo) {
      const { code, stdout, stderr } = await runCommand(custom.cmd, { cwd: repo });
      if (code === 0 && stdout.trim()) out[key] = stdout.slice(0, 8000);
      else console.warn(`⚠️ Layered Intelligence: custom cmd source exited ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''} — skipped`);
    }
  }
  return out;
}

/**
 * Confine a custom file `ref` to within `repo` so a hostile/hand-edited config
 * can't read arbitrary files into the LLM prompt. Returns the safe absolute path,
 * or null when it escapes. Guards BOTH lexical traversal (`..` / absolute) AND
 * symlink escape — a symlink inside the repo pointing outside is resolved via
 * realpath and rejected. Missing files return null (nothing to read).
 */
export async function confineToRepo(repo, ref) {
  const abs = resolve(repo, ref);
  const rel = relative(repo, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  // Resolve symlinks on both sides; a link inside the repo that points outside
  // is caught here (lexical check above only sees the link's own path).
  const realRepo = await realpath(repo).catch(() => null);
  const realAbs = await realpath(abs).catch(() => null);
  if (!realRepo || !realAbs) return null;
  const realRel = relative(realRepo, realAbs);
  if (realRel.startsWith('..') || isAbsolute(realRel)) return null;
  return realAbs;
}

/**
 * Normalize a forge issue state to `open` / `closed`. GitLab reports `opened`
 * (and `closed`/`locked`); GitHub reports `open`/`closed`. Anything that isn't a
 * recognized closed/locked state is treated as open so dedup + park don't miss a
 * GitLab-`opened` issue. (`merged` never applies to issues.)
 */
export function normalizeIssueState(state) {
  const s = (state || '').toLowerCase();
  if (s === 'closed' || s === 'locked') return 'closed';
  return 'open';
}

/**
 * List existing layered-intelligence issues on a forge (open + recently closed)
 * so the handler can feed them to the reasoner and run the dedup guard.
 *
 * Returns `{ ok, issues }` — `ok:false` means the tracker read FAILED (CLI error
 * or unparseable output), which is NOT the same as "no existing issues" (`ok:true,
 * issues:[]`). The handler must NOT file when the read failed, or a transient
 * `gh` blip would defeat dedup and file a duplicate (CLAUDE.md sentinel rule).
 */
export async function listForgeIssues({ cli, cwd, env, exec = runCli } = {}) {
  const args = cli === 'glab'
    ? ['issue', 'list', '--label', LI_LABEL, '--all', '-P', '100', '-F', 'json']
    : ['issue', 'list', '--label', LI_LABEL, '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,closedAt'];
  const { code, stdout } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { ok: false, issues: [] };
  if (!stdout.trim()) return { ok: true, issues: [] };
  const parsed = safeJSONParse(stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: parsed.map(i => ({
      number: i.number ?? i.iid ?? null,
      title: i.title || '',
      body: i.body || i.description || '',
      state: normalizeIssueState(i.state),
      closedAt: i.closedAt || i.closed_at || null,
      slug: extractSlugFromBody(i.body || i.description || '') || extractSlugFromBody(i.title || '')
    }))
  };
}

/**
 * List OPEN blocking-labeled issues for the app (park check). Returns
 * `{ ok, issues }` with the same failed-vs-empty distinction as listForgeIssues.
 */
export async function listBlockingIssues({ cli, cwd, env, exec = runCli } = {}) {
  const args = cli === 'glab'
    ? ['issue', 'list', '--label', LI_BLOCKING_LABEL, '-P', '100', '-F', 'json']
    : ['issue', 'list', '--label', LI_BLOCKING_LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title,state'];
  const { code, stdout } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { ok: false, issues: [] };
  if (!stdout.trim()) return { ok: true, issues: [] };
  const parsed = safeJSONParse(stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: parsed.map(i => ({
      number: i.number ?? i.iid ?? null,
      title: i.title || '',
      state: normalizeIssueState(i.state)
    }))
  };
}

/**
 * Ensure the layered-intelligence labels exist before the first `issue create`
 * (gh/glab both fail creating an issue with a non-existent label). Idempotent —
 * `--force` (gh) / re-create (glab) is a no-op when the label already exists.
 */
export async function ensureForgeLabels({ cli, cwd, env, exec = runCli } = {}) {
  const labels = [
    { name: LI_LABEL, color: '1d76db', desc: 'Filed by the Layered Intelligence loop' },
    { name: LI_BLOCKING_LABEL, color: 'b60205', desc: 'Layered Intelligence loop is paused on this issue' }
  ];
  for (const l of labels) {
    if (cli === 'glab') {
      await exec(cli, ['label', 'create', '--name', l.name, '--color', `#${l.color}`, '--description', l.desc], { cwd, env });
    } else {
      await exec(cli, ['label', 'create', l.name, '--color', l.color, '--description', l.desc, '--force'], { cwd, env });
    }
  }
}

/**
 * File ONE proposal issue on a forge (gh/glab). Ensures labels first, embeds the
 * slug marker in the body, and returns `{ success, number, url }`. The issue
 * number is parsed from the created URL's trailing digits.
 */
export async function fileProposalToForge({ cli, cwd, env, title, body, slug, exec = runCli } = {}) {
  await ensureForgeLabels({ cli, cwd, env, exec });
  const fullBody = `${body}\n\n${slugMarker(slug)}`;
  const args = cli === 'glab'
    ? ['issue', 'create', '--title', title, '--description', fullBody, '--label', LI_LABEL]
    : ['issue', 'create', '--title', title, '--body', fullBody, '--label', LI_LABEL];
  const { code, stdout, stderr } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { success: false, error: stderr || `${cli} exited with code ${code}` };
  const urlMatch = stdout.trim().match(/(https?:\/\/\S+)/);
  const url = urlMatch ? urlMatch[1] : stdout.trim();
  const numMatch = url.match(/(\d+)\s*$/);
  return { success: true, number: numMatch ? Number(numMatch[1]) : null, url };
}

/** Apply the blocking label to an existing issue (pause). Returns `{ success }`. */
export async function applyBlockingLabel({ cli, cwd, env, number, exec = runCli } = {}) {
  if (!Number.isInteger(number)) return { success: false, error: 'no issue number' };
  const args = cli === 'glab'
    ? ['issue', 'update', String(number), '--label', LI_BLOCKING_LABEL]
    : ['issue', 'edit', String(number), '--add-label', LI_BLOCKING_LABEL];
  const { code, stderr } = await exec(cli, args, { cwd, env });
  return code === 0 ? { success: true } : { success: false, error: stderr };
}

/**
 * Append a slug-tagged proposal to the app's PLAN.md (the `plan` tracker path).
 * Dedups by scanning for the `[lil-<slug>]` tag. Creates PLAN.md with a heading
 * + `## Next Up` section if absent. Returns `{ success, duplicate }`.
 */
export async function appendProposalToPlan({ repoPath, appName, slug, title, body } = {}) {
  const planPath = join(repoPath, 'PLAN.md');
  const tag = `[lil-${slug}]`;
  const existing = existsSync(planPath) ? await readFile(planPath, 'utf-8').catch(() => '') : '';
  if (existing.includes(tag)) return { success: true, duplicate: true };

  const oneLine = (body || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const item = `- [ ] ${tag} **${title}** ${oneLine}`.trim();

  if (!existing) {
    const content = `# ${appName} — Development Plan\n\n## Next Up\n\n${item}\n`;
    await writeFile(planPath, content);
    return { success: true, duplicate: false };
  }
  const nextUpRe = /(##\s+Next Up[^\n]*)(\n?)/;
  if (nextUpRe.test(existing)) {
    // Insert right after the "## Next Up" heading line, normalizing the heading's
    // line ending first so a file that ENDS at `## Next Up` (no trailing newline)
    // gets the item on its own line rather than a second section appended below.
    const updated = existing.replace(nextUpRe, `$1\n${item}\n`);
    await writeFile(planPath, updated.endsWith('\n') ? updated : `${updated}\n`);
    return { success: true, duplicate: false };
  }
  // No Next Up section — append one.
  const sep = existing.endsWith('\n') ? '' : '\n';
  await appendFile(planPath, `${sep}\n## Next Up\n\n${item}\n`);
  return { success: true, duplicate: false };
}

/** Scan a PLAN.md string for existing `[lil-<slug>]` tags → array of slugs. */
export function extractPlanSlugs(planContent) {
  if (typeof planContent !== 'string') return [];
  const slugs = [];
  const re = /\[lil-([a-z0-9][a-z0-9-]*)\]/gi;
  let m;
  while ((m = re.exec(planContent))) slugs.push(m[1].toLowerCase());
  return slugs;
}
