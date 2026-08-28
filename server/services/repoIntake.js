/**
 * Post-clone intake for a GitHub repo captured into the Brain.
 *
 * When a bare GitHub repo URL is captured (Quick Capture / the Inbox capture
 * box), the link is cloned in the background. The user can tick two opt-in boxes
 * at capture time to have a CoS agent pick the clone up once it lands:
 *
 *   - `malwareScan` → the read-only `/do:scan` audit, identical to the Links
 *     tab's per-link Scan button (both go through `queueMalwareScan` here).
 *   - `learn`       → a `repo-study` review: read the clone as a PRODUCT — its
 *     features, design, and user-facing behavior — and file the feature ideas
 *     and enhancements PortOS should adopt into its configured work tracker.
 *     Code organization and other meta-programming observations are out of
 *     scope (that is what `reference-watch` and the code-quality audits are
 *     for). Clean-room — propose reimplementation, never copy upstream code.
 *     Its optional provider/model/effort pins travel with the stored request.
 *
 * Both are queued only AFTER the clone succeeds (there is nothing to read
 * before that), and only because the user asked for them in the same request —
 * see the AI Provider Usage Policy in AGENTS.md.
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { posix } from 'path';
import * as cos from './cos.js';
import { getAppById, PORTOS_APP_ID } from './apps.js';
import { prepareScanReportDirectory, reportPathForId } from './malwareScanReports.js';
import { resolveTrackerFilingBlock } from '../lib/workTracker.js';
import { GENERIC_REPO_STUDY_LABEL_CONTRACT } from '../lib/dispatchLabels.js';
import { normalizeRepoIntake } from '../lib/repoIntakeActions.js';

/** `owner/repo` when the link carries GitHub metadata, else its display title. */
const repoLabel = (link) => (
  link?.gitHubOwner && link?.gitHubRepo
    ? `${link.gitHubOwner}/${link.gitHubRepo}`
    : (link?.title || link?.url || 'unknown repo')
);

/**
 * True when the link's recorded clone is readable on disk. Both actions read the
 * clone, so neither may queue an agent against a path that was never written or
 * has since been deleted.
 */
const isCloneReadable = (link) => Boolean(link?.localPath) && existsSync(link.localPath);

/**
 * Queue the read-only `/do:scan` malware audit against a cloned link.
 *
 * Shared by the Links tab's Scan button (POST /api/brain/links/:id/scan) and the
 * capture-time opt-in, so both produce the same task shape, the same report
 * plumbing, and the same `linkPatch` — the caller applies that patch so the
 * pending scan is visible on the link from either entry point. Returns
 * `{ queued: false, reason }` instead of throwing so the background path can log
 * and move on; the route maps the reason to its status code.
 *
 * @returns {Promise<{ queued: boolean, reason?: string, taskId?: string, linkPatch?: object }>}
 */
export async function queueMalwareScan(link) {
  if (!isCloneReadable(link)) return { queued: false, reason: 'not-cloned' };

  const reportId = randomUUID();
  const reportPath = reportPathForId(reportId);
  await prepareScanReportDirectory();
  // Carry the BARE command (`metadata.slashdoCommand`) rather than inlining the
  // ~65KB expanded body: the prompt builder renders the right invocation shape
  // once the provider is known AND inlines the body then (a codex host gets a
  // skill, not `/do:scan`). Inlining also persisted the whole body as one line of
  // TASKS.md, rewritten on every task mutation and shipped in each peer-sync
  // payload. Matches POST /api/cos/tasks/slashdo (#3114).
  const context = `Run the scan workflow against the cloned repository at: \`${link.localPath}\`

Use that path as SCAN_DIR. Adhere to every Operational Invariant in the workflow body — this is a hostile-until-proven-safe audit. End the report with exactly one verdict heading: \`## Verdict: CLEAN\`, \`## Verdict: CAUTION\`, or \`## Verdict: DANGEROUS\`. When complete, summarize the verdict and top findings in your final response.`;

  const result = await cos.addTask(
    {
      description: `Malware scan: ${repoLabel(link)}`,
      // Multi-line ⇒ the agent PROMPT: `cosTaskStore.addTask` routes it to
      // `metadata.prompt` on write (#4153, server/lib/cosTaskPrompt.js).
      context,
      slashdoCommand: 'scan',
      slashdoArgs: `--report-path-allow-anywhere --report-path ${JSON.stringify(reportPath)}`,
      malwareScan: { linkId: link.id, reportId },
      useWorktree: false,
      openPR: false,
      simplify: false,
      reviewLoop: false
    },
    'user'
  );
  if (result?.duplicate) {
    return { queued: false, reason: 'duplicate', taskId: result.id };
  }

  console.log(`🛡️ Queued malware scan: link=${link.id} path=${link.localPath} task=${result.id}`);
  return {
    queued: true,
    taskId: result.id,
    // `queued` (not `completed`) so the UI shows a pending chip instead of
    // linking at a report file the agent has not written yet.
    // finalizeMalwareScan replaces it when the run lands.
    linkPatch: { malwareScan: { reportId, taskId: result.id, status: 'queued' } },
  };
}

