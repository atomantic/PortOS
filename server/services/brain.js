/**
 * Brain Service
 *
 * Core business logic for the Brain feature:
 * - Capture and classify thoughts
 * - Route to appropriate databases
 * - Generate daily digests and weekly reviews
 * - Handle corrections and fixes
 */

import * as storage from './brainStorage.js';
import { brainEvents } from './brainStorage.js';
import { getInstanceId } from './instanceIdentity.js';
import { getActiveProvider, getProviderById } from './provider/providers.js';
import { buildPrompt } from './promptService.js';
import { extractJson } from '../lib/jsonExtract.js';
import { runPromptThroughProvider } from './promptRunner.js';
import { isToolFreeOneShotProvider } from '../lib/provider/providerVendors.js';
import { ServerError } from '../lib/errorHandler.js';
import { getDomainAutonomyMode } from './cos/cosState.js';
import { getDomainBudgetStatus, recordDomainUsage } from './domainUsage.js';
import { deleteMemoryAssets } from './chatgptImport.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { createLinkFromUrl } from './brainLinks.js';
import { parseBareUrl } from '../lib/bareUrl.js';
import { transitionInbox, INBOX_EVENTS } from '../lib/brainInboxTransitions.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import {
  classifierOutputSchema,
  digestOutputSchema,
  reviewOutputSchema,
  extractedPeopleSchema,
  extractedProjectSchema,
  extractedIdeaSchema,
  extractedAdminSchema,
  extractedMemorySchema
} from '../lib/brainSchemas.js';

export const TOOL_FREE_REQUIRED = 'TOOL_FREE_REQUIRED';

// Extracted field validators by destination
const EXTRACTED_VALIDATORS = {
  people: extractedPeopleSchema,
  projects: extractedProjectSchema,
  ideas: extractedIdeaSchema,
  admin: extractedAdminSchema,
  memories: extractedMemorySchema
};

/**
 * Call AI provider with a prompt.
 * `toolFree` is for prompts that embed stored Brain records (writable by any
 * caller on a password-free install): the run is pinned to a provider that can
 * disable its host tools, with no fallback to one that cannot.
 */
async function callAI(promptStageName, variables, providerOverride, modelOverride, { toolFree = false } = {}) {
  const provider = providerOverride
    ? await getProviderById(providerOverride)
    : await getActiveProvider();

  if (!provider || !provider.enabled) {
    throw new Error('No AI provider available');
  }

  if (toolFree && !isToolFreeOneShotProvider(provider)) {
    throw new ServerError(
      `Brain provider '${provider.id}' cannot run without tools, so it cannot process stored Brain records unattended. Choose an API provider or a tool-free CLI (claude, grok, pi).`,
      { status: 400, code: TOOL_FREE_REQUIRED }
    );
  }

  const prompt = await buildPrompt(promptStageName, variables);
  let model = modelOverride || provider.defaultModel;

  // gemini-cli default is a thinking model (3.1-pro); prefer the provider's configured
  // light tier (populated from data.reference/providers.json on new installs) and only fall
  // back to the hard-coded flash if nothing is configured at all.
  if (provider.id === 'gemini-cli' && !model) {
    model = provider.lightModel || 'gemini-2.5-flash';
  }

  console.log(`🧠 Calling AI: ${provider.id} / ${model} / ${promptStageName}`);

  // brain runs are headless classification — append the provider's
  // headlessArgs (e.g. claude-code's --no-session-persistence) so the
  // user's session list doesn't fill up with classifier transcripts.
  // The clone leaves the saved provider config untouched.
  const providerForCall = provider.headlessArgs?.length
    ? { ...provider, args: [...(provider.args || []), ...provider.headlessArgs] }
    : provider;

  const { text, model: effectiveModel } = await runPromptThroughProvider({
    provider: providerForCall, prompt, source: `brain-${promptStageName}`, model,
    // Pin the admitted provider so runtime fallback cannot switch to one with tools. The model is
    // not part of that contract: a saved model the provider no longer lists is corrected on the
    // SAME provider rather than failing every scheduled digest/review.
    ...(toolFree && { toolFree: true, allowFallback: false, allowModelCorrection: true }),
  });
  return { content: text, model: effectiveModel || model, providerId: provider.id, prompt };
}

/**
 * Parse JSON from AI response (handles markdown code blocks)
 */
