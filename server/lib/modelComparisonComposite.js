/** PortOS comparison v1: one stable index, calibrated evidence, explicit estimates. */
import { catalogSlugForProviderModel } from './comparisonModelScope.js';

export const COMPARISON_ANCHOR = 'Artificial Analysis Intelligence Index v4.3.2';
export const COMPARISON_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const effortKey = effort => effort === 'non-reasoning' ? 'none' : effort;
const slug = model => catalogSlugForProviderModel(model.replace(/:(free|batch)$/, '')) || model.replace(/^opencode\//, '');
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
// A family baseline is a research placeholder, never evidence of a generational gain.
const familyKey = model => {
  const name = model.toLowerCase();
  for (const pattern of [/(?:gpt)[^/]*(luna|sol|terra|astra)/, /claude[^/]*(haiku|sonnet|opus|fable)/, /gemini[^/]*(flash|pro)/]) {
    const match = pattern.exec(name);
    if (match) return `${name.includes('claude') ? 'claude' : name.includes('gemini') ? 'gemini' : 'gpt'}:${match[1]}`;
  }
  const gpt = /(?:^|[/])gpt-(\d+(?:\.\d+)?)(?:-|$)/.exec(name);
  if (gpt) return `gpt:${gpt[1]}`;
  return /(?:^|[/:-])(qwen|grok|nemotron|llama|gemma|muse|deepseek|kimi|glm|mistral|codestral|devstral|minimax|mimo|ling|nova|granite|solar|phi|command|lfm|ernie|hy|hunyuan|seed|reka|jamba|mixtral|kat|nex)(?=[^a-z]|$)/.exec(name)?.[1] || null;
};
const latest = (rows, field) => rows.filter(row => row[field]).sort((a, b) =>
  Date.parse(b[field].source.retrievedAt) - Date.parse(a[field].source.retrievedAt) || a.id.localeCompare(b.id))[0];
const evidenceMetric = (row, field, method, estimated = false) => row?.[field] ? {
  value: row[field].value, estimated: estimated || /^(?:PortOS|Publisher) estimate:/i.test(row[field].source.methodology), method, sources: [row[field].source],
} : null;
const derived = (value, metrics, method) => ({ value, estimated: true, method,
  sources: [...new Map(metrics.flatMap(metric => metric.sources).map(source => [source.url + source.retrievedAt, source])).values()],
});

/** Never average raw scores from unlike evaluations. Calibrate only with >=3 shared configurations. */
export function buildModelComparisonComposite(observations, inventory) {
  const slugCache = new Map();
  const modelSlug = model => {
    if (!slugCache.has(model)) slugCache.set(model, slug(model));
    return slugCache.get(model);
  };
  const identity = row => `${modelSlug(row.model)}:${effortKey(row.effort)}`;
  const byModel = new Map();
  const researchByIdentity = new Map();
  for (const row of observations) {
    const key = modelSlug(row.model);
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push(row);
    if (row.quality && row.benchmark === 'PortOS Research Index v1 (AA v4.3.2 scale)') {
      const prior = researchByIdentity.get(identity(row));
      if (!prior || Date.parse(row.quality.source.retrievedAt) > Date.parse(prior.quality.source.retrievedAt)) researchByIdentity.set(identity(row), row);
    }
  }
  const scored = observations.filter(row => row.quality && !row.id.startsWith('portos:'));
  const anchors = new Map();
  for (const row of scored.filter(row => row.benchmark === COMPARISON_ANCHOR)) {
    const key = identity(row);
    const prior = anchors.get(key);
    if (!prior || Date.parse(row.quality.source.retrievedAt) > Date.parse(prior.quality.source.retrievedAt)) anchors.set(key, row);
  }
  const families = new Map();
  for (const row of scored) {
    if (!families.has(row.benchmark)) families.set(row.benchmark, new Map());
    const entries = families.get(row.benchmark);
    const key = identity(row);
    const prior = entries.get(key);
    if (!prior || Date.parse(row.quality.source.retrievedAt) > Date.parse(prior.quality.source.retrievedAt)) entries.set(key, row);
  }
  const calibrated = new Map();
  for (const [benchmark, entries] of families) {
    if (benchmark === COMPARISON_ANCHOR) continue;
    const pairs = [...entries].filter(([key, row]) => anchors.has(key) && !/estimate:/i.test(row.quality.source.methodology) && !/estimate:/i.test(anchors.get(key).quality.source.methodology));
    if (pairs.length < 3) continue;
    // Least-squares mapping preserves the anchor scale; reject inverted or degenerate evidence.
    const xs = pairs.map(([, row]) => row.quality.value);
    const ys = pairs.map(([key]) => anchors.get(key).quality.value);
    const mx = mean(xs), my = mean(ys);
    const variance = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
    const slope = xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0) / variance;
    if (!Number.isFinite(slope) || slope <= 0) continue;
    const residual = Math.sqrt(mean(xs.map((x, index) => (my + slope * (x - mx) - ys[index]) ** 2)));
    if (residual > 10) continue;
    for (const [key, row] of entries) {
      // Do not extrapolate a calibration beyond the shared score range.
      if (row.quality.value < Math.min(...xs) || row.quality.value > Math.max(...xs)) continue;
      const metric = derived(Math.max(0, Math.min(100, my + slope * (row.quality.value - mx))),
        [evidenceMetric(row, 'quality', benchmark), ...pairs.flatMap(([pairKey, pair]) => [evidenceMetric(pair, 'quality', benchmark), evidenceMetric(anchors.get(pairKey), 'quality', COMPARISON_ANCHOR)])],
        `Calibrated ${benchmark} onto ${COMPARISON_ANCHOR}; ${pairs.length} shared configurations; RMS error ${residual.toFixed(1)} points.`);
      if (!calibrated.has(key)) calibrated.set(key, []);
      calibrated.get(key).push(metric);
    }
  }
  const qualityFor = (model, effort) => {
    const key = identity({ model, effort });
    if (anchors.has(key)) return evidenceMetric(anchors.get(key), 'quality', COMPARISON_ANCHOR);
    const research = researchByIdentity.get(key);
    if (research) return evidenceMetric(research, 'quality', research.quality.source.methodology, true);
    const metrics = calibrated.get(key) || [];
    return metrics.length ? derived(median(metrics.map(metric => metric.value)), metrics, 'Median of calibrated public evaluations. ' + metrics.map(metric => metric.method).join(' ')) : null;
  };
  const familyAnchors = new Map();
  for (const row of anchors.values()) {
    const family = familyKey(row.model);
    if (!family) continue;
    if (!familyAnchors.has(family)) familyAnchors.set(family, []);
    familyAnchors.get(family).push(row);
  }
  const rows = [];
  for (const provider of inventory) for (const entry of provider.models) {
    const incomparableReason = /(?:embed|nvclip|lyria|video-detector|deplot|riva-translate|hy-mt|safeguard|gpt-audio|gpt-.*image)/i.test(entry.model)
      ? 'Specialist endpoint: general-intelligence/task-cost evidence is not comparable. Published token rates remain available.'
      : /(?:^|\/)(?:auto(?:-beta)?|free|fusion|pareto-code|bodybuilder|big-pickle|space-bunny-free|dflash)$|^stealth\//i.test(entry.model)
        ? 'Routing or undisclosed model: no fixed public model identity to score. Research requires an attributable model snapshot.' : null;
    const modelRows = byModel.get(modelSlug(entry.model)) || [];
    const knownEfforts = [...new Set(modelRows.filter(row => row.quality).map(row => effortKey(row.effort)))];
    const efforts = entry.efforts.length ? entry.efforts : knownEfforts.length ? knownEfforts : ['unspecified'];
    for (const effort of efforts) {
      let quality = qualityFor(entry.model, effort);
      if (!quality) {
        const rank = COMPARISON_EFFORTS.indexOf(effort);
        const neighbors = knownEfforts.map(level => ({ rank: COMPARISON_EFFORTS.indexOf(level), metric: qualityFor(entry.model, level) }))
          .filter(point => point.rank >= 0 && point.metric).sort((a, b) => a.rank - b.rank);
        const lower = neighbors.filter(point => point.rank < rank).at(-1);
        const upper = neighbors.find(point => point.rank > rank);
        if (rank >= 0 && lower && upper) quality = derived(lower.metric.value + (upper.metric.value - lower.metric.value) * (rank - lower.rank) / (upper.rank - lower.rank),
          [lower.metric, upper.metric], 'Linear interpolation between sourced effort levels of this exact model; effort steps are ordinal, not measured compute.');
        // Boundary efforts use the nearest exact-model evidence, with no invented gain.
        else if (rank >= 0 && neighbors.length) {
          const nearest = neighbors.reduce((a, b) => Math.abs(a.rank - rank) <= Math.abs(b.rank - rank) ? a : b);
          quality = derived(nearest.metric.value, [nearest.metric], 'Nearest effort of this exact model; unknown effort improvement, low confidence.');
        }
      }
      if (!quality) {
        const sameModelEvidence = knownEfforts.map(level => qualityFor(entry.model, level)).filter(Boolean);
        if (sameModelEvidence.length) quality = derived(median(sameModelEvidence.map(metric => metric.value)), sameModelEvidence,
          'Same-model configuration baseline; the published evaluation does not establish this requested effort. Low confidence, research required.');
      }
      if (quality && /gguf|mlx|:\d+b|quantized/i.test(entry.model)) quality = derived(quality.value, [quality], 'Public base-model reference for a local build; quantization and runtime differences have not been measured.');
      const familyRows = familyAnchors.get(familyKey(modelSlug(entry.model))) || [];
      const baseline = (field, candidates) => {
        const values = candidates.filter(row => row[field] && (field === 'quality' || row[field].value > 0));
        if (!values.length) return null;
        const metrics = values.map(row => evidenceMetric(row, field, COMPARISON_ANCHOR));
        return derived(median(metrics.map(metric => metric.value)), metrics,
          `Low-confidence family baseline, not a measurement of ${entry.model}: median of ${values.length} ${familyKey(modelSlug(entry.model))} reference configurations (${[...new Set(values.map(row => row.model))].slice(0, 3).join(', ') + (values.length > 3 ? ', …; full evidence below' : '')}). No generational improvement or endpoint price is known; research required. Reference range ${Math.min(...metrics.map(metric => metric.value)).toFixed(2)}–${Math.max(...metrics.map(metric => metric.value)).toFixed(2)}.`);
      };
      if (!quality) {
        const sameEffort = familyRows.filter(row => effortKey(row.effort) === effort);
        quality = baseline('quality', sameEffort.length ? sameEffort : familyRows);
      }
      const price = field => {
        // Exact endpoint/tier first; otherwise show an explicitly labeled API reference.
        const route = row => /^OpenRouter routed model (.+); standard pricing tier$/.exec(row.configuration || '')?.[1];
        const standardTier = row => !/above \d|minimum \d|long.context|batch|:free/i.test(row.configuration || '');
        const exact = modelRows.filter(row => row[field] && (
          (row.model === entry.model && row.provider === provider.name && standardTier(row)) ||
          (provider.gateway === 'openrouter' && route(row) === entry.model) ||
          (entry.model.startsWith('opencode/') && /OpenCode Zen/i.test(row.provider) && standardTier(row) && row.model.replace(/^opencode\//, '') === entry.model.slice('opencode/'.length))
        ));
        const standard = modelRows.filter(row => row[field] && standardTier(row));
        const firstParty = standard.filter(row => row.billing !== 'free' && /^(?:Artificial Analysis|Official API)/.test(row.benchmark));
        const row = latest(exact, field) || latest(firstParty, field) || latest(standard.filter(row => row.billing !== 'free'), field);
        return evidenceMetric(row, field, row ? `API reference from ${row.provider}: ${row[field].source.methodology}` : '', false) || baseline(field, familyRows);
      };
      if (incomparableReason) quality = null;
      const input = price('inputPerMillion'), output = price('outputPerMillion');
      const blended = input && output ? { ...derived((3 * input.value + output.value) / 4, [input, output], '3:1 uncached input/output token mix; USD per 1M total tokens. API reference, not subscription or local operating cost.'), estimated: input.estimated || output.estimated } : null;
      const taskRow = latest(modelRows.filter(row => effortKey(row.effort) === effort && row.benchmark === COMPARISON_ANCHOR), 'costPerTask');
      rows.push({ id: `${provider.id}:${entry.model}:${effort}`, providerId: provider.id, provider: provider.name,
        model: entry.model, comparisonModel: modelSlug(entry.model), modelKey: `${provider.id}:${entry.model}`, effort, quality, incomparableReason,
        inputPerMillion: input, outputPerMillion: output, blendedPerMillion: blended,
        costPerTask: incomparableReason ? null : evidenceMetric(taskRow, 'costPerTask', `${COMPARISON_ANCHOR} task cost; API reference`, false),
        needsResearch: !quality || quality.estimated || !input || !output || input.estimated || output.estimated,
      });
    }
  }
  // Repeated family/effort estimates share evidence; intern it once on the wire.
  const sources = [];
  const sourceIds = new Map();
  for (const row of rows) for (const field of ['quality', 'inputPerMillion', 'outputPerMillion', 'blendedPerMillion', 'costPerTask']) {
    const metric = row[field];
    if (!metric) continue;
    metric.sourceIds = metric.sources.map(source => {
      const key = JSON.stringify(source);
      if (!sourceIds.has(key)) { sourceIds.set(key, sources.length); sources.push(source); }
      return sourceIds.get(key);
    });
    delete metric.sources;
  }
  return { version: 1, anchor: COMPARISON_ANCHOR, sources, rows };
}
