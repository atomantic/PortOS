/**
 * Music Video — plan the promotion as scheduled human action steps.
 *
 * One provider call the artist asked for (the Publish stage's "Plan promotion"
 * button) turns the release into a few dated steps only they can take — post a
 * clip, answer replies, join the conversations their audience is having — each
 * with explicit instructions and the exact text to paste. The steps become
 * Brain threads with reminders (services/humanActions.js), so they appear in
 * Review Hub › Actions and ping when due. PortOS never posts anything itself.
 */
import { ServerError } from '../../lib/errorHandler.js';
import { humanActionPlanSchema } from '../../lib/humanActions.js';
import { getProject } from './projects.js';
import { suggestSocialCuts } from './socialCuts.js';
import { buildPromotionPlanPrompt, parsePromotionPlan, postedLinks, promotionPlanKey } from './promotionPlanText.js';

const planError = (status, code, message) => new ServerError(message, { status, code });

export async function planMusicVideoPromotion(projectId, { providerId = null, model = null, goal = '', audience = '', days = 7 } = {}, deps = {}) {
  const project = await (deps.getProject || getProject)(projectId);
  if (!project) throw planError(404, 'NOT_FOUND', 'Project not found');
  const timezone = deps.timezone || await (await import('../userTimezone.js')).getUserTimezone();
  const cuts = suggestSocialCuts(project, { count: 4, minSec: 15, maxSec: 40 });
  const { resolveProviderAndModel, runPromptThroughProvider } = deps.runner || await import('../promptRunner.js');
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  if (!provider) throw planError(503, 'NO_PROVIDER', 'No AI provider is available to plan the promotion');
  const prompt = buildPromotionPlanPrompt(project, { goal, audience, days, cuts, timezone });
  const { text } = await runPromptThroughProvider({ provider, model: selectedModel, prompt, source: 'music-video-promotion-plan' });
  const steps = parsePromotionPlan(text, { days, timezone, now: deps.now ? deps.now() : Date.now(), allowedLinks: Object.values(postedLinks(project)) });
  if (!steps) throw planError(502, 'PROMOTION_PLAN_UNPARSEABLE', 'The plan came back without usable steps — try again or another model');
  const plan = humanActionPlanSchema.parse({
    planKey: promotionPlanKey(project.id || projectId),
    title: `Promote "${project.name || 'the music video'}"`.slice(0, 120),
    steps,
  });
  const { scheduleHumanActionPlan } = deps.humanActions || await import('../humanActions.js');
  return scheduleHumanActionPlan(plan);
}

/** The project's open promotion steps, soonest first: `{ planKey, steps }`. */
export async function promotionPlanSteps(projectId, deps = {}) {
  const project = await (deps.getProject || getProject)(projectId);
  if (!project) throw planError(404, 'NOT_FOUND', 'Project not found');
  const planKey = promotionPlanKey(project.id || projectId);
  const { listHumanActions } = deps.humanActions || await import('../humanActions.js');
  return { planKey, steps: await listHumanActions({ planKey }) };
}