function parseJsonResponse(content, responseSchema = null, promptToStrip = '') {
  if (!content || typeof content !== 'string') {
    throw new Error('Empty or invalid AI response');
  }

  const shapePredicate = responseSchema
    ? (value) => responseSchema.safeParse(value).success
    : undefined;
  const source = promptToStrip && content.includes(promptToStrip)
    ? content.replace(promptToStrip, '')
    : content;
  const { value, lastError } = extractJson(source, {
    // Brain prompts include fenced JSON examples. Walk all candidates so an
    // echoed example cannot win before the actual answer.
    skipInnerFence: true,
    shapePredicate,
  });
  if (value === undefined) {
    throw new Error(`Failed to parse AI JSON response: ${lastError?.message || 'No JSON found'}`);
  }
  return value;
}

/**
 * Safe version of parseJsonResponse that returns null instead of throwing.
 * Used in background classification where errors can't bubble to middleware.
 *
 * The schema is the single validation authority: it picks the matching JSON
 * candidate AND supplies the returned data. extractJson falls back to the first
 * raw JSON value when no candidate matches; that fallback is discarded here
 * (null) rather than re-validated by the caller.
 */
function safeParseJsonResponse(content, responseSchema, promptToStrip = '') {
  if (!content || typeof content !== 'string') return null;
  const source = promptToStrip && content.includes(promptToStrip)
    ? content.replace(promptToStrip, '')
    : content;
  let matched = null;
  const shapePredicate = (value) => {
    const result = responseSchema.safeParse(value);
    if (result.success) matched = { value, data: result.data };
    return result.success;
  };
  const { value } = extractJson(source, { skipInnerFence: true, shapePredicate });
  return matched && matched.value === value ? matched.data : null;
}

/**
 * Capture a thought and classify it
 * Returns immediately after creating the inbox entry.
 * AI classification runs in the background and emits a socket event on completion.
 */
export async function captureThought(text, providerOverride, modelOverride, { creative = false, repoIntake = null, note } = {}) {
  // A capture that is nothing but a URL is a bookmark, not a thought: file it
  // straight to Links exactly as the Links tab would, and skip the classifier
  // LLM call entirely. This outranks the creative flag — a bare URL carries no
  // prose for the Catalog to work from — so both capture boxes disable the
  // Creative toggle for a URL rather than the two rules disagreeing.
  const bareUrl = parseBareUrl(text);
  if (bareUrl) {
    return captureUrlAsLink(bareUrl, text, { repoIntake, note });
  }

  const meta = await storage.loadMeta();
  const provider = providerOverride || meta.defaultProvider;
  const model = modelOverride || meta.defaultModel;

  // Per-domain autonomy gate: `off` captures the thought but skips auto-classify
  // entirely (it lands in the inbox for manual review); `dry-run` classifies and
  // surfaces the suggestion but doesn't auto-file it.
  const autonomyMode = await getDomainAutonomyMode('brain');

  // Daily brain budget (#711): when today's auto-classify actions/minutes reach
  // the cap, fall back to `off` for the rest of the day — the thought is still
  // captured for manual review, just not auto-classified. A manual retry
  // (retryClassification) is user-initiated and never gated or counted.
  const withinBudget = autonomyMode === 'off' || (await getDomainBudgetStatus('brain')).withinBudget;
  const classify = autonomyMode !== 'off' && withinBudget;
  const budgetPaused = autonomyMode !== 'off' && !withinBudget;

  // Create initial inbox log entry. When auto-classify is off the entry goes
  // straight to needs_review rather than the transient classifying state — and
  // carries no `ai` metadata, since no provider/model was ever invoked.
  const attemptId = classify ? uuidv4() : null;
  const inboxEntry = await storage.createInboxLog({
    capturedText: text,
    source: 'brain_ui',
    ...(creative ? { creative: true } : {}),
    ...(!classify
      ? {}
      : {
        ai: { providerId: provider, modelId: model, promptTemplateId: 'brain-classifier' },
        classificationAttempt: attemptId
      }),
    status: !classify ? 'needs_review' : 'classifying'
  });

  if (!classify) {
    console.log(`🧠 Thought captured, ${budgetPaused ? 'auto-classify daily budget reached' : 'auto-classify is OFF'} — left for manual review: ${inboxEntry.id}`);
    return {
      inboxLog: inboxEntry,
      message: budgetPaused
        ? 'Thought captured! Auto-classify daily budget reached — review it in the inbox.'
        : 'Thought captured! Auto-classify is off — review it in the inbox.'
    };
  }

  console.log(`🧠 Thought captured, classifying in background${autonomyMode === 'dry-run' ? ' (dry-run, no auto-file)' : ''}: ${inboxEntry.id}`);

  // Run AI classification in background (don't await)
  // Pass resolved provider/model so callAI uses brain's configured provider, not the system active one
  classifyInBackground({
    entryId: inboxEntry.id,
    text,
    meta,
    provider,
    model,
    autoFile: autonomyMode !== 'dry-run',
    countsTowardBudget: true,
    attemptId
  })
    .catch(err => failClassification(inboxEntry.id, attemptId, err));

  return {
    inboxLog: inboxEntry,
    message: autonomyMode === 'dry-run'
      ? 'Thought captured! AI is suggesting a classification (dry-run — confirm to file).'
      : 'Thought captured! AI is classifying...'
  };
}

