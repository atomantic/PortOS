/**
 * Series Autopilot — visual + canon steps (#2842 split of seriesAutopilot.js):
 * cover/page draft enqueueing, the visual-draft wait loop, the canon-readiness
 * verification gate and the teaser production step.
 */

import { buildRenderSlot } from '../../../lib/renderSlot.js';
import { parseComicScript } from '../../../lib/comicScriptParser.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../../domainUsage.js';
import { getIssue, updateStageWithLatest } from '../issues.js';
import { slotKeyForVariant } from '../owners.js';
import { enqueueComicCover, enqueueComicBackCover, enqueueVisualComicPage } from '../visualStages.js';
import { checkSeriesCanonReadiness } from '../canonReadiness.js';
import { broadcast, fileGap, providerOverrideOpts } from './session.js';
import { slotEnqueued, pageEnqueued, visualReady } from './stepResolver.js';

// Turn a render-enqueue result into the { slotKey, slot } pair the render
// routes persist (proof → proofImage, final → finalImage).
const slotFromRenderResult = (result) => {
  const slotKey = slotKeyForVariant(result.variant);
  return { slotKey, slot: buildRenderSlot({ slotKey, jobId: result.jobId, prompt: result.prompt, fromProof: result.fromProof }) };
};

// Persist an in-flight render slot the way the render routes do: enqueue the
// proof render, then splice the returned jobId onto the freshest persisted
// cover/backCover slot via updateStageWithLatest.
async function enqueueCoverDraft(issueId, slotField, enqueueFn) {
  const { slotKey, slot } = slotFromRenderResult(await enqueueFn(issueId, { target: 'proof' }));
  await updateStageWithLatest(issueId, 'comicPages', (current) => {
    const currentSlot = current?.[slotField] || {};
    return { [slotField]: { ...currentSlot, [slotKey]: slot } };
  });
}

async function enqueuePageDraft(issueId, pageIndex) {
  const { slotKey, slot } = slotFromRenderResult(await enqueueVisualComicPage(issueId, { pageIndex, target: 'proof' }));
  await updateStageWithLatest(issueId, 'comicPages', (current) => {
    const pages = Array.isArray(current?.pages) ? current.pages : [];
    if (!pages[pageIndex]) return {};
    const next = [...pages];
    next[pageIndex] = { ...pages[pageIndex], [slotKey]: slot };
    return { status: 'edited', pages: next };
  });
}

