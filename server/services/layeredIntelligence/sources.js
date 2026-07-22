/**
 * Layered Intelligence — source gathering I/O (#2842 split of layeredIntelligence.js).
 *
 * Reads each configured source (planned work, files, HTTP, shell, LI task metrics)
 * with injectable deps so tests drive them without a live filesystem, network or
 * forge CLI. Also owns the shared `runCli` primitive used by the forge filer.
 */

import { join, resolve, relative, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { realpath } from 'fs/promises';
import { tryReadFile, readJSONFile, PATHS } from '../../lib/fileUtils.js';
import { bufferedSpawn } from '../../lib/bufferedSpawn.js';
import { fetchPublicText } from '../../lib/safeUrlFetch.js';
import { validateCommand } from '../../lib/commandSecurity.js';
import { getSettings } from '../settings.js';
import { computeWindowedStats } from '../taskLearning/store.js';
import {
  PLANNED_WORK_LABEL, PLANNED_WORK_NONE, PLANNED_WORK_UNAVAILABLE_PREFIX,
  PLANNED_WORK_MAX_ITEMS, PLANNED_WORK_MAX_CHARS, LI_TASK_TYPE,
} from './constants.js';
import { computeScopeAwareness } from './awareness.js';
import { listForgeIssues, extractIssuePriority } from './forgeFiler.js';
import { listJiraIssues, plannedWorkJql } from './jiraFiler.js';

// ---------------------------------------------------------------------------
// I/O layer — gather + filers. Injectable deps keep these testable.
// ---------------------------------------------------------------------------


/**
 * Why a planned-work read came back empty-handed. Rendered INSTEAD of a listing so
 * a failed tracker read can never be mistaken for "this app has nothing planned" —
 * the two are opposite instructions to the reasoner (be conservative vs. the field
 * is wide open), and collapsing them is exactly the failure the sentinel rule in
 * CLAUDE.md exists to prevent.
 */
export function plannedWorkUnavailable(why) {
  return `${PLANNED_WORK_UNAVAILABLE_PREFIX} (${why}). Do NOT treat this as "nothing is planned" — this app may well have a committed backlog that simply could not be listed this run. Be conservative: prefer proposal: null over filing work that might already be in scope.`;
}

/**
 * Whether a gathered plannedWork string is an actual LISTING of committed work —
 * i.e. something the reasoner can be told to go read — as opposed to one of the
 * two sentinels ("nothing is planned" / "could not be read"). Both sentinels are
 * meaningful in the prompt and still render, but neither is a backlog: telling
 * the reasoner its proposals "may be overlapping with committed work — review the
 * plannedWork source above" directly beneath a block stating no planned work
 * exists is a contradiction that just biases it toward filing nothing.
 */
export function hasPlannedWorkListing(plannedWork) {
  if (typeof plannedWork !== 'string') return false;
  const text = plannedWork.trim();
  if (!text || text === PLANNED_WORK_NONE) return false;
  return !text.startsWith(PLANNED_WORK_UNAVAILABLE_PREFIX);
}

/**
 * Render a planned-work item list into the prompt block. Pure.
 *
 * Reports the count of everything it was HANDED even when the rendered list is
 * truncated to `maxItems`, so the reasoner knows it is seeing the top of a larger
 * backlog rather than all of it — 15 shown out of 100 must not read as "there are
 * only 15". Note the caller's own read is capped too (the tracker lists cap at
 * 100), so on a very large backlog this count is itself a floor, not a census.
 */
export function formatPlannedWork(items, { maxItems = PLANNED_WORK_MAX_ITEMS, maxChars = PLANNED_WORK_MAX_CHARS } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(i => i && typeof i === 'object' && (i.title || i.number != null));
  if (list.length === 0) return PLANNED_WORK_NONE;
  const top = list.slice(0, maxItems);
  const lines = top.map(i => {
    const ref = i.number != null ? `#${i.number} ` : '';
    const meta = [
      i.priority ? `priority: ${i.priority}` : null,
      Array.isArray(i.labels) && i.labels.length ? `labels: ${i.labels.join(', ')}` : null
    ].filter(Boolean).join('; ');
    return `- ${ref}${(i.title || '').trim()}${meta ? ` (${meta})` : ''}`;
  });
  const header = list.length > top.length
    ? `${list.length} items of actively-planned work the user has already committed to (showing the top ${top.length}):`
    : `${list.length} item(s) of actively-planned work the user has already committed to:`;
  return [header, ...lines].join('\n').slice(0, maxChars);
}

/**
 * Extract a PLAN.md's UNCHECKED (`- [ ]`) items — the plan tracker's equivalent of
 * a `plan`-labeled issue. A `- [x]` item is finished work, not committed-and-
 * pending, so it is excluded: proposing something already done is a different
 * (and already-handled) problem than proposing something already scheduled.
 */
export function extractPlannedPlanItems(planContent) {
  if (typeof planContent !== 'string') return [];
  const items = [];
  const re = /^[ \t]*[-*][ \t]+\[ \][ \t]*(\S.*)$/gm;
  let m;
  while ((m = re.exec(planContent))) {
    const title = m[1].replace(/\s+/g, ' ').trim();
    if (title) items.push({ number: null, title: title.slice(0, 200), labels: [], priority: null });
  }
  return items;
}

/**
 * Gather the app's actively-planned work — the backlog the user has ALREADY
 * committed to — so the reasoner can cross-reference a proposal against it before
 * filing (#2698). A deterministic tracker read: files + `gh`/`glab`/Jira REST, and
 * NO LLM call (the no-cold-bootstrap rule).
 *
 * Returns a prompt-ready string, or `null` when the source does not apply at all
 * (an unresolvable tracker: no forge CLI, no Jira coords, no repo path) — three
 * distinct states, never collapsed:
 *   - `null`                     → nothing to say; buildPrompt omits the block
 *   - `plannedWorkUnavailable()` → the read FAILED; be conservative
 *   - a listing / PLANNED_WORK_NONE → the read SUCCEEDED and is trustworthy
 *     (a plan-tracked app with no PLAN.md at all is a real PLANNED_WORK_NONE)
 *
 * Deps are injectable so tests drive every branch without a live tracker.
 */
export async function gatherPlannedWork({
  filer,
  forgeCli,
  cwd,
  jira,
  listForge = listForgeIssues,
  listJira = listJiraIssues,
  readFileFn = tryReadFile
} = {}) {
  if (filer === 'forge' && forgeCli && cwd) {
    const { ok, issues } = await listForge({ cli: forgeCli, cwd, label: PLANNED_WORK_LABEL, state: 'open' });
    if (!ok) return plannedWorkUnavailable(`the ${forgeCli} issue list failed`);
    // gh honors --state open, but glab's label list can still surface a closed
    // issue depending on version — re-filter so a done item never reads as pending.
    const open = issues.filter(i => i.state === 'open');
    return formatPlannedWork(open.map(i => ({
      number: i.number,
      title: i.title,
      labels: i.labels || [],
      priority: extractIssuePriority(i.labels)
    })));
  }

  if (filer === 'jira' && jira?.instanceId && jira?.projectKey) {
    const { ok, issues } = await listJira({
      instanceId: jira.instanceId,
      projectKey: jira.projectKey,
      jql: plannedWorkJql(jira.projectKey),
      // Jira's priority field is not in searchIssues' default `fields` set — ask
      // for it explicitly, or every item would report a null priority.
      searchOptions: { fields: 'summary,status,labels,updated,description,resolutiondate,priority' }
    });
    if (!ok) return plannedWorkUnavailable('the Jira search failed');
    const open = issues.filter(i => i.state === 'open');
    return formatPlannedWork(open.map(i => ({
      number: i.number,
      title: i.title,
      labels: i.labels || [],
      // Prefer Jira's real priority field; fall back to a priority-ish label.
      priority: i.priority || extractIssuePriority(i.labels)
    })));
  }

  if (filer === 'plan' && cwd) {
    const planPath = join(cwd, 'PLAN.md');
    // No PLAN.md at all is a real "nothing is planned" for a plan-tracked app —
    // distinguish it from a PLAN.md that EXISTS but could not be read (a genuine
    // failure), which tryReadFile's null would otherwise conflate.
    if (!existsSync(planPath)) return PLANNED_WORK_NONE;
    const content = await readFileFn(planPath);
    if (typeof content !== 'string') return plannedWorkUnavailable('PLAN.md exists but could not be read');
    return formatPlannedWork(extractPlannedPlanItems(content));
  }

  return null;
}

/**
 * Gather the enabled Layer-1 sources for one app into a `{ key: string }` map.
 * Deterministic reads only (files + CoS metric JSON + tracker lists); NO LLM calls.
 * Missing files degrade to omitted keys, never throws. `openIssues` is gathered
 * separately by the handler (it shells out to the forge). `tracker`
 * (`{ filer, forgeCli, cwd, jira }`, resolved by the caller) enables the
 * plannedWork source — absent, that source is simply skipped.
 */
export async function gatherSources(app, config, { cosPath = PATHS.cos, trustShellSources, tracker = null, isPortos = false } = {}) {
  const out = {};
  const src = config.sources || {};
  const repo = app.repoPath;

  // Resolve the install-level shell-trust opt-in lazily and once — only when a
  // `cmd` source is actually present — so apps with no shell sources never read
  // settings. Injected value (tests) wins; otherwise fall back to settings.json.
  let trustShell = trustShellSources;
  const resolveTrustShell = async () => {
    if (trustShell === undefined) trustShell = await getTrustShellSources();
    return trustShell;
  };

  if (src.goals && repo) {
    const goals = await tryReadFile(join(repo, 'GOALS.md'));
    if (goals) out.goals = goals.slice(0, 8000);
  }
  if (src.appMetrics && repo) {
    // The app's own success/performance metrics doc (the METRICS.md convention,
    // see docs/METRICS.md) — where a managed app records what "performing well"
    // means. Absent → omitted (the reasoner may then propose adding one).
    const metrics = await tryReadFile(join(repo, 'METRICS.md'));
    if (metrics) out.appMetrics = metrics.slice(0, 8000);
  }
  if (src.planMd && repo) {
    const plan = await tryReadFile(join(repo, 'PLAN.md'));
    if (plan) out.planMd = plan.slice(0, 8000);
  }
  if (src.healthReport && repo) {
    const health = await tryReadFile(join(repo, 'HEALTH_REPORT.md'));
    if (health) out.healthReport = health.slice(0, 8000);
  }
  if (src.plannedWork && tracker) {
    // The committed backlog (#2698). Unlike the file sources above, an EMPTY or
    // FAILED result still emits a key — each renders a distinct sentence, and
    // both are meaningful instructions to the reasoner (see gatherPlannedWork).
    const planned = await gatherPlannedWork(tracker);
    if (planned) out.plannedWork = planned.slice(0, PLANNED_WORK_MAX_CHARS);
  }
  if (src.cosMetrics) {
    // This install's own autonomous-agent run stats (per task type), NOT scoped to
    // the app being analyzed — see the default-config note for the PortOS-vs-managed
    // rationale (default-off for managed apps).
    const learning = await readJSONFile(join(cosPath, 'learning.json'), null);
    if (learning?.byTaskType) {
      // Surface BOTH the lifetime rate (the cumulative dashboard/telemetry truth)
      // AND a recency-windowed rate (issue #2460) per task type, labeled distinctly
      // so the reasoner doesn't conflate them. The windowed rate lets a
      // since-resolved failure burst age out of the "is work needed" signal instead
      // of permanently depressing it; `recentSuccessRate` is null when there are no
      // in-window runs, in which case the reasoner leans on the lifetime rate.
      // Note the intentional rename: computeWindowedStats' internal `windowed*`
      // fields are surfaced to the reasoner as `recent*` (reads more naturally in
      // the prompt context) — same concept, deliberately different label here.
      const summary = {};
      for (const [type, m] of Object.entries(learning.byTaskType)) {
        const windowed = computeWindowedStats(m?.recentOutcomes);
        summary[type] = {
          lifetimeSuccessRate: typeof m?.successRate === 'number' ? m.successRate : null,
          lifetimeCompleted: m?.completed || 0,
          recentSuccessRate: windowed.windowedSuccessRate,
          recentCompleted: windowed.windowedCompleted,
          avgDurationMs: m?.avgDurationMs || 0
        };
      }
      out.cosMetrics = JSON.stringify(summary).slice(0, 4000);
      // Scope-awareness guidance (#2760): a deterministic low/high-completion split
      // derived from the SAME per-type rates above, so the reasoner gets an interpreted
      // signal alongside the raw JSON instead of being asked to spot the pattern itself.
      // Rendered as its own prompt block (see buildPrompt). Gated on isPortos (codex P2):
      // these are THIS install's own CoS completion rates, meaningless to a managed app —
      // and a managed app CAN enable the cosMetrics source, so the cosMetrics toggle
      // alone is not the PortOS boundary. buildPrompt re-checks isPortos as defense in
      // depth; deriving it here only for PortOS also avoids the wasted work.
      if (isPortos) {
        const scopeGuidance = computeScopeAwareness({ metricsByType: summary });
        if (scopeGuidance) out.scopeGuidance = scopeGuidance;
      }
    }
  }
  for (const custom of src.custom || []) {
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
      const content = await fetchHttpSource(custom.url);
      if (content) out[key] = content.slice(0, 8000);
    } else if (custom.type === 'cmd' && typeof custom.cmd === 'string' && repo) {
      const content = await runShellCommand(custom.cmd, { cwd: repo, trustShellSources: await resolveTrustShell() });
      if (content) out[key] = content.slice(0, 8000);
    }
  }
  return out;
}