/**
 * File a bare-URL capture to the links collection and log it as an already-filed
 * inbox entry (so the capture is still auditable from the inbox, showing where
 * it went). Re-pasting a URL that's already saved reuses that link instead of
 * failing the capture — the inbox entry then points at the existing bookmark.
 *
 * `repoIntake` carries the capture box's opt-in post-clone agent actions
 * (malware scan / repo study). It applies only to a NEW GitHub link: re-pasting
 * an already-saved URL performs no clone, so there is no fresh clone for the
 * agents to read and re-queueing them silently would be a surprise.
 */
async function captureUrlAsLink(url, capturedText, { repoIntake = null, note } = {}) {
  const existing = await storage.getLinkByUrl(url);
  const link = existing || await createLinkFromUrl(url, { repoIntake, note });

  // No `classification` block: nothing classified this — the destination was
  // decided by shape, not by a model, so there is no confidence or extraction to
  // record. That also keeps the entry safe on a federated peer running older
  // code (inbox records sync): its inbox renders `classification.destination`
  // through a fixed destination map, so an absent classification degrades to the
  // existing "Unknown" badge instead of an unmapped value it can't render.
  const inboxEntry = await storage.createInboxLog({
    capturedText,
    source: 'brain_ui',
    status: 'filed',
    filed: { destination: 'links', destinationId: link.id }
  });

  console.log(`🔗 Captured URL filed to links: ${link.id}${existing ? ' (existing)' : ''} via ${inboxEntry.id}`);

  return {
    inboxLog: inboxEntry,
    link,
    message: existing
      ? 'Already saved in Links.'
      : (link.isRepo ? repoCaptureMessage(link.repoIntake) : 'Saved to Links!')
  };
}

/**
 * What a freshly-captured repo link tells the user will happen next. The
 * clone is always implied; the agent runs only when they ticked the boxes, and
 * they only start once the clone lands.
 */
function repoCaptureMessage(repoIntake) {
  const queued = [
    repoIntake?.malwareScan && 'malware scan',
    repoIntake?.learn && 'repo study',
  ].filter(Boolean);
  return queued.length
    ? `Repo saved — cloning, then queueing ${queued.join(' + ')}.`
    : 'Repo saved to Links — cloning now.';
}

/**
 * Apply one inbox status transition (lib/brainInboxTransitions.js) inside the
 * record's write queue, against the freshly re-read row. `buildUpdates(fresh)`
 * runs only once the transition is allowed — side effects such as filing a
 * destination record belong there, so a refused or stale event performs none.
 *
 * Returns `{ outcome, entry }`: outcome is the transition's action (`apply`,
 * `ignore`, `noop`) or `missing` (absent/tombstoned, entry null). A refused
 * user action throws a 409.
 */
async function transitionInboxEntry(id, event, { attemptId, conflictMessage, buildUpdates } = {}) {
  let outcome = 'missing';
  let current = null;
  const updated = await storage.updateWith('inbox', id, async (fresh) => {
    current = fresh;
    const result = transitionInbox(fresh, event, attemptId);
    outcome = result.action;
    if (result.action !== 'apply') return null;
    return { ...(buildUpdates ? await buildUpdates(fresh) : {}), ...result.patch };
  });
  if (outcome === 'conflict') {
    throw new ServerError(conflictMessage || `Inbox entry is ${current.status}; cannot ${event}`, {
      status: 409,
      code: 'INBOX_STATUS_CONFLICT'
    });
  }
  return { outcome, entry: updated ?? current };
}

const inboxNotFound = () => new ServerError('Inbox log entry not found', { status: 404, code: 'NOT_FOUND' });

