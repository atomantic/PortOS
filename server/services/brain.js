/**
 * Brain Service
 *
 * Core business logic for the Brain feature:
 * - Capture and classify thoughts
 * - Route to appropriate databases
 * - Generate daily digests and weekly reviews
 * - Handle corrections and fixes
 */

import { spawn } from 'child_process';
import * as storage from './brainStorage.js';
import { brainEvents } from './brainStorage.js';
import { getActiveProvider, getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { validate } from '../lib/validation.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import {
  classifierOutputSchema,
  digestOutputSchema,
  reviewOutputSchema,
  extractedPeopleSchema,
  extractedProjectSchema,
  extractedIdeaSchema,
  extractedAdminSchema
} from '../lib/brainValidation.js';

// Extracted field validators by destination
const EXTRACTED_VALIDATORS = {
  people: extractedPeopleSchema,
  projects: extractedProjectSchema,
  ideas: extractedIdeaSchema,
  admin: extractedAdminSchema
};

/**
 * Call AI provider with a prompt
 */
async function callAI(promptStageName, variables, providerOverride, modelOverride) {
  const provider = providerOverride
    ? await getProviderById(providerOverride)
    : await getActiveProvider();

  if (!provider || !provider.enabled) {
    throw new Error('No AI provider available');
  }

  const prompt = await buildPrompt(promptStageName, variables);
  const model = modelOverride || provider.defaultModel;

  if (provider.type === 'cli') {

    return new Promise((resolve, reject) => {
      const args = [...(provider.args || []), prompt];
      let output = '';

      const child = spawn(provider.command, args, {
        env: { ...process.env, ...provider.envVars },
        shell: false
      });

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        output += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`CLI exited with code ${code}`));
        }
      });

      child.on('error', reject);

      setTimeout(() => {
        child.kill();
        reject(new Error('AI request timed out'));
      }, provider.timeout || 300000);
    });
  }

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error(`Unsupported provider type: ${provider.type}`);
}

/**
 * Parse JSON from AI response (handles markdown code blocks)
 */
