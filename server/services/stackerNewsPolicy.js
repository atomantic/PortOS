import { createHash } from 'crypto';
import { z } from 'zod';

export const POLICY_VERSION = 'v1';
const ACTIONS = ['none', 'draft_comment', 'draft_post', 'open_browser', 'territory_setting'];

export const modelAnalysisSchema = z.object({
  classification: z.enum(['allowed', 'review', 'escalate']),
  risk: z.enum(['low', 'medium', 'high']),
  summary: z.string().max(1_200),
  findings: z.array(z.string().max(300)).max(12),
  suggestedAction: z.enum(ACTIONS),
}).strict();

const strings = (value) => Array.isArray(value)
  ? [...new Set(value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))].slice(0, 50)
  : [];
const boundedInt = (value, fallback, min, max) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;

export function normalizeStackerNewsRules(value = {}) {
  const rules = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    guidance: typeof rules.guidance === 'string' ? rules.guidance.slice(0, 4_000) : '',
    tone: typeof rules.tone === 'string' ? rules.tone.slice(0, 500) : '',
    allowedThemes: strings(rules.allowedThemes),
    disallowedThemes: strings(rules.disallowedThemes),
    escalationCues: strings(rules.escalationCues),
    desiredEngagement: strings(rules.desiredEngagement),
    actionBudget: {
      maxPerHour: boundedInt(rules.actionBudget?.maxPerHour, 3, 1, 50),
      maxPerDay: boundedInt(rules.actionBudget?.maxPerDay, 12, 1, 200),
      minMinutesBetween: boundedInt(rules.actionBudget?.minMinutesBetween, 5, 0, 1_440),
    },
  };
}

export function normalizeStackerNewsRuleOverrides(value = {}) {
  const rules = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = normalizeStackerNewsRules(rules);
  const rawBudget = rules.actionBudget && typeof rules.actionBudget === 'object' && !Array.isArray(rules.actionBudget)
    ? rules.actionBudget
    : {};
  return {
    ...normalized,
    actionBudget: Object.fromEntries(Object.keys(normalized.actionBudget)
      .filter((key) => Number.isInteger(rawBudget[key]))
      .map((key) => [key, normalized.actionBudget[key]])),
  };
}

export function resolveStackerNewsRules(accountRules, territoryRules, inheritAccountRules = true) {
  const account = normalizeStackerNewsRules(accountRules);
  const territory = normalizeStackerNewsRules(territoryRules);
  if (!inheritAccountRules) return territory;
  const choose = (key) => territory[key] || account[key];
  const combine = (key) => [...new Set([...account[key], ...territory[key]])];
  return {
    guidance: choose('guidance'),
    tone: choose('tone'),
    allowedThemes: combine('allowedThemes'),
    disallowedThemes: combine('disallowedThemes'),
    escalationCues: combine('escalationCues'),
    desiredEngagement: combine('desiredEngagement'),
    actionBudget: {
      ...account.actionBudget,
      ...(territoryRules?.actionBudget && typeof territoryRules.actionBudget === 'object'
        ? Object.fromEntries(Object.keys(account.actionBudget)
          .filter((key) => Number.isInteger(territoryRules.actionBudget[key]))
          .map((key) => [key, territory.actionBudget[key]]))
        : {}),
    },
  };
}

export const hashStackerNewsRules = (rules) => createHash('sha256')
  .update(JSON.stringify(normalizeStackerNewsRules(rules)))
  .digest('hex');

export function parseStackerNewsModelResult(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return modelAnalysisSchema.parse(parsed);
}

export function combineStackerNewsModelResults(...results) {
  const available = results.flat().filter(Boolean).map((result) => modelAnalysisSchema.parse(result));
  if (!available.length) return null;
  if (available.length === 1) return available[0];
  const classificationRank = { allowed: 0, review: 1, escalate: 2 };
  const riskRank = { low: 0, medium: 1, high: 2 };
  const classification = available.reduce((worst, result) => (
    classificationRank[result.classification] > classificationRank[worst] ? result.classification : worst
  ), 'allowed');
  const risk = available.reduce((worst, result) => (
    riskRank[result.risk] > riskRank[worst] ? result.risk : worst
  ), 'low');
  const suggestedActions = new Set(available.map((result) => result.suggestedAction));
  return {
    classification,
    risk,
    summary: available.map((result) => result.summary).filter(Boolean).join(' | ').slice(0, 1_200),
    findings: [...new Set(available.flatMap((result) => result.findings))].slice(0, 12),
    suggestedAction: suggestedActions.size === 1 ? available[0].suggestedAction : 'none',
  };
}

export function evaluateStackerNewsPolicy({ deterministic, model, rules }) {
  // The shared phase-1 boundary outranks the local heuristic: when it blocked
  // the item no model ran at all, so there is no verdict to weigh and the
  // screening code is the only honest reason to record.
  if (deterministic.screeningCode) return { decision: 'escalate', reasons: [`untrusted_content_screening:${deterministic.screeningCode}`], allowedAction: 'none' };
  if (deterministic.injectionMatches?.length) return { decision: 'escalate', reasons: ['prompt_injection_pattern'], allowedAction: 'none' };
  if (model?.classification === 'escalate' || model?.risk === 'high') return { decision: 'escalate', reasons: ['model_high_risk'], allowedAction: 'none' };
  const content = `${model?.summary || ''} ${(model?.findings || []).join(' ')}`.toLowerCase();
  const disallowed = normalizeStackerNewsRules(rules).disallowedThemes.filter((theme) => content.includes(theme.toLowerCase()));
  if (disallowed.length) return { decision: 'review', reasons: disallowed.map((theme) => `disallowed_theme:${theme}`), allowedAction: 'none' };
  const suggested = ACTIONS.includes(model?.suggestedAction) ? model.suggestedAction : 'none';
  return { decision: model?.classification || 'review', reasons: [], allowedAction: suggested };
}