/**
 * Write a classifier completion if `attemptId` still owns the row. Returns
 * whether it was written; a stale completion is logged and dropped.
 */
async function settleClassification(entryId, attemptId, event, buildUpdates) {
  const { outcome } = await transitionInboxEntry(entryId, event, { attemptId, buildUpdates });
  if (outcome === 'apply') return true;
  console.log(`⏭️ Ignored stale classification result for ${entryId} (attempt no longer owns the entry)`);
  return false;
}

/**
 * Last-resort handler for a throw escaping classifyInBackground (e.g. the filing
 * write failed after a successful AI call). Without it the entry stays
 * `classifying` until the next boot's recoverStuckClassifications.
 */
async function failClassification(entryId, attemptId, err) {
  console.error(`❌ Background classification failed for ${entryId}: ${err.message}`);
  const written = await settleClassification(entryId, attemptId, INBOX_EVENTS.FAIL, () => ({
    error: { message: err.message }
  })).catch(updateErr => {
    console.error(`❌ Failed to mark ${entryId} needs_review: ${updateErr.message}`);
    return false;
  });
  if (written) brainEvents.emit('classified', { entryId, status: 'needs_review', error: err.message });
}

/**
 * Background AI classification for a captured thought.
 * Updates the inbox entry and emits a brain:classified event when done.
 */
async function classifyInBackground({ entryId, text, meta, provider, model, autoFile = true, countsTowardBudget = false, attemptId }) {
  let classification = null;
  let aiError = null;

  const startTime = Date.now();
  const aiResult = await callAI(
    'brain-classifier',
    { capturedText: text, now: new Date().toISOString() },
    provider,
    model
  ).catch(err => {
    aiError = err;
    return null;
  });

  const durationMs = Date.now() - startTime;
  const elapsed = (durationMs / 1000).toFixed(1);

  // Daily brain budget accounting (#711): an auto-classify consumed compute
  // whether or not it parsed, so count the attempt + its time. Only the auto
  // path (captureThought) passes countsTowardBudget — a manual retry doesn't count.
  if (countsTowardBudget) {
    await recordDomainUsage('brain', { actions: 1, ms: durationMs })
      .catch(err => console.error(`❌ Failed to record brain budget usage for ${entryId}: ${err.message}`));
  }
  const aiResponse = aiResult?.content;
  // Patch ai metadata so the inbox entry reflects the model actually invoked
  // (captureThought/retryClassification stored the pre-resolved value, which may
  // have been null when gemini-cli fell back internally).
  const aiMeta = aiResult
    ? { providerId: aiResult.providerId, modelId: aiResult.model, promptTemplateId: 'brain-classifier' }
    : null;

  if (aiResponse) {
    console.log(`🧠 AI responded in ${elapsed}s for ${entryId}`);
    classification = safeParseJsonResponse(aiResponse, classifierOutputSchema, aiResult.prompt);
    if (!classification) aiError = new Error('Could not parse a valid classification from AI response');
  } else {
    console.log(`🧠 AI failed after ${elapsed}s for ${entryId}`);
  }

  // If AI failed, mark as needs_review
  if (!classification) {
    const errorMessage = aiError?.message || 'AI classification failed';
    const written = await settleClassification(entryId, attemptId, INBOX_EVENTS.CLASSIFY_REVIEW, () => ({
      ...(aiMeta ? { ai: aiMeta } : {}),
      classification: {
        destination: 'unknown',
        confidence: 0,
        title: 'Classification failed',
        extracted: {},
        reasons: [errorMessage]
      },
      error: { message: errorMessage }
    }));
    if (!written) return;

    console.log(`🧠 Classification failed for ${entryId}: ${errorMessage}`);
    brainEvents.emit('classified', { entryId, status: 'needs_review', error: errorMessage });
    return;
  }

  // Check confidence threshold
  if (classification.confidence < meta.confidenceThreshold || classification.destination === 'unknown') {
    const written = await settleClassification(entryId, attemptId, INBOX_EVENTS.CLASSIFY_REVIEW, () => ({
      ai: aiMeta,
      classification
    }));
    if (!written) return;

    console.log(`🧠 Low confidence (${classification.confidence}) for ${entryId}`);
    brainEvents.emit('classified', { entryId, status: 'needs_review', confidence: classification.confidence });
    return;
  }

  // Dry-run: a confident classification was produced, but the auto-file side
  // effect is withheld. Surface the suggestion as needs_review so the user can
  // confirm filing it from the inbox.
  if (!autoFile) {
    const written = await settleClassification(entryId, attemptId, INBOX_EVENTS.CLASSIFY_REVIEW, () => ({
      ai: aiMeta,
      classification
    }));
    if (!written) return;
    console.log(`🧠 [dry-run] Classified ${entryId} → ${classification.destination} (not filed; awaiting confirmation)`);
    brainEvents.emit('classified', {
      entryId,
      status: 'needs_review',
      destination: classification.destination,
      title: classification.title,
      dryRun: true
    });
    return;
  }

  // Filed inside the inbox row's write queue, after the attempt matched, so a
  // stale or superseded attempt never creates a destination record.
  let filedRecord = null;
  const written = await settleClassification(entryId, attemptId, INBOX_EVENTS.CLASSIFY_FILED, async () => {
    filedRecord = await fileToDestination(classification.destination, classification.extracted, classification.title);
    return {
      ai: aiMeta,
      classification,
      filed: {
        destination: classification.destination,
        destinationId: filedRecord.id
      }
    };
  });
  if (!written) return;

  console.log(`🧠 Classified and filed to ${classification.destination}: ${filedRecord.id}`);
  brainEvents.emit('classified', {
    entryId,
    status: 'filed',
    destination: classification.destination,
    title: classification.title
  });
}