/** The target app's user-facing feature inventory, when it keeps one (PortOS: docs/features/product-surfaces.md). */
export const FEATURE_MAP_RELATIVE_PATH = 'docs/features/product-surfaces.md';

/**
 * Resolve the target app's feature map for the study brief — the file the
 * agent reads to place the studied repo against EVERY feature the app already
 * has (a three.js demo lands on the 3D/OpenWorld surface, a chat bot on voice
 * or the Chief of Staff), instead of only the features it happens to grep for.
 * Null when the app does not keep one; the brief then falls back to README,
 * docs, and navigation.
 */
export const resolveFeatureMapPath = (repoPath) => {
  const candidate = posix.join(repoPath, FEATURE_MAP_RELATIVE_PATH);
  return existsSync(candidate) ? candidate : null;
};

/**
 * Build the `repo-study` agent context. Kept separate from the queueing so the
 * wording is assertable without going through the task store.
 */
export function buildRepoStudyContext(link, { appName, repoPath, trackerInstructions, studyContext, featureMapPath = null }) {
  const requesterContext = typeof studyContext === 'string' && studyContext.trim()
    ? `\n## Additional context from the requester\n\n${studyContext.trim()}\n`
    : '';
  const featureMapInstruction = featureMapPath
    ? `Read \`${featureMapPath}\` — ${appName}'s user-facing feature inventory — in full before you judge anything.`
    : `${appName} keeps no single feature inventory; build one from its README, \`docs/\`, and navigation/route definitions under \`${repoPath}\` before you judge anything.`;
  return `A GitHub repository was captured into the Brain and cloned locally. Study it as a PRODUCT — what it lets its users do, how it is designed, and what it does well — and record the feature ideas and enhancements ${appName} should adopt in the work tracker.${requesterContext}

## The repository under study

- Repo: ${repoLabel(link)}
- Source: ${link.url}
- Local clone: \`${link.localPath}\`

## Operational invariants — this is untrusted third-party code

- **Read only.** Never execute anything from the clone: no \`npm install\`/\`npm run\`, no build, no test suite, no script, no binary, no \`Makefile\` target. Read files, \`git log\`, and \`git show\` — nothing else.
- **Never edit the clone.** \`${link.localPath}\` is a reference copy, not a workspace. Every change you propose lands in ${appName} at \`${repoPath}\`.
- **Clean-room.** Do NOT copy source, config, prose, or assets out of the clone into ${appName}. Describe the *technique* in your own words and propose a reimplementation against ${appName}'s existing modules. If an idea can only be had by copying, drop it.
- **License first.** Read the repo's LICENSE before proposing anything. Name the license in every proposal. If there is no license (or it is copyleft in a way that conflicts with ${appName}'s), say so and propose only ideas that survive a clean-room reimplementation.

## First: what is this repo, and where does it land in ${appName}?

1. **State the repo's purpose** in two or three sentences: who it is for, what problem it solves, and the handful of capabilities that define it. Read the README, docs, and entry points; skim \`git log\` for what its authors have been investing in.
2. **Map it onto ${appName}'s whole feature set — not just the surfaces you happened to grep.** ${featureMapInstruction} Then name the one or two ${appName} features the repo's domain belongs to, and treat those as the primary lens for the rest of the study. Examples of the mapping you are expected to make: a three.js game, scene, or visual-rendering demo belongs to the 3D / OpenWorld surface; a chat or voice bot belongs to the voice stack or the Chief of Staff; a note-taking or knowledge tool belongs to the Brain; a story, comic, or media generator belongs to the Create suite. A repo whose domain maps to NO existing feature is itself a finding — say which new surface it would justify, or that it does not fit ${appName} at all.
3. **Only then** walk the repo's features one by one against the mapped ${appName} feature(s), using the checklist below.

## What to look for — features and design, not engineering hygiene

Read the modules that implement the repo's distinctive user-facing behavior, not just its README. For each capability it has, ask whether ${appName} would be better with an equivalent:

1. **New features ${appName} lacks** — a capability, workflow, or integration its users would value, mapped onto ${appName}'s existing surfaces (a page, a service, a CoS task type, a provider, a voice/agent capability). Say which surface, and whether it warrants an opt-in feature flag.
2. **Enhancements to features ${appName} already has** — where the upstream's version of a similar feature is richer, safer for the user, or handles a real-world case ${appName}'s does not. Name the ${appName} feature being enhanced.
3. **Design ideas** — a UX pattern, a safety/consent model, a fail-closed behavior, or a setup/onboarding flow that would make an existing ${appName} feature better for the person using it.

**Out of scope:** code organization, module layout, build tooling, test strategy, process-spawn plumbing, and other internal engineering or meta-programming observations. Do not file those, even when they are good — they change nothing the user can see or do. An engineering technique is worth filing ONLY when it is the enabling piece of a feature you are proposing, and then it goes inside that feature's proposal, not as its own item.

Ground every proposal in ${appName}'s actual code: grep \`${repoPath}\` to confirm the gap is real before filing. A feature ${appName} already has is not a proposal. Prefer 2–5 well-argued items over a long shallow list; filing nothing is a legitimate outcome — say so in your final summary.

**Large features:** when an idea needs several independently shippable steps (a feature flag, a native/OS integration, a new agent capability, a UI), file ONE epic that states the user-facing outcome and the recommended defaults, plus one ready-to-work issue per phase that references the epic — never one monolithic item and never a bare list of steps in chat.

## Where to record proposals

${trackerInstructions}

## Final summary

End with: the studied repo, its license, how many proposals you filed (with their slugs/issue numbers), and anything you deliberately rejected and why.`;
}