/**
 * Read the LI loop's OWN agent-run metrics out of the CoS learning store (#2700).
 * Deterministic file read; no LLM call. Feeds computeSelfEvalSummary's execution-
 * health signal.
 *
 * Returns a discriminated result rather than a bare bucket-or-null, because the two
 * empty cases are NOT the same fact and the reasoner is told them differently:
 *   `{ read: false, metrics: null }` — the store is missing/unreadable/malformed:
 *                                      we do not know how LI's runs are going.
 *   `{ read: true,  metrics: null }` — the store is fine, LI has simply never run.
 *   `{ read: true,  metrics: {...} }` — real history.
 * Collapsing these to one `null` would let "cannot read the store" masquerade as
 * "healthy loop with no history" (or vice versa) — the sentinel rule.
 */
export async function readLiTaskMetrics({ cosPath = PATHS.cos } = {}) {
  const file = join(cosPath, 'learning.json');
  // An ABSENT store is a fresh install, not a broken read: learning.json is created
  // lazily on the first recorded task outcome. readJSONFile returns its default for
  // ENOENT, I/O errors, and parse failures ALIKE, so leaning on it alone would tell
  // every fresh install "your learning store could not be read" when the truth is
  // "nothing has run here yet" — the exact conflation this function exists to
  // prevent, just inverted. Check existence first so the two stay distinct.
  if (!existsSync(file)) return { read: true, metrics: null };
  const learning = await readJSONFile(file, null);
  const byTaskType = learning?.byTaskType;
  if (!byTaskType || typeof byTaskType !== 'object' || Array.isArray(byTaskType)) {
    return { read: false, metrics: null };
  }
  const bucket = byTaskType[LI_TASK_TYPE];
  return {
    read: true,
    metrics: (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) ? bucket : null
  };
}