/**
 * File extracted data to destination database
 */
async function fileToDestination(destination, extracted, title) {
  const validator = EXTRACTED_VALIDATORS[destination];
  if (!validator) {
    throw new Error(`Unknown destination: ${destination}`);
  }

  // Validate and set defaults
  const validationResult = validator.safeParse(extracted);
  const data = validationResult.success ? validationResult.data : extracted;

  switch (destination) {
    case 'people':
      return storage.createPerson({
        name: data.name || title,
        context: data.context || '',
        followUps: data.followUps || [],
        lastTouched: data.lastTouched || null,
        tags: data.tags || []
      });

    case 'projects':
      return storage.createProject({
        name: data.name || title,
        status: data.status || 'active',
        nextAction: data.nextAction || 'Define next action',
        notes: data.notes || '',
        tags: data.tags || []
      });

    case 'ideas':
      return storage.createIdea({
        title: data.title || title,
        oneLiner: data.oneLiner || title,
        notes: data.notes || '',
        tags: data.tags || []
      });

    case 'admin':
      return storage.createAdminItem({
        title: data.title || title,
        status: data.status || 'open',
        dueDate: data.dueDate || null,
        nextAction: data.nextAction || null,
        notes: data.notes || ''
      });

    case 'memories':
      return storage.createMemoryEntry({
        title: data.title || title,
        content: data.content || '',
        mood: data.mood || null,
        tags: data.tags || []
      });

    default:
      throw new Error(`Cannot file to destination: ${destination}`);
  }
}

/**
 * Title to file an inbox entry under. Not every entry carries a classification —
 * a URL filed to Links skipped the classifier, and so does every capture taken
 * while auto-classify is off — so fall back to the captured text (bounded to the
 * 200-char record-title limit) before the last-resort placeholder.
 */
function entryTitle(inboxLog) {
  return inboxLog.classification?.title
    || inboxLog.capturedText?.trim().slice(0, 200)
    || 'Untitled';
}

/**
 * Resolve a needs_review inbox item
 */
export async function resolveReview(inboxLogId, destination, editedExtracted) {
  let filedRecord = null;
  const { outcome, entry } = await transitionInboxEntry(inboxLogId, INBOX_EVENTS.RESOLVE, {
    conflictMessage: 'Inbox entry is not in needs_review status',
    buildUpdates: async (inboxLog) => {
      const extracted = { ...inboxLog.classification?.extracted, ...editedExtracted };
      filedRecord = await fileToDestination(destination, extracted, entryTitle(inboxLog));
      return {
        classification: {
          ...inboxLog.classification,
          destination,
          extracted,
          confidence: 1.0,
          reasons: [...(inboxLog.classification?.reasons || []), 'Manually resolved']
        },
        filed: {
          destination,
          destinationId: filedRecord.id
        }
      };
    }
  });
  if (outcome === 'missing') throw inboxNotFound();

  console.log(`🧠 Resolved review to ${destination}: ${filedRecord.id}`);
  return { inboxLog: entry, filedRecord };
}

/**
 * Fix/correct a filed inbox item
 */
