/** Replace historical estimates and record nested CLI measurements on the private usage draft. */
import { POLLUTING_KEYS } from '../lib/objects.js';
import { countFields, hasUsageCounts, isUsageKey, mergeSource, usageModelKey } from '../lib/usageReport.js';
import { todayInTimezone } from '../lib/timezone.js';
import { adjustCounts, datedUsageDay, rebuildDayTotals } from '../lib/usageBuckets.js';

const zeroCounts = () => Object.fromEntries(countFields.map((field) => [field, 0]));

const recordTotals = (records) => (Array.isArray(records) ? records : [records]).reduce((total, record) => {
  for (const field of countFields) total[field] += Math.max(0, record?.[field] || 0);
  return total;
}, zeroCounts());

const BACKFILL_YIELD_INTERVAL = 25;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

const isParentCorrectionPending = (usageData, correction) => Boolean(correction?.measured)
  && !usageData.reconciledRuns[correction.runId]
  && (correction.unrecorded === true || Boolean(usageData.dailyActivity?.[correction.day]?.byProvider?.[correction.providerId]));

const isSiblingCorrectionPending = (usageData, correction) => (correction?.siblings?.length > 0)
  && !usageData.siblingReconciledRuns[correction.runId];

// Transcript-derived provider ids and model names index the same plain-object
// maps as live recording, so a correction naming a prototype key is skipped.
const isUsableCorrectionRecord = (record) => !record
  || ((!record.providerId || isUsageKey(record.providerId)) && (!record.model || usageModelKey(record.model) !== null));

function isEligibleCorrection(usageData, correction) {
  const { runId, day: dayKey, providerId } = correction || {};
  if (!runId || !dayKey || !providerId) return false;
  if (POLLUTING_KEYS.has(runId) || POLLUTING_KEYS.has(dayKey) || !isUsageKey(providerId)) return false;
  const records = [correction, ...[correction.measured].flat(), ...(correction.siblings || [])];
  if (!records.every(isUsableCorrectionRecord)) return false;
  return isParentCorrectionPending(usageData, correction) || isSiblingCorrectionPending(usageData, correction);
}

// Snapshots each bucket before the batch touches it and sums the estimates the
// batch removes from it, so `settleCorrectedSources` can tell a bucket whose
// every estimate was replaced (`measured`) from one still holding other runs'
// estimates (`mixed`). Keyed by bucket object: one day/provider/model, one bucket.
function trackEstimateRemoval(scopes, bucket, estimate) {
  if (!scopes.has(bucket)) scopes.set(bucket, { original: recordTotals([bucket]), removed: recordTotals([]) });
  adjustCounts(scopes.get(bucket).removed, estimate, 1);
}

async function collectEstimateScopes(usageData, eligible) {
  const scopes = new Map();
  for (const [index, correction] of eligible.entries()) {
    if (index > 0 && index % BACKFILL_YIELD_INTERVAL === 0) await yieldToEventLoop();
    if (!isParentCorrectionPending(usageData, correction) || correction.unrecorded) continue;
    const providerDay = usageData.dailyActivity[correction.day].byProvider[correction.providerId];
    trackEstimateRemoval(scopes, providerDay, correction.estimate);
    const modelDay = correction.model ? providerDay.byModel?.[correction.model] : null;
    if (modelDay) trackEstimateRemoval(scopes, modelDay, correction.estimate);
  }
  return scopes;
}

function settleCorrectedSources(scopes) {
  for (const [bucket, { original, removed }] of scopes) {
    const hasResidual = countFields.some((field) => (original[field] || 0) > (removed[field] || 0));
    bucket.source = hasUsageCounts(bucket) ? (hasResidual ? 'mixed' : 'measured') : null;
  }
}

function replaceEstimateWithMeasured(modelDayBucket, providerDay, { model, estimate, measured }) {
  const measuredRecords = [measured].flat();
  adjustCounts(providerDay, estimate, -1);
  adjustCounts(model ? providerDay.byModel?.[model] : null, estimate, -1);
  if (providerDay?.estimated) adjustCounts(providerDay.estimated, estimate, -1);
  const estimatedModel = model ? providerDay?.byModel?.[model] : null;
  if (estimatedModel?.estimated) adjustCounts(estimatedModel.estimated, estimate, -1);
  for (const record of measuredRecords) {
    adjustCounts(providerDay, record, 1);
    if (!record?.model) continue;
    const target = modelDayBucket(providerDay, record.model);
    const hadCounts = hasUsageCounts(target);
    adjustCounts(target, record, 1);
    target.source = hadCounts ? mergeSource(target.source, 'measured') : 'measured';
  }
  return measuredRecords;
}

