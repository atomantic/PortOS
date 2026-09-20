/** Machine-local inference reservations. Attempts stay charged after failure or restart. */
import { z } from 'zod';
import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { normalizePersistentMindMaintainer } from '../lib/persistentMindMaintainer.js';
import { knownContextWindow } from '../lib/aiToolkit/providerStatus.js';
import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';

const FILE = join(PATHS.cos, 'maintainer-inference.json');
const writeQueue = createFileWriteQueue();
const emptyDay = date => ({ date, calls: 0, paidCalls: 0, reservedMs: 0 });
const ledgerSchema = z.object({ schemaVersion: z.literal(1),
  day: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value),
    calls: z.number().int().nonnegative(), paidCalls: z.number().int().nonnegative(), reservedMs: z.number().int().nonnegative() }),
  turn: z.object({ id: z.string().min(1).max(200), calls: z.number().int().nonnegative() }),
  lastReservation: z.object({ lane: z.enum(['local-curation', 'authorized-escalation']), turnId: z.string(),
    at: z.string().datetime(), timeoutMs: z.number().int().positive(), costUsd: z.null(), usage: z.literal('unknown'),
    dayCall: z.number().int().positive(), turnCall: z.number().int().positive() }),
});
const validateLedger = stored => {
  if (stored !== null && !ledgerSchema.safeParse(stored).success) throw new Error('Maintainer inference ledger is invalid; restore its last valid backup.');
  return stored;
};
const readLedger = () => readJSONFile(FILE, null, { strict: true, logError: false });

export async function inspectMaintainerInferenceRoute({ role: rawRole, provider, model, thinkingPresetId = null,
  thinkingSelection = null, selfThinkingRequest = null, promptChars, promptBytes,
  probe = probeOpenAiModels } = {}) {
  const role = normalizePersistentMindMaintainer(rawRole);
  if (!role.enabled) return { ok: true, enforced: false };
  const policy = role.inference;
  if (!provider || provider.enabled === false) return { ok: false, reason: 'Maintainer inference provider is unavailable.' };
  if (provider.type !== 'api') return { ok: false, reason: 'Maintainer inference requires an API provider so output and duration limits can be enforced.' };
  const runtime = provider.type === 'api' && localRuntimeForProvider(provider);
  const paid = !runtime;
  if (paid && (selfThinkingRequest || !thinkingPresetId || !thinkingSelection
      || !policy.paidPresetIds.includes(thinkingPresetId) || policy.maxPaidCallsPerDay === 0)) {
    return { ok: false, reason: 'Maintainer curation requires a local API model. Select an explicitly permitted paid preset in a human message to escalate.' };
  }
  if (!Number.isInteger(promptChars) || promptChars < 0 || promptChars > policy.maxPromptChars
      || !Number.isSafeInteger(promptBytes) || promptBytes < promptChars) {
    return { ok: false, reason: `Maintainer prompt exceeds the ${policy.maxPromptChars} character limit; reduce context or report batch size.` };
  }
  let contextTokens = knownContextWindow(provider, model);
  if (runtime) {
    const catalog = await probe(runtime.endpoint, { apiKey: provider.apiKey || '', timeoutMs: 3000 });
    if (!catalog.reachable || !Array.isArray(catalog.models)) return { ok: false, reason: 'Local maintainer model catalog is unavailable; check the configured runtime.' };
    if (!catalog.models.includes(model)) return { ok: false, reason: 'Configured maintainer model is absent from the local runtime; select an installed model.' };
    const served = catalog.contextWindows?.[model];
    if (Number.isFinite(served) && served > 0) contextTokens = contextTokens ? Math.min(contextTokens, served) : served;
    if (!contextTokens) return { ok: false, reason: 'Local maintainer context capacity is unknown; configure or verify the runtime context window.' };
  }
  // UTF-8 bytes are a deliberately conservative text token bound; reserve
  // room for output and transport framing without pretending to know usage.
  if (contextTokens && promptBytes + 9216 > contextTokens) return { ok: false, reason: 'Maintainer context does not fit the configured model; shrink context or choose a larger local window.' };
  return { ok: true, enforced: true, lane: paid ? 'authorized-escalation' : 'local-curation', contextTokens, policy };
}

/** Reserve atomically BEFORE invoking a provider; no refunds for uncertain calls. */
export async function reserveMaintainerInference({ turnId, lane, policy, now = () => Date.now(),
  read = readLedger, write = ledger => atomicWrite(FILE, ledger), queue = writeQueue } = {}) {
  return queue(async () => {
    const date = new Date(now()).toISOString().slice(0, 10);
    const stored = validateLedger(await read());
    if (stored && date < stored.day.date) return { ok: false, reason: 'Maintainer budget clock moved backwards; check the system clock.' };
    const day = stored?.day.date === date ? { ...stored.day } : emptyDay(date);
    // Only the active supervisor turn may reach this boundary (CallGuard
    // compares activeTurn.id immediately before reservation). An older turn
    // cannot resume after another is admitted; retrying creates a new id.
    const turn = stored?.turn.id === turnId ? { ...stored.turn } : { id: turnId, calls: 0 };
    if (turn.calls >= policy.maxCallsPerTurn) return { ok: false, reason: 'Maintainer per-turn inference allowance exhausted.' };
    if (day.calls >= policy.maxCallsPerDay || day.reservedMs + policy.maxCallMs > policy.maxReservedMsPerDay) return { ok: false, reason: 'Maintainer daily inference allowance exhausted.' };
    if (lane === 'authorized-escalation' && day.paidCalls >= policy.maxPaidCallsPerDay) return { ok: false, reason: 'Maintainer paid escalation allowance exhausted.' };
    day.calls += 1; day.reservedMs += policy.maxCallMs; turn.calls += 1;
    if (lane === 'authorized-escalation') day.paidCalls += 1;
    const reservation = { lane, turnId, at: new Date(now()).toISOString(), timeoutMs: policy.maxCallMs,
      costUsd: null, usage: 'unknown', dayCall: day.calls, turnCall: turn.calls };
    await write({ schemaVersion: 1, day, turn, lastReservation: reservation });
    return { ok: true, reservation };
  });
}

export async function readMaintainerInferenceBudget({ now = () => Date.now(), read = readLedger } = {}) {
  const ledger = validateLedger(await read());
  const date = new Date(now()).toISOString().slice(0, 10);
  if (ledger && date < ledger.day.date) throw new Error('Maintainer budget clock moved backwards; check the system clock.');
  return { day: ledger?.day?.date === date ? ledger.day : emptyDay(date),
    lastReservation: ledger?.lastReservation || null, accounting: 'conservative-reserved-time', costUsd: null };
}