export async function fixClassification(inboxLogId, newDestination, updatedFields, note) {
  let newRecord = null;
  let previousDestination = null;
  const { outcome, entry } = await transitionInboxEntry(inboxLogId, INBOX_EVENTS.CORRECT, {
    conflictMessage: 'Can only fix filed or previously corrected entries',
    buildUpdates: async (inboxLog) => {
      previousDestination = inboxLog.filed?.destination || inboxLog.classification?.destination;
      const previousId = inboxLog.filed?.destinationId;

      const extracted = { ...inboxLog.classification?.extracted, ...updatedFields };
      newRecord = await fileToDestination(newDestination, extracted, entryTitle(inboxLog));

      // Mark old record as archived (soft delete by adding archived flag)
      if (previousId && previousDestination) {
        await archiveRecord(previousDestination, previousId);
      }

      return {
        filed: {
          destination: newDestination,
          destinationId: newRecord.id
        },
        correction: {
          correctedAt: new Date().toISOString(),
          previousDestination: previousDestination || 'unknown',
          newDestination,
          note
        }
      };
    }
  });
  if (outcome === 'missing') throw inboxNotFound();

  console.log(`🧠 Fixed classification from ${previousDestination} to ${newDestination}`);
  return { inboxLog: entry, newRecord };
}

/**
 * Archive a record (soft delete)
 */
async function archiveRecord(destination, id) {
  // A bookmark has no archived state — the Links tab renders every record — so
  // correcting a bare-URL capture into a real destination removes the link it
  // auto-created, rather than leaving it behind in Links.
  if (destination === 'links') {
    await storage.deleteLink(id);
    return;
  }

  const updateFn = {
    people: storage.updatePerson,
    projects: storage.updateProject,
    ideas: storage.updateIdea,
    admin: storage.updateAdminItem,
    memories: storage.updateMemoryEntry
  }[destination];

  if (updateFn) {
    await updateFn(id, { archived: true });
  }
}

/**
 * Run daily digest
 */
export async function runDailyDigest(providerOverride, modelOverride) {
  const meta = await storage.loadMeta();

  // Gather data for digest
  const [activeProjects, openAdmin, allPeople, needsReviewLogs] = await Promise.all([
    storage.getProjects({ status: 'active' }),
    storage.getAdminItems({ status: 'open' }),
    storage.getPeople(),
    storage.getInboxLog({ status: 'needs_review' })
  ]);

  // Filter people with follow-ups
  const peopleWithFollowUps = allPeople.filter(p => p.followUps && p.followUps.length > 0);

  // Skip AI call when brain has no data (fresh instance)
  if (!activeProjects.length && !openAdmin.length && !peopleWithFollowUps.length && !needsReviewLogs.length) {
    console.log('🧠 Skipping daily digest: no brain data yet');
    await storage.updateMeta({ lastDailyDigest: new Date().toISOString() });
    return null;
  }

  const aiResult = await callAI(
    'brain-daily-digest',
    {
      activeProjects: JSON.stringify(activeProjects),
      openAdmin: JSON.stringify(openAdmin),
      peopleFollowUps: JSON.stringify(peopleWithFollowUps),
      needsReview: JSON.stringify(needsReviewLogs),
      now: new Date().toISOString()
    },
    providerOverride || meta.defaultProvider,
    modelOverride || meta.defaultModel,
    { toolFree: true }
  );

  const parsed = parseJsonResponse(aiResult.content, digestOutputSchema, aiResult.prompt);
  const validationResult = digestOutputSchema.safeParse(parsed);

  if (!validationResult.success) {
    throw new Error(`Invalid digest output: ${JSON.stringify(validationResult.error.issues)}`);
  }

  const digestData = validationResult.data;

  // Enforce word limit
  const wordCount = digestData.digestText.split(/\s+/).length;
  if (wordCount > 150) {
    digestData.digestText = digestData.digestText.split(/\s+/).slice(0, 150).join(' ') + '...';
  }

  // Store digest — ai.modelId reflects the resolved model so attribution stays
  // accurate even when callAI falls back (e.g., gemini-cli → gemini-2.5-flash).
  const digest = await storage.createDigest({
    ...digestData,
    ai: {
      providerId: aiResult.providerId,
      modelId: aiResult.model,
      promptTemplateId: 'brain-daily-digest'
    }
  });

  console.log(`🧠 Generated daily digest: ${digest.id}`);
  return digest;
}