// All-time rollups only hold messages and tokens, so the parent swap moves them
// by the measured-minus-estimate delta. Input carries the measured cache tiers.
function applyAllTimeCorrection(usageData, { providerId, model, estimate }, measuredRecords) {
  const measuredTotals = recordTotals(measuredRecords);
  const delta = {
    messages: measuredTotals.messages - (estimate?.messages || 0),
    tokensIn: measuredTotals.tokensIn + measuredTotals.cacheReadTokens + measuredTotals.cacheWriteTokens
      - (estimate?.tokensIn || 0),
    tokensOut: measuredTotals.tokensOut - (estimate?.tokensOut || 0)
  };
  usageData.totalMessages = Math.max(0, (usageData.totalMessages || 0) + delta.messages);
  usageData.totalTokens.input = Math.max(0, (usageData.totalTokens.input || 0) + delta.tokensIn);
  usageData.totalTokens.output = Math.max(0, (usageData.totalTokens.output || 0) + delta.tokensOut);

  const allProvider = usageData.byProvider?.[providerId];
  if (allProvider) {
    allProvider.messages = Math.max(0, (allProvider.messages || 0) + delta.messages);
    allProvider.tokens = Math.max(0, (allProvider.tokens || 0) + delta.tokensOut);
  }
  const estimatedModel = model ? usageData.byModel?.[model] : null;
  if (estimatedModel) {
    estimatedModel.messages = Math.max(0, (estimatedModel.messages || 0) - (estimate?.messages || 0));
    estimatedModel.tokens = Math.max(0, (estimatedModel.tokens || 0) - (estimate?.tokensOut || 0));
  }
  for (const record of measuredRecords) {
    if (!record?.model) continue;
    usageData.byModel[record.model] ??= { sessions: 0, messages: 0, tokens: 0 };
    usageData.byModel[record.model].messages += record.messages || 0;
    usageData.byModel[record.model].tokens += record.tokensOut || 0;
  }
}

// Routed by `record.providerId`, never the run's provider: a nested grok
// review inside a Claude run is grok's spend. There is no estimate to
// remove — nothing ever recorded these tokens at all.
function addSiblingRecords(day, siblings, addUsageRecord, rememberRepairIds) {
  for (const record of siblings) {
    if (!record?.providerId) continue;
    addUsageRecord(day, record);
    rememberRepairIds(record.repairIds);
  }
}

/**
 * Replace historical per-run estimates with transcript measurements, and add
 * the nested-CLI sessions a run's own provider never accounted for.
 *
 * Two independent halves, each with its own idempotency marker:
 *
 *   PARENT (`estimate` + `measured`, keyed by `reconciledRuns`) — the original
 *     estimate is subtracted from the exact configured provider/model bucket
 *     that received it, then the measured records are added.
 *   SIBLING (`siblings`, keyed by `siblingReconciledRuns`) — a nested reviewer
 *     CLI's session is a pure ADDITION to ITS OWN provider's bucket. It has no
 *     estimate to remove (nothing ever recorded it), and it must never land in
 *     the parent's bucket — that is exactly the mis-attribution #5831 fixes.
 *     A sibling-only correction therefore does not require a pre-existing day
 *     bucket for the parent provider; the target bucket is created on demand.
 *
 * Flat day totals are rebuilt from the provider split so report residual
 * reconciliation cannot resurrect the removed estimate as a synthetic legacy row.
 */
export async function correctUsageDraft(usageData, corrections, {
  refreshDayKeyTimezone, modelDayBucket, addUsageRecord, applySessionCounts, rememberRepairIds,
}) {
  usageData.reconciledRuns ??= {};
  // Additive: absent on every install that predates the sibling scan, which
  // reads as "no run has had its nested sessions attributed yet".
  usageData.siblingReconciledRuns ??= {};
  const eligible = corrections.filter((correction) => isEligibleCorrection(usageData, correction));
  const timezone = eligible.some((correction) => correction.unrecorded) ? await refreshDayKeyTimezone() : null;
  const scopes = await collectEstimateScopes(usageData, eligible);
  const correctedRunIds = [];

  for (const [index, correction] of eligible.entries()) {
    if (index > 0 && index % BACKFILL_YIELD_INTERVAL === 0) await yieldToEventLoop();
    const { runId } = correction;
    const applyParent = isParentCorrectionPending(usageData, correction);
    const applySiblings = isSiblingCorrectionPending(usageData, correction);
    const day = datedUsageDay(usageData, correction.unrecorded
      ? todayInTimezone(timezone, new Date(correction.endTime)) : correction.day);

    if (applyParent) {
      if (correction.unrecorded) {
        for (const record of correction.measured) addUsageRecord(day, record);
        if (correction.deferredSession) {
          const at = new Date(correction.startTime);
          applySessionCounts(correction.providerId, correction.providerName, correction.model,
            datedUsageDay(usageData, todayInTimezone(timezone, at)), at);
        }
      } else {
        const measuredRecords = replaceEstimateWithMeasured(modelDayBucket, day.byProvider[correction.providerId], correction);
        applyAllTimeCorrection(usageData, correction, measuredRecords);
      }
      usageData.reconciledRuns[runId] = new Date().toISOString();
    }
    if (applySiblings) addSiblingRecords(day, correction.siblings, addUsageRecord, rememberRepairIds);
    // Same save as the counts. A later Grok repair skips any id recorded here,
    // so a turn billed with its long-context subset is not billed again.
    rememberRepairIds(correction.repairIds);
    // Marked whenever this run's sibling pass actually ran — including a run
    // whose only correction was the parent swap — so a second backfill can't
    // add the same nested session twice.
    if (correction.siblingScanned) usageData.siblingReconciledRuns[runId] = new Date().toISOString();

    rebuildDayTotals(day);
    correctedRunIds.push(runId);
  }

  settleCorrectedSources(scopes);
  return correctedRunIds;
}
