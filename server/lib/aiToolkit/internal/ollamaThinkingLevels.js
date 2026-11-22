/**
 * Ollama thinking levels per model family, the effort ladder an Ollama API provider offers.
 *
 * Ollama's native `think` field takes a level string for models whose template
 * supports one (`/api/show` → `thinking.values`), not just a boolean. Pure and
 * browser-safe so the effort picker and the runner read one table.
 */

// Families whose Ollama template takes a thinking level, weakest first.
const FAMILY_LEVELS = Object.freeze([
  [/(?:^|[/:_-])inkling/i, Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])],
  [/(?:^|[/:_-])gpt-oss/i, Object.freeze(['low', 'medium', 'high'])],
]);

/**
 * The thinking levels `model` accepts as Ollama's `think`, or null when it takes only a boolean or none.
 * @param {string|null|undefined} model
 * @returns {readonly string[]|null}
 */
export function ollamaThinkingLevelsForModel(model) {
  if (typeof model !== 'string' || !model) return null;
  for (const [pattern, levels] of FAMILY_LEVELS) if (pattern.test(model)) return levels;
  return null;
}

/**
 * The `think` value for a run: a supported `effort` level wins over the
 * provider's boolean `thinking`; an unsupported effort is ignored.
 * @param {string|null|undefined} model
 * @param {string|null|undefined} effort
 * @returns {string|null}
 */
export function ollamaThinkLevel(model, effort) {
  const levels = ollamaThinkingLevelsForModel(model);
  return levels && typeof effort === 'string' && levels.includes(effort) ? effort : null;
}