/**
 * Stable map key for a custom source. Namespaced by type so a `file` ref and an
 * `http` url that share a string can't collide, and so the prompt's source block
 * labels are self-describing. Returns null for a malformed/unknown source.
 */
export function customSourceKey(custom) {
  if (!custom || typeof custom !== 'object') return null;
  if (custom.type === 'file' && custom.ref) return `custom:${custom.ref}`;
  if (custom.type === 'http' && custom.url) return `custom:http:${custom.url}`;
  if (custom.type === 'cmd' && custom.cmd) return `custom:cmd:${custom.cmd}`;
  return null;
}

/**
 * Fetch an http(s) custom source for the loop's prompt. Deterministic read, no
 * LLM. Rejects any non-http(s) scheme (defense in depth over the Zod refine),
 * bounds the request with a 10s timeout, and returns null on any failure so a
 * dead URL just omits the key rather than throwing.
 *
 * SSRF-guarded via `fetchPublicText` (default posture): loopback, link-local,
 * and the cloud-metadata endpoint (127.0.0.1, 169.254.169.254,
 * metadata.google.internal, ::1) are blocked so a hand-edited/hostile config
 * can't exfiltrate them into the reasoner prompt, and redirects are revalidated
 * against the same gate. LAN/private hosts (Tailscale peers, a home wiki) stay
 * ALLOWED intentionally — PortOS is a single-user tool where a custom source
 * legitimately points at the home network, and the URL is operator-configured.
 * `throwOnUnsafe: false` makes a blocked host omit the key like any other dead
 * URL instead of bubbling a 400. `fetchText` is injectable for tests.
 */