export async function runVisualDraft(sId, issueId, record) {
  let issue = await getIssue(issueId);
  let cp = issue.stages?.comicPages;

  // Respect an explicit lock — the user froze this stage, so don't seed pages
  // or render. Skip (intentional, not a gap) and mark drafted so we don't loop.
  if (cp?.locked === true) {
    broadcast(sId, { type: 'step:skip', kind: 'visualDraft', issueId, reason: 'comicPages stage is locked — skipping draft render' });
    record.runState.visualDrafted.add(issueId);
    return {};
  }

  // 1. Seed pages + cover concepts from the comic script if not already done
  //    (mirrors the extract-pages route; pure parse, no LLM).
  if (!(Array.isArray(cp?.pages) && cp.pages.length > 0)) {
    const source = (issue.stages?.comicScript?.output || '').trim();
    if (source) {
      const { pages, coverConcept, backCoverConcept } = parseComicScript(source);
      await updateStageWithLatest(issueId, 'comicPages', (current) => {
        const coverScript = current?.cover?.script || '';
        const backScript = current?.backCover?.script || '';
        return {
          status: pages.length ? 'ready' : 'empty',
          pages,
          cover: coverConcept && !coverScript ? { script: coverConcept, imageJobId: null, prompt: null } : (current?.cover ?? null),
          backCover: backCoverConcept && !backScript ? { script: backCoverConcept, imageJobId: null, prompt: null } : (current?.backCover ?? null),
          errorMessage: '',
        };
      });
      issue = await getIssue(issueId);
      cp = issue.stages?.comicPages;
    }
  }

  const pageCount = Array.isArray(cp?.pages) ? cp.pages.length : 0;
  if (pageCount === 0) {
    // Nothing to draw — the comic script never parsed into pages. This is a real
    // production blocker, so pause for review rather than marking the issue done.
    await fileGap(record, sId, {
      gapKind: 'visual-no-pages',
      issueId,
      summary: 'Cannot draft comic art — the comic script did not parse into any pages. Fix the comicScript stage (PAGE/PANEL structure) first.',
      context: `issueId=${issueId}`,
    });
    return { pause: true, gapFiled: true, reason: `issue ${issue.number ?? issueId} has no comic pages to render — the script did not parse`, residual: [{ severity: 'high', location: `issue ${issue.number ?? '?'} / comicPages`, problem: 'comic script did not parse into pages' }] };
  }

  // Budget-gate + bill each render individually — a comic is many GPU jobs.
  // A failed enqueue (e.g. a page with no panels) is surfaced and skipped.
  const enqueueOne = async (target, fn) => {
    const budget = await getDomainBudgetStatus('cos');
    if (!budget.withinBudget) return { pause: true, reason: `daily cos ${budget.exceeded} budget reached` };
    try {
      await fn();
      await recordDomainUsage('cos', { actions: 1 });
      broadcast(sId, { type: 'render:queued', issueId, target });
    } catch (err) {
      const reason = (err?.message || String(err)).slice(0, 200);
      broadcast(sId, { type: 'step:skip', kind: 'visualDraft', issueId, target, reason });
      // Dedups to one task per issue (idTag has no target), so a broken page
      // doesn't file a task per page.
      await fileGap(record, sId, {
        gapKind: 'render-failed',
        issueId,
        summary: `A draft render failed for this issue (first failure: ${target} — ${reason}). The comic page/panel structure may be incomplete.`,
        context: `issueId=${issueId} target=${target}`,
      });
    }
    return {};
  };

  // 2. Front cover.
  if (!slotEnqueued(cp?.cover)) {
    const r = await enqueueOne('cover', () => enqueueCoverDraft(issueId, 'cover', enqueueComicCover));
    if (r.pause) return r;
  }
  // 3. Back cover — always queue it (like the front cover); the back-cover
  //    renderer has a fallback prompt when no concept script is set, so a
  //    "complete" draft shouldn't silently omit it.
  issue = await getIssue(issueId);
  cp = issue.stages?.comicPages;
  if (!slotEnqueued(cp?.backCover)) {
    const r = await enqueueOne('backCover', () => enqueueCoverDraft(issueId, 'backCover', enqueueComicBackCover));
    if (r.pause) return r;
  }
  // 4. Every interior page (re-read per page so each splice merges fresh state).
  for (let i = 0; i < pageCount; i += 1) {
    if (record.cancelRequested) return { canceled: true };
    const fresh = await getIssue(issueId);
    const page = fresh.stages?.comicPages?.pages?.[i];
    if (!page || !Array.isArray(page.panels) || page.panels.length === 0) continue;
    if (pageEnqueued(page)) continue;
    const r = await enqueueOne(`page ${i + 1}`, () => enqueuePageDraft(issueId, i));
    if (r.pause) return r;
  }
  // Only consider the issue drafted once every drawable slot is actually
  // enqueued. If a render errored (e.g. an un-renderable page), visualReady is
  // still false — mark it attempted so the resolver doesn't re-loop, but pause
  // for review instead of letting the run report a complete draft.
  const after = await getIssue(issueId);
  if (!visualReady(after)) {
    record.runState.visualDrafted.add(issueId);
    await fileGap(record, sId, {
      gapKind: 'visual-incomplete',
      issueId,
      summary: `Issue ${after.number ?? issueId} could not be fully drafted — some cover/page renders did not enqueue (likely an un-renderable page or missing panels). Review the comic page/panel structure.`,
      context: `issueId=${issueId}`,
    });
    return {
      pause: true,
      gapFiled: true,
      reason: `issue ${after.number ?? issueId} could not be fully drafted — some cover/page renders did not enqueue`,
      residual: [{ severity: 'high', location: `issue ${after.number ?? '?'} / comicPages`, problem: 'not every drawable cover/page render was enqueued (likely an un-renderable page or missing panels)' }],
    };
  }
  record.runState.visualDrafted.add(issueId);
  return {};
}

