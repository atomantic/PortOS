/** Vision work belongs only to an explicitly initiated, process-owned check-in. */
import { randomUUID } from 'crypto';
import { castSetsInspectionInputs, currentCastSetsInspection, sameCastSetsInspectionInputs } from '../../lib/musicVideoCastSetsInspection.js';
import { requireProject } from './requireProject.js';
import { mutateProjectRecord } from './projects.js';
import { findProductionRun, assertProductionActive, reserveProductionReview } from './production.js';

const MAX_ATTEMPTS = 2;
export { reviewRenderedImage as reviewCastSetsImage } from '../imageRenderInspection.js';

export async function inspectCastAndSetsImages(projectId, { processId, resolveReviewer, reviewImage, publish, retryImage }) {
  const original = await requireProject(projectId);
  const revision = original.castAndSets.revision;
  const owned = (p) => p.castAndSets?.processId === processId && p.castAndSets.revision === revision && p.castAndSets.status === 'imaging';
  for (const key of Object.keys(original.castAndSets.plan || {})) {
    for (;;) {
      const project = await requireProject(projectId);
      if (!owned(project)) return;
      const inputs = castSetsInspectionInputs(project.castAndSets, key);
      if (!inputs) break;
      const previous = currentCastSetsInspection(project.castAndSets, key);
      if (previous && (['pass', 'mismatch'].includes(previous.verdict) || previous.attempts >= MAX_ATTEMPTS)) break;
      const attempts = (previous?.attempts || 0) + 1;
      const id = randomUUID();
      const pending = await mutateProjectRecord(projectId, (current) => {
        if (!owned(current) || !sameCastSetsInspectionInputs(inputs, castSetsInspectionInputs(current.castAndSets, key))) return { project: current, changed: false };
        return { project: { ...current, castAndSets: { ...current.castAndSets, images: { ...current.castAndSets.images,
          [key]: { ...current.castAndSets.images[key], inspection: { id, inputs, stageRevision: revision, verdict: 'pending', attempts } } } } }, changed: true };
      });
      if (!pending.changed) return;
      publish(projectId, pending.project);
      const runId = project.castAndSets.productionRunId;
      const run = runId ? findProductionRun(project, runId) : null;
      let reviewer;
      const outcome = await (async () => {
        reviewer = await resolveReviewer(run?.reviewer || {});
        let charged = false;
        const beforeExecute = async (execution) => {
          if (execution?.provider && (execution.provider.id !== reviewer.provider.id || (reviewer.model && execution.model !== reviewer.model))) throw new Error('The selected vision reviewer changed');
          await mutateProjectRecord(projectId, (current) => {
            if (!owned(current) || !sameCastSetsInspectionInputs(inputs, castSetsInspectionInputs(current.castAndSets, key))
              || current.castAndSets.images[key].inspection?.id !== id) throw new Error('Cast & Sets image changed during inspection');
            if (!runId) return { project: current };
            assertProductionActive(current, runId, run.processId);
            if (charged) return { project: current };
            const reserved = reserveProductionReview(current, runId, { reviewRunId: `cast-sets:${id}`, attemptN: attempts, costUsd: reviewer.costUsd, processId: run.processId });
            charged = true;
            return reserved;
          });
        };
        return reviewImage({ inputs, reviewer, beforeExecute });
      })().catch((error) => {
        const providerId = reviewer?.provider?.id || run?.reviewer?.providerId || null;
        const model = reviewer?.model || run?.reviewer?.model || null;
        const message = String(error?.message || error || 'Unknown inspection failure');
        const reason = (reviewer?.provider?.apiKey ? message.split(reviewer.provider.apiKey).join('[redacted]') : message)
          .replace(/\s+/g, ' ').slice(0, 300);
        const refused = error?.status >= 400 && error.status < 500;
        const log = refused ? console.log : console.error;
        log(`${refused ? '🚫' : '❌'} Cast & Sets vision inspection failed (provider: ${providerId || 'unresolved'}, model: ${model || 'default'}): ${reason}`);
        return { verdict: 'unreviewed', discrepancy: `Vision unavailable: ${reason}`, providerId, model };
      });
      const settled = await mutateProjectRecord(projectId, (current) => {
        const image = current.castAndSets?.images?.[key];
        if (!owned(current) || image?.inspection?.id !== id || !sameCastSetsInspectionInputs(inputs, castSetsInspectionInputs(current.castAndSets, key))) return { project: current, changed: false };
        return { project: { ...current, castAndSets: { ...current.castAndSets, images: { ...current.castAndSets.images,
          [key]: { ...image, inspection: { ...image.inspection, ...outcome, inspectedAt: new Date().toISOString() } } } } }, changed: true };
      });
      if (!settled.changed) return;
      publish(projectId, settled.project);
      const checks = outcome.checks || [];
      const defect = checks.find((check) => check.id === 'render-quality' && check.status === 'fail');
      if (project.castAndSets.productionRunId && outcome.verdict === 'mismatch'
        && defect
        && ['subject', 'setting', 'empty-set'].every((checkId) => checks.some((check) => check.id === checkId && check.status === 'pass'))) {
        await retryImage({ key, inputs, inspectionId: id,
          note: `avoid: ${defect.note}` });
      }
      if (outcome.verdict !== 'unreviewed' || attempts >= MAX_ATTEMPTS) break;
    }
  }
}