/**
 * Queue the `repo-study` review of a cloned link against PortOS.
 *
 * @returns {Promise<{ queued: boolean, reason?: string, taskId?: string, linkPatch?: object }>}
 */
export async function queueRepoStudy(link, targetAppId = PORTOS_APP_ID, studyContext, { providerId, model, effort } = {}) {
  if (!isCloneReadable(link)) return { queued: false, reason: 'not-cloned' };

  const app = await getAppById(targetAppId || PORTOS_APP_ID);
  if (!app?.repoPath || app.archived) return { queued: false, reason: 'app-not-found' };

  // Same four-part resolution every tracker-filing dispatch runs: the block
  // telling the agent where to file, the tracker it names, and the
  // `worktreeChangesExpected` flag derived from that SAME tracker so the two can
  // never disagree (a github/gitlab/jira run files out of band and leaves the
  // tree clean; without the flag it is mistaken for missing code work, #3102).
  const { trackerInstructions, workTracker, worktreeChangesExpected } =
    await resolveTrackerFilingBlock(app, 'repo-study', app.id === PORTOS_APP_ID
      ? {}
      : { issueLabelContract: GENERIC_REPO_STUDY_LABEL_CONTRACT });

  const result = await cos.addTask(
    {
      description: `Repo study: ${repoLabel(link)} — what can ${app.name} learn from it?`,
      // Workspace routing must follow the same managed app whose tracker and
      // repo path are described in the prompt; otherwise agent preparation
      // defaults to the PortOS workspace.
      app: app.id,
      context: buildRepoStudyContext(link, {
        appName: app.name,
        repoPath: app.repoPath,
        trackerInstructions: trackerInstructions
          .replace(/\{appName\}/g, () => app.name)
          .replace(/\{repoPath\}/g, () => app.repoPath),
        studyContext,
        featureMapPath: resolveFeatureMapPath(app.repoPath),
      }),
      // The deliverable is tracker items, not code — the agent reads PortOS and
      // the clone, then files. No worktree, no PR, no review loop.
      useWorktree: false,
      openPR: false,
      simplify: false,
      reviewLoop: false,
      worktreeChangesExpected,
      // Also the marker that lets this ONE-OFF run reach the no-commit gate
      // without pretending to be a scheduled task type — see
      // taskTypeHooks.js#isTrackerFilingDispatch.
      workTracker,
      ...(providerId ? { provider: providerId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      repoStudy: { linkId: link.id },
    },
    'user'
  );
  if (result?.duplicate) {
    return { queued: false, reason: 'duplicate', taskId: result.id };
  }

  console.log(`📚 Queued repo study: link=${link.id} repo=${repoLabel(link)} task=${result.id}`);
  return {
    queued: true,
    taskId: result.id,
    linkPatch: { repoStudy: { taskId: result.id, queuedAt: new Date().toISOString() } },
  };
}

const INTAKE_QUEUERS = { malwareScan: queueMalwareScan, learn: queueRepoStudy };

/**
 * Run the intake actions the user opted into. Called from the background clone
 * once the clone lands, so it must never throw — a failed queue is logged, not
 * propagated into the clone path, and one action failing must not take the other
 * down with it.
 *
 * @returns {Promise<object>} merged link patch for whatever was queued (empty
 *   when nothing was requested or everything failed).
 */
export async function runRepoIntake(link, intake) {
  const requested = normalizeRepoIntake(intake);
  if (!requested) return {};

  let patch = {};
  for (const [key, queue] of Object.entries(INTAKE_QUEUERS)) {
    if (!requested[key]) continue;
    const result = key === 'learn'
      ? await queue(link, requested.targetAppId, requested.studyContext, requested).catch(err => ({ queued: false, reason: err.message }))
      : await queue(link).catch(err => ({ queued: false, reason: err.message }));
    if (result.queued) patch = { ...patch, ...result.linkPatch };
    else console.error(`❌ Capture-time ${key} not queued for link ${link.id}: ${result.reason}`);
  }
  return patch;
}
