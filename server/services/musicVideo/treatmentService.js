/**
 * Music Video — treatment workflow (#8980): edit, compile, preview/apply and
 * proof review over the pure transforms in treatment.js / treatmentDraft.js.
 *
 * Every write goes through `mutateProjectRecord`, so its revision/basis checks
 * run against the freshest record under the backend's write serialization.
 * Compile is the only step that can call an AI provider, and only when the
 * director asks for it (an explicit route call with `useAi` not false): the
 * provider call runs OUTSIDE the lock against a snapshot, and the result is
 * refused if the treatment or any input changed meanwhile. A missing/disabled
 * provider, a failed call or an unusable answer degrades to the deterministic
 * draft and says why.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { runPromptThroughProvider } from '../promptRunner.js';
import { effortArg, recordLlmRoute, resolveMusicVideoLlm } from './llmRoute.js';
import { getProject, mutateProjectRecord } from './projects.js';
import {
  applyTreatmentPatch,
  applyTreatmentToProject,
  buildApplyPreview,
  reviewTreatmentProof,
  treatmentBasis,
  writeCompiledTreatment,
} from './treatment.js';
import {
  MAX_SHOTS_FOR_AI,
  buildTreatmentDraft,
  buildTreatmentPrompt,
  mergeAiTreatment,
  parseTreatmentResponse,
} from './treatmentDraft.js';

async function requireProject(id) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

/** Edit the brief / arc / shot directions, or rebase onto the current inputs. */
export async function updateTreatment(id, patch) {
  const { project } = await mutateProjectRecord(id, (current) => ({ project: applyTreatmentPatch(current, patch) }));
  return { project, treatment: project.treatment };
}

async function refineWithAi(project, draft, { providerId, model, effort }) {
  if (draft.shotDirections.length > MAX_SHOTS_FOR_AI) return { draft, reason: 'too-many-shots', used: null, route: null };
  // Request pin > the brief's treatment pin > its direction LLM > an eligible TUI provider > the active one (llmRoute.js).
  const { provider, selectedModel, route } = await resolveMusicVideoLlm({ providerId, model, effort, automation: project.automation, stage: 'treatment' }).catch((err) => {
    console.warn(`⚠️ Music Video treatment: provider resolution failed for ${project.id}: ${err.message}`);
    return { provider: null, selectedModel: null, route: null };
  });
  if (!provider) return { draft, reason: 'no-provider', used: null, route: null };
  if (provider.enabled === false) return { draft, reason: 'provider-disabled', used: null, route };
  const used = { providerId: provider.id, model: selectedModel || null };
  let text;
  try {
    ({ text } = await runPromptThroughProvider({
      provider,
      model: selectedModel,
      ...effortArg(route),
      prompt: buildTreatmentPrompt(project, draft),
      source: 'music-video-treatment',
    }));
  } catch (err) {
    console.warn(`⚠️ Music Video treatment: LLM call failed for ${project.id}: ${err.message}`);
    return { draft, reason: 'llm-failed', used: null, route };
  }
  const parsed = parseTreatmentResponse(text);
  if (!parsed) {
    console.warn(`⚠️ Music Video treatment: unusable response for ${project.id}`);
    return { draft, reason: 'unparsable-response', used: null, route };
  }
  return { draft: mergeAiTreatment(project, draft, parsed), reason: null, used, route };
}

/**
 * Compile the treatment from the project's current inputs. Explicit user
 * action only. Returns `{ project, treatment, aiUsed, aiSkippedReason, llmRoute }`;
 * `llmRoute` is the effective provider/model/effort the AI call ran on (null when
 * AI was not requested or no provider resolved).
 */
export async function compileTreatment(id, { baseRevision, useAi = true, providerId, model, effort }) {
  const project = await requireProject(id);
  const basis = treatmentBasis(project);
  let draft = buildTreatmentDraft(project);
  let aiSkippedReason = useAi ? null : 'not-requested';
  let used = null;
  let llmRoute = null;
  if (useAi) {
    let route;
    ({ draft, reason: aiSkippedReason, used, route } = await refineWithAi(project, draft, { providerId, model, effort }));
    llmRoute = route || null;
  }
  const compiledWith = used ? { source: 'ai', ...used } : { source: 'deterministic', providerId: null, model: null };
  const { project: updated } = await mutateProjectRecord(id, (current) => ({
    project: writeCompiledTreatment(current, { baseRevision, draft, basis, compiledWith }),
  }));
  // The route is shown beside Compile; remember it only when the model actually answered.
  const persisted = (used && await recordLlmRoute(id, 'treatment', llmRoute)) || updated;
  const log = aiSkippedReason && useAi ? console.warn : console.log;
  log(`🎬 Music Video treatment: compiled ${draft.shotDirections.length} shot direction${draft.shotDirections.length === 1 ? '' : 's'} for ${id} (${used ? 'ai' : `deterministic${aiSkippedReason ? `: ${aiSkippedReason}` : ''}`})`);
  return { project: persisted, treatment: persisted.treatment, aiUsed: !!used, aiSkippedReason, llmRoute };
}

/** What Apply would change right now (read-only). */
export async function previewTreatmentApply(id) {
  return buildApplyPreview(await requireProject(id));
}

/** Apply the reviewed treatment revision to the board. */
export async function applyTreatment(id, options) {
  const outcome = await mutateProjectRecord(id, (current) => applyTreatmentToProject(current, options));
  const { result } = outcome;
  console.log(`🎬 Music Video treatment: applied to ${result.directed} scene${result.directed === 1 ? '' : 's'} of ${id} (${result.promptsWritten.length} prompts written, ${result.promptsKept.length} kept)`);
  return { project: outcome.project, result };
}

/** Record a proof-checklist verdict. */
export async function reviewProof(id, proofId, review) {
  const { project } = await mutateProjectRecord(id, (current) => ({ project: reviewTreatmentProof(current, proofId, review) }));
  return { project, treatment: project.treatment };
}