/**
 * Run weekly review
 */
export async function runWeeklyReview(providerOverride, modelOverride) {
  const meta = await storage.loadMeta();

  // Get inbox log from last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const allInboxLogs = await storage.getInboxLog({ limit: 500 });
  const recentInboxLogs = allInboxLogs.filter(log => log.capturedAt >= sevenDaysAgo);

  // Get active projects
  const activeProjects = await storage.getProjects({ status: 'active' });

  // Skip AI call when brain has no data (fresh instance)
  if (!recentInboxLogs.length && !activeProjects.length) {
    console.log('🧠 Skipping weekly review: no brain data yet');
    await storage.updateMeta({ lastWeeklyReview: new Date().toISOString() });
    return null;
  }

  const aiResult = await callAI(
    'brain-weekly-review',
    {
      inboxLogLast7Days: JSON.stringify(recentInboxLogs),
      activeProjects: JSON.stringify(activeProjects),
      now: new Date().toISOString()
    },
    providerOverride || meta.defaultProvider,
    modelOverride || meta.defaultModel,
    { toolFree: true }
  );

  const parsed = parseJsonResponse(aiResult.content, reviewOutputSchema, aiResult.prompt);
  const validationResult = reviewOutputSchema.safeParse(parsed);

  if (!validationResult.success) {
    throw new Error(`Invalid review output: ${JSON.stringify(validationResult.error.issues)}`);
  }

  const reviewData = validationResult.data;

  // Enforce word limit
  const wordCount = reviewData.reviewText.split(/\s+/).length;
  if (wordCount > 250) {
    reviewData.reviewText = reviewData.reviewText.split(/\s+/).slice(0, 250).join(' ') + '...';
  }

  // Store review — ai.modelId reflects the resolved model so attribution stays
  // accurate even when callAI falls back (e.g., gemini-cli → gemini-2.5-flash).
  const review = await storage.createReview({
    ...reviewData,
    ai: {
      providerId: aiResult.providerId,
      modelId: aiResult.model,
      promptTemplateId: 'brain-weekly-review'
    }
  });

  console.log(`🧠 Generated weekly review: ${review.id}`);
  return review;
}

/**
 * Retry classification for a needs_review item.
 * Returns immediately after setting status to 'classifying'.
 * AI classification runs in the background and emits a socket event on completion.
 */
export async function retryClassification(inboxLogId, providerOverride, modelOverride) {
  const meta = await storage.loadMeta();
  const provider = providerOverride || meta.defaultProvider;
  const model = modelOverride || meta.defaultModel;

  // The `classifying` claim and its new attempt id are one locked write, so of
  // two overlapping retries exactly one reaches the classifier; the other 409s.
  const attemptId = uuidv4();
  const { outcome, entry } = await transitionInboxEntry(inboxLogId, INBOX_EVENTS.RETRY, {
    attemptId,
    conflictMessage: 'Only an entry awaiting review can be retried',
    buildUpdates: () => ({
      ai: {
        providerId: provider,
        modelId: model,
        promptTemplateId: 'brain-classifier'
      },
      error: null
    })
  });
  if (outcome === 'missing') throw inboxNotFound();

  console.log(`🧠 Retrying classification in background: ${inboxLogId}`);

  // Run AI classification in background (don't await)
  // A manual retry is a user decision to file: it skips the autonomy gate and isn't budget-counted.
  classifyInBackground({
    entryId: inboxLogId,
    text: entry.capturedText,
    meta,
    provider,
    model,
    autoFile: true,
    countsTowardBudget: false,
    attemptId
  })
    .catch(err => failClassification(inboxLogId, attemptId, err));

  return {
    inboxLog: entry,
    message: 'Retrying classification...'
  };
}

/**
 * Mark inbox entry as done. Refused (409) while a classification is in flight,
 * so its late result cannot overwrite the user's decision. Returns null when the
 * entry does not exist.
 */
export async function markInboxDone(inboxLogId) {
  const { outcome, entry } = await transitionInboxEntry(inboxLogId, INBOX_EVENTS.DONE, {
    conflictMessage: 'Inbox entry is still being classified',
    buildUpdates: () => ({ doneAt: new Date().toISOString() })
  });
  if (outcome === 'missing') return null;

  if (outcome === 'apply') console.log(`🧠 Marked inbox entry done: ${inboxLogId}`);
  return entry;
}