// Canon descriptive-integrity gate — deterministic (no LLM), so not billable.
// Pauses for human review when a canon noun that appears in the visual source
// has no description (it can't be drawn). Marks canonVerified when clean so the
// run proceeds to visual drafting.
export async function runCanonVerify(sId, record) {
  const report = await checkSeriesCanonReadiness(sId);
  broadcast(sId, {
    type: 'verify:round', scope: 'canon', round: 1,
    findings: report.undescribed.length, blocking: report.undescribed.length,
  });
  if (report.ready) {
    record.runState.canonVerified = true;
    return {};
  }
  const residual = report.undescribed.map((n) => ({
    severity: 'high',
    location: `${n.kind} "${n.name}"`,
    problem: 'Appears where it would be drawn but has no description — can\'t be rendered.',
  }));
  await fileGap(record, sId, {
    gapKind: 'canon-undescribed',
    summary: `${report.undescribed.length} canon noun(s) appear in panels/scenes with no description: ${report.undescribed.map((n) => n.name).join(', ').slice(0, 400)}. Describe them on the Nouns stage before generating pages.`,
    context: JSON.stringify(report.undescribed).slice(0, 1000),
  });
  return {
    pause: true,
    reason: `${report.undescribed.length} canon noun(s) referenced in panels/scenes are undescribed — describe them before visual production`,
    residual,
    gapFiled: true,
  };
}

// Teaser deliverable (CDO Phase 3, #2185, opt-in). Mint + start a Creative
// Director video project seeded from this issue — the autopilot→CD direction of
// the bridge. Attempted-once per issue (marked up front so a failure can't
// re-loop the resolver). Bills one cos action like every other autopilot step
// (the CD project's own downstream render spend is gated by the creative/cos
// budget on its side). A teaser is an OPTIONAL, terminal-phase deliverable, so a
// failure is ADVISORY: it broadcasts a skip + files a gap, but does NOT pause the
// whole run (the story is already done — a failed trailer shouldn't strand it).
// bridgeFromIssue is imported dynamically to keep the pipeline↔creative-director
// module graph acyclic (it transitively pulls the CD plan loop + tool registry).
export async function runProduceTeaser(sId, issueId, record) {
  record.runState.teaserProduced.add(issueId);
  const issue = await getIssue(issueId).catch(() => null);
  try {
    const { produceVideoFromIssue } = await import('../../creativeDirector/bridgeFromIssue.js');
    // The treatment-from-prose LLM call runs through stageRunner's soft channel,
    // so thread the run's provider/model as providerDefault/modelDefault.
    const { project } = await produceVideoFromIssue(issueId, providerOverrideOpts(record));
    await recordDomainUsage('cos', { actions: 1 });
    broadcast(sId, { type: 'teaser:produced', issueId, projectId: project?.id });
    console.log(`🎬 autopilot teaser — series=${sId.slice(0, 12)} issue=${issue?.number ?? issueId} → CD project ${project?.id?.slice(0, 8) ?? '?'}`);
    return {};
  } catch (err) {
    const message = (err?.message || String(err)).slice(0, 300);
    broadcast(sId, { type: 'step:skip', kind: 'produceTeaser', issueId, reason: `teaser production failed: ${message}` });
    await fileGap(record, sId, {
      gapKind: 'teaser-failed',
      issueId,
      summary: `The optional teaser video for issue ${issue?.number ?? issueId} could not be produced: ${message}. The story is complete — this deliverable can be retried from the Creative Director.`,
      context: `issueId=${issueId}`,
    });
    return {};
  }
}