function parseJsonResponse(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('Empty or invalid AI response');
  }

  let jsonStr = content.trim();

  // Remove markdown code blocks if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Find JSON object
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    jsonStr = objectMatch[0];
  }

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse AI JSON response: ${err.message}`);
  }
}

/**
 * Safe version of parseJsonResponse that returns null instead of throwing.
 * Used in background classification where errors can't bubble to middleware.
 */
function safeParseJsonResponse(content) {
  if (!content || typeof content !== 'string') return null;

  let jsonStr = content.trim();

  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    jsonStr = objectMatch[0];
  }

  return safeJSONParse(jsonStr, null, { logError: true, context: 'brain-classifier' });
}

/**
 * Capture a thought and classify it
 * Returns immediately after creating the inbox entry.
 * AI classification runs in the background and emits a socket event on completion.
 */
export async function captureThought(text, providerOverride, modelOverride) {
  const meta = await storage.loadMeta();
  const provider = providerOverride || meta.defaultProvider;
  const model = modelOverride || meta.defaultModel;

  // Create initial inbox log entry
  const inboxEntry = await storage.createInboxLog({
    capturedText: text,
    source: 'brain_ui',
    ai: {
      providerId: provider,
      modelId: model,
      promptTemplateId: 'brain-classifier'
    },
    status: 'classifying'
  });

  console.log(`🧠 Thought captured, classifying in background: ${inboxEntry.id}`);

  // Run AI classification in background (don't await)
  // Pass resolved provider/model so callAI uses brain's configured provider, not the system active one
  classifyInBackground(inboxEntry.id, text, meta, provider, model)
    .catch(err => console.error(`❌ Background classification failed for ${inboxEntry.id}: ${err.message}`));

  return {
    inboxLog: inboxEntry,
    message: 'Thought captured! AI is classifying...'
  };
}

/**
 * Background AI classification for a captured thought.
 * Updates the inbox entry and emits a brain:classified event when done.
 */
async function classifyInBackground(entryId, text, meta, providerOverride, modelOverride) {
  let classification = null;
  let aiError = null;

  const aiResponse = await callAI(
    'brain-classifier',
    { capturedText: text, now: new Date().toISOString() },
    providerOverride,
    modelOverride
  ).catch(err => {
    aiError = err;
    return null;
  });

  if (aiResponse) {
    const parsed = safeParseJsonResponse(aiResponse);
    if (parsed) {
      const validationResult = classifierOutputSchema.safeParse(parsed);
      if (validationResult.success) {
        classification = validationResult.data;
      } else {
        console.error(`🧠 Classification validation failed: ${JSON.stringify(validationResult.error.errors)}`);
        aiError = new Error('Invalid classification output from AI');
      }
    } else {
      aiError = new Error('Could not parse AI response as JSON');
    }
  }

  // If AI failed, mark as needs_review
  if (!classification) {
    const errorMessage = aiError?.message || 'AI classification failed';
    await storage.updateInboxLog(entryId, {
      classification: {
        destination: 'unknown',
        confidence: 0,
        title: 'Classification failed',
        extracted: {},
        reasons: [errorMessage]
      },
      status: 'needs_review',
      error: { message: errorMessage }
    });

    console.log(`🧠 Classification failed for ${entryId}: ${errorMessage}`);
    brainEvents.emit('classified', { entryId, status: 'needs_review', error: errorMessage });
    return;
  }

  // Check confidence threshold
  if (classification.confidence < meta.confidenceThreshold || classification.destination === 'unknown') {
    await storage.updateInboxLog(entryId, {
      classification,
      status: 'needs_review'
    });

    console.log(`🧠 Low confidence (${classification.confidence}) for ${entryId}`);
    brainEvents.emit('classified', { entryId, status: 'needs_review', confidence: classification.confidence });
    return;
  }

  // File to appropriate destination
  const filedRecord = await fileToDestination(classification.destination, classification.extracted, classification.title);

  await storage.updateInboxLog(entryId, {
    classification,
    status: 'filed',
    filed: {
      destination: classification.destination,
      destinationId: filedRecord.id
    }
  });

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

    default:
      throw new Error(`Cannot file to destination: ${destination}`);
  }
}

/**
 * Resolve a needs_review inbox item
 */
export async function resolveReview(inboxLogId, destination, editedExtracted) {
  const inboxLog = await storage.getInboxLogById(inboxLogId);
  if (!inboxLog) {
    throw new Error('Inbox log entry not found');
  }

  if (inboxLog.status !== 'needs_review') {
    throw new Error('Inbox entry is not in needs_review status');
  }

  // Merge extracted data with edits
  const extracted = { ...inboxLog.classification?.extracted, ...editedExtracted };
  const title = inboxLog.classification?.title || 'Untitled';

  // File to destination
  const filedRecord = await fileToDestination(destination, extracted, title);

  // Update inbox log
  await storage.updateInboxLog(inboxLogId, {
    classification: {
      ...inboxLog.classification,
      destination,
      extracted,
      confidence: 1.0,
      reasons: [...(inboxLog.classification?.reasons || []), 'Manually resolved']
    },
    status: 'filed',
    filed: {
      destination,
      destinationId: filedRecord.id
    }
  });

  console.log(`🧠 Resolved review to ${destination}: ${filedRecord.id}`);
  return {
    inboxLog: await storage.getInboxLogById(inboxLogId),
    filedRecord
  };
}

/**
 * Fix/correct a filed inbox item
 */
export async function fixClassification(inboxLogId, newDestination, updatedFields, note) {
  const inboxLog = await storage.getInboxLogById(inboxLogId);
  if (!inboxLog) {
    throw new Error('Inbox log entry not found');
  }

  if (inboxLog.status !== 'filed' && inboxLog.status !== 'corrected') {
    throw new Error('Can only fix filed or previously corrected entries');
  }

  const previousDestination = inboxLog.filed?.destination || inboxLog.classification?.destination;
  const previousId = inboxLog.filed?.destinationId;

  // Create new record in new destination
  const extracted = { ...inboxLog.classification?.extracted, ...updatedFields };
  const title = inboxLog.classification?.title || 'Untitled';
  const newRecord = await fileToDestination(newDestination, extracted, title);

  // Mark old record as archived (soft delete by adding archived flag)
  if (previousId && previousDestination) {
    await archiveRecord(previousDestination, previousId);
  }

  // Update inbox log with correction info
  await storage.updateInboxLog(inboxLogId, {
    status: 'corrected',
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
  });

  console.log(`🧠 Fixed classification from ${previousDestination} to ${newDestination}`);
  return {
    inboxLog: await storage.getInboxLogById(inboxLogId),
    newRecord
  };
}

/**
 * Archive a record (soft delete)
 */
async function archiveRecord(destination, id) {
  const updateFn = {
    people: storage.updatePerson,
    projects: storage.updateProject,
    ideas: storage.updateIdea,
    admin: storage.updateAdminItem
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

  const aiResponse = await callAI(
    'brain-daily-digest',
    {
      activeProjects: JSON.stringify(activeProjects),
      openAdmin: JSON.stringify(openAdmin),
      peopleFollowUps: JSON.stringify(peopleWithFollowUps),
      needsReview: JSON.stringify(needsReviewLogs),
      now: new Date().toISOString()
    },
    providerOverride || meta.defaultProvider,
    modelOverride || meta.defaultModel
  );

  const parsed = parseJsonResponse(aiResponse);
  const validationResult = digestOutputSchema.safeParse(parsed);

  if (!validationResult.success) {
    throw new Error(`Invalid digest output: ${JSON.stringify(validationResult.error.errors)}`);
  }

  const digestData = validationResult.data;

  // Enforce word limit
  const wordCount = digestData.digestText.split(/\s+/).length;
  if (wordCount > 150) {
    digestData.digestText = digestData.digestText.split(/\s+/).slice(0, 150).join(' ') + '...';
  }

  // Store digest
  const digest = await storage.createDigest({
    ...digestData,
    ai: {
      providerId: providerOverride || meta.defaultProvider,
      modelId: modelOverride || meta.defaultModel,
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

  const aiResponse = await callAI(
    'brain-weekly-review',
    {
      inboxLogLast7Days: JSON.stringify(recentInboxLogs),
      activeProjects: JSON.stringify(activeProjects),
      now: new Date().toISOString()
    },
    providerOverride || meta.defaultProvider,
    modelOverride || meta.defaultModel
  );

  const parsed = parseJsonResponse(aiResponse);
  const validationResult = reviewOutputSchema.safeParse(parsed);

  if (!validationResult.success) {
    throw new Error(`Invalid review output: ${JSON.stringify(validationResult.error.errors)}`);
  }

  const reviewData = validationResult.data;

  // Enforce word limit
  const wordCount = reviewData.reviewText.split(/\s+/).length;
  if (wordCount > 250) {
    reviewData.reviewText = reviewData.reviewText.split(/\s+/).slice(0, 250).join(' ') + '...';
  }

  // Store review
  const review = await storage.createReview({
    ...reviewData,
    ai: {
      providerId: providerOverride || meta.defaultProvider,
      modelId: modelOverride || meta.defaultModel,
      promptTemplateId: 'brain-weekly-review'
    }
  });

  console.log(`🧠 Generated weekly review: ${review.id}`);
  return review;
}

/**
 * Retry classification for a needs_review item
 */
export async function retryClassification(inboxLogId, providerOverride, modelOverride) {
  const inboxLog = await storage.getInboxLogById(inboxLogId);
  if (!inboxLog) {
    throw new Error('Inbox log entry not found');
  }

  const meta = await storage.loadMeta();
  const provider = providerOverride || meta.defaultProvider;
  const model = modelOverride || meta.defaultModel;

  // Update AI config for this retry
  await storage.updateInboxLog(inboxLogId, {
    ai: {
      providerId: provider,
      modelId: model,
      promptTemplateId: 'brain-classifier'
    },
    status: 'needs_review',
    error: null
  });

  // Attempt AI classification
  let classification = null;
  let aiError = null;

  const aiResponse = await callAI(
    'brain-classifier',
    { capturedText: inboxLog.capturedText, now: new Date().toISOString() },
    provider,
    model
  ).catch(err => {
    aiError = err;
    return null;
  });

  if (aiResponse) {
    const parsed = parseJsonResponse(aiResponse);
    const validationResult = classifierOutputSchema.safeParse(parsed);

    if (validationResult.success) {
      classification = validationResult.data;
    } else {
      console.error(`🧠 Classification validation failed: ${JSON.stringify(validationResult.error.errors)}`);
      aiError = new Error('Invalid classification output from AI');
    }
  }

  // If AI failed, update entry with error
  if (!classification) {
    const errorMessage = aiError?.message || 'AI classification failed';
    await storage.updateInboxLog(inboxLogId, {
      classification: {
        destination: 'unknown',
        confidence: 0,
        title: 'Classification failed',
        extracted: {},
        reasons: [errorMessage]
      },
      status: 'needs_review',
      error: { message: errorMessage }
    });

    console.log(`🧠 Retry failed for ${inboxLogId}: ${errorMessage}`);
    return {
      inboxLog: await storage.getInboxLogById(inboxLogId),
      message: 'Classification failed, needs manual review'
    };
  }

  // If confidence too low, update but keep as needs_review
  if (classification.confidence < meta.confidenceThreshold) {
    await storage.updateInboxLog(inboxLogId, {
      classification,
      status: 'needs_review'
    });

    console.log(`🧠 Retry low confidence for ${inboxLogId}: ${classification.confidence}`);
    return {
      inboxLog: await storage.getInboxLogById(inboxLogId),
      message: `Low confidence (${(classification.confidence * 100).toFixed(0)}%), needs manual review`
    };
  }

  // Classification succeeded with high confidence - auto-file
  const filedRecord = await fileToDestination(classification.destination, classification.extracted, classification.title);

  await storage.updateInboxLog(inboxLogId, {
    classification,
    status: 'filed',
    filed: {
      destination: classification.destination,
      recordId: filedRecord.id,
      filedAt: new Date().toISOString()
    }
  });

  console.log(`🧠 Retry successful for ${inboxLogId} -> ${classification.destination}`);
  return {
    inboxLog: await storage.getInboxLogById(inboxLogId),
    message: `Successfully classified as ${classification.destination}`
  };
}

/**
 * Mark inbox entry as done
 */
export async function markInboxDone(inboxLogId) {
  const inboxLog = await storage.getInboxLogById(inboxLogId);
  if (!inboxLog) {
    return null;
  }

  const updated = await storage.updateInboxLog(inboxLogId, {
    status: 'done',
    doneAt: new Date().toISOString()
  });

  console.log(`🧠 Marked inbox entry done: ${inboxLogId}`);
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

// Re-export storage functions for convenience
export const loadMeta = storage.loadMeta;
export const updateMeta = storage.updateMeta;
export const getSummary = storage.getSummary;
export const getInboxLog = storage.getInboxLog;
export const getInboxLogById = storage.getInboxLogById;
export const getInboxLogCounts = storage.getInboxLogCounts;
export const getPeople = storage.getPeople;
export const getPersonById = storage.getPersonById;
export const createPerson = storage.createPerson;
export const updatePerson = storage.updatePerson;
export const deletePerson = storage.deletePerson;
export const getProjects = storage.getProjects;
export const getProjectById = storage.getProjectById;
export const createProject = storage.createProject;
export const updateProject = storage.updateProject;
export const deleteProject = storage.deleteProject;
export const getIdeas = storage.getIdeas;
export const getIdeaById = storage.getIdeaById;
export const createIdea = storage.createIdea;
export const updateIdea = storage.updateIdea;
export const deleteIdea = storage.deleteIdea;
export const getAdminItems = storage.getAdminItems;
export const getAdminById = storage.getAdminById;
export const createAdminItem = storage.createAdminItem;
export const updateAdminItem = storage.updateAdminItem;
export const deleteAdminItem = storage.deleteAdminItem;
export const getDigests = storage.getDigests;
export const getLatestDigest = storage.getLatestDigest;
export const getReviews = storage.getReviews;
export const getLatestReview = storage.getLatestReview;
export const getLinks = storage.getLinks;
export const getLinkById = storage.getLinkById;
export const getLinkByUrl = storage.getLinkByUrl;
export const createLink = storage.createLink;
export const updateLink = storage.updateLink;
export const deleteLink = storage.deleteLink;