export async function fetchHttpSource(url, { timeoutMs = 10_000, fetchText = fetchPublicText } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const text = await fetchText(url, { timeoutMs, throwOnUnsafe: false }).catch(() => null);
  return text || null;
}

/**
 * THREAT MODEL — a `cmd` custom source is attacker-reachable persistent config.
 *
 * The `sources.custom` array lives in each app's stored `layeredIntelligence`
 * config, written through the validated `PUT /api/apps/:id` route. A `cmd` entry
 * is executed here on the Layered Intelligence SCHEDULE (Engine-B autonomous job),
 * with the PortOS process's own privileges and cwd = the app repo. So any path
 * that can land a string in that config (a hand-edited config, a hostile sync
 * payload, a future config-writing feature, an XSS-driven same-origin POST) gets
 * *persistent, unattended* code execution — not a one-shot the operator watched.
 *
 * Historically this ran the full command string with `shell: true`, capped only
 * by length + a 15s timeout. That is arbitrary RCE: `; rm -rf ~`, `$(curl … | sh)`,
 * pipes to `sh`, etc. all execute. Issue #2515.
 *
 * Defense: by default we DENY the shell. The command is parsed and checked
 * against the shared binary allowlist (`validateCommand` in commandSecurity.js —
 * same gate the manual command runner uses), which rejects shell metacharacters
 * (`;|&$(){}` …) and any binary not on the allowlist, then we spawn the base
 * binary with parsed args and `shell: false` — so no shell ever interprets the
 * string. A non-allowlisted / metacharacter command is dropped (key omitted) with
 * a warning, exactly like any other failed source read.
 *
 * Escape hatch: an operator who genuinely needs a pipeline (`git log … | head`)
 * can set the install-level `settings.layeredIntelligence.trustShellSources`
 * flag, which restores the full `shell: true` behavior for THIS install only.
 * It is an explicit, install-wide opt-in — off by default — so a fresh install
 * (or a synced-in app config) can never execute an un-allowlisted command.
 *
 * `exec` is injectable for tests; `trustShellSources` is resolved by the caller
 * (`gatherSources`) from install settings and threaded in.
 *
 * Returns null on rejection / non-zero exit / timeout / no output so a failing or
 * denied command just omits the source key rather than throwing.
 */
export async function runShellCommand(cmd, { cwd, timeoutMs = 15_000, exec = bufferedSpawn, trustShellSources = false } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (trustShellSources) {
    // Operator has explicitly opted this install into full-shell custom sources.
    const { code, stdout } = await exec(cmd, [], { cwd, timeoutMs, shell: true });
    if (code !== 0) return null;
    return (stdout || '').trim() || null;
  }
  const check = validateCommand(cmd);
  if (!check.valid) {
    console.warn(`⚠️ Layered Intelligence: custom cmd source "${cmd}" rejected — ${check.error} (enable settings.layeredIntelligence.trustShellSources to allow arbitrary shell commands)`);
    return null;
  }
  const { code, stdout } = await exec(check.baseCommand, check.args, { cwd, timeoutMs, shell: false });
  if (code !== 0) return null;
  return (stdout || '').trim() || null;
}

/**
 * Resolve the install-level "trust shell sources" opt-in from settings.json.
 * `null`/absent/non-true all read as OFF (the safe default) — only an explicit
 * `true` unlocks full-shell custom `cmd` sources. Injectable read for tests.
 */
export async function getTrustShellSources(read = getSettings) {
  const settings = await read();
  return settings?.layeredIntelligence?.trustShellSources === true;
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