/**
 * Mark a batch of creative inbox notes as consumed by a catalog ingest that just
 * committed — stamps `sentToCatalogAt` so they drop out of the inbox's "ready to
 * become ingredients" banner and can't be accidentally re-sent. Idempotent and
 * forgiving: ids that no longer exist (deleted/tombstoned) are skipped silently
 * so a partially-stale list still stamps the rest. Returns the updated entries.
 */
export async function markInboxSentToCatalog(ids) {
  const sentToCatalogAt = new Date().toISOString();
  // Single batched write (one store rewrite + one sync-log pass) — updateMany
  // already skips unknown/tombstoned ids, preserving the "stamp the rest" contract.
  const updated = await storage.updateMany('inbox', ids.map(id => ({ id, sentToCatalogAt })));
  console.log(`🧠 Marked ${updated.length} creative note(s) sent to catalog`);
  return updated;
}

/**
 * Update inbox entry (edit captured text)
 */
export async function updateInboxEntry(inboxLogId, updates) {
  const updated = await storage.updateInboxLog(inboxLogId, updates);
  if (!updated) {
    return null;
  }

  console.log(`🧠 Updated inbox entry text: ${inboxLogId}`);
  return updated;
}

/**
 * Delete inbox entry
 */
export async function deleteInboxEntry(inboxLogId) {
  const deleted = await storage.deleteInboxLog(inboxLogId);
  if (!deleted) {
    return false;
  }

  console.log(`🧠 Deleted inbox entry: ${inboxLogId}`);
  return true;
}

/**
 * Recover inbox entries stuck in 'classifying' status from a previous server restart.
 * Resets them to 'needs_review' so the user can retry.
 *
 * Only touches entries THIS instance originated. Now that inbox rows are synced
 * brain records, a peer's entry can be legitimately mid-classification (status
 * 'classifying') on ITS machine while we hold a synced copy. Flipping that to
 * 'needs_review' here would stamp a fresh updatedAt and, as the LWW winner,
 * clobber the origin's real classification on the next sync. Classification only
 * ever runs on the capturing (origin) machine, so a stuck 'classifying' entry is
 * only ours to recover when we created it. (Pre-091 records with no
 * originInstanceId are treated as local — backfillOriginInstanceId stamps them
 * with our id at boot anyway, so they ARE ours.)
 */
export async function recoverStuckClassifications() {
  const instanceId = await getInstanceId();
  const isOurs = (entry) => !entry.originInstanceId || entry.originInstanceId === instanceId;
  const entries = await storage.getInboxLog({ status: 'classifying', limit: 100 });
  let recovered = 0;
  for (const entry of entries) {
    if (!isOurs(entry)) continue;
    // Clearing the attempt is what stops a dead classifier from filing later
    // (any completion without a matching attempt is ignored). Re-checked inside
    // the write queue so a row that settled since the scan is left alone.
    const updated = await storage.updateWith('inbox', entry.id, (fresh) => (
      fresh.status === 'classifying' && isOurs(fresh)
        ? { status: 'needs_review', classificationAttempt: null }
        : null
    ));
    if (!updated) continue;
    recovered++;
    console.log(`🧠 Recovered stuck classification: ${entry.id}`);
  }
  if (recovered > 0) {
    console.log(`🧠 Recovered ${recovered} stuck classification(s)`);
  }
}

/**
 * Delete a memory entry AND clean up its on-disk assets.
 *
 * A `chatgpt-import` memory references an archived transcript (`sourceRef`) and
 * any number of served asset files (images/audio/PDFs) embedded in its markdown
 * `content`. The storage-level delete only tombstones the JSON record — without
 * this wrapper those files orphan forever under `data/brain/imports/`. We load
 * the record first (to know what it referenced) and the surviving import
 * memories (so a shared transcript/asset still in use — e.g. the same export
 * imported twice — isn't pulled out from under them).
 */
export const deleteMemoryEntry = (id) => withBackupAssetPublication(() => deleteMemoryEntryLeased(id));

// The record drop and the asset/transcript unlinks are one backup workflow (#9982).
async function deleteMemoryEntryLeased(id) {
  const record = await storage.getMemoryEntryById(id);
  const deleted = await storage.deleteMemoryEntry(id);
  if (deleted && record?.source === 'chatgpt-import') {
    const survivors = (await storage.getMemoryEntries())
      .filter((m) => m.id !== id && m.source === 'chatgpt-import');
    await deleteMemoryAssets(record, survivors);
  }
  return deleted;
}
