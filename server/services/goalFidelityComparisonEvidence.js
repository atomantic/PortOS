import { execGit } from '../lib/execGit.js';

const CATALOG_PATH = 'data.reference/model-comparison.json';
const COMMIT = /^[a-f0-9]{40,64}$/;
const tokens = text => (text.toLowerCase().match(/[a-z]+|\d+/g) || []).join(' ');
// Do not match a shorter version such as "model 5" inside "model 5 2".
const containsTokens = (text, value) => new RegExp(`(?:^| )${value}(?=$| )(?! \\d)`).test(text);
const measured = metric => Number.isFinite(metric?.value) && typeof metric.source?.methodology === 'string'
  && !/estimate:/i.test(metric.source.methodology);

// Limit this context to the production path that exposed the already-shipped
// observations in #15627. Other changes keep the ordinary diff-only review.
function exposedAnchor(diff) {
  const added = path => {
    const section = diff.split(/(?=^diff --git )/m).find(part => part.startsWith(`diff --git a/${path} b/${path}\n`));
    return section?.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n') || '';
  };
  const route = added('server/routes/modelComparison.js');
  const chart = added('client/src/components/models/ModelComparison.jsx');
  const composite = added('server/lib/modelComparisonComposite.js');
  if (!/^\+\s*const currentComposite = buildModelComparisonComposite\(catalog\.observations, inventory, CURRENT_COMPARISON_ANCHOR\);$/m.test(route)
      || !/^\+\s*res\.json\(\{ \.\.\.catalog, inventory, composite, currentComposite \}\);$/m.test(route)
      || !/^\+\s*const composites = \[catalog\?\.currentComposite, catalog\?\.composite\]\.filter\(Boolean\);$/m.test(chart)
      || !/^\+\s*const composite = composites\.find\(item => item\.anchor === settings\.anchor\) \|\| composites\[0\];$/m.test(chart)
      || !/^\+\s*const rows = useMemo\(\(\) => \(composite\?\.rows \|\| \[\]\)\.map\(row => \{$/m.test(chart)) return null;
  return /^\+export const CURRENT_COMPARISON_ANCHOR = '([^'\n]+)';$/m.exec(composite)?.[1] || null;
}

// A task may omit the vendor prefix ("Example 5.2" vs "vendor-example-5.2").
// Require a version and the full catalog model in the diff, not a vague family.
function mentionsModel(objective, diff, model) {
  const parts = tokens(model).split(' ');
  if (parts.length < 2 || !containsTokens(diff, parts.join(' '))) return false;
  return parts.some((_, index) => {
    const suffix = parts.slice(index);
    return suffix.length >= 2 && suffix.some(part => /^[a-z]{3,}$/.test(part))
      && suffix.some(part => /^\d+$/.test(part)) && containsTokens(objective, suffix.join(' '));
  });
}

/**
 * Existing comparison rows are production inputs, but a run-window diff cannot
 * show them. Read only this tracked reference file at both pinned commits and
 * include unchanged rows for models named by both the task and its diff. This
 * supplies evidence, not a verdict or proof the chart consumes the records.
 */
export async function comparisonReferenceEvidence({ workspacePath, base, head, objective, diff, maxChars }) {
  if (!workspacePath || !COMMIT.test(base || '') || !COMMIT.test(head || '')
      || typeof objective !== 'string' || !/\bcomparison\b/i.test(objective)
      || typeof diff !== 'string' || maxChars <= 0) return null;
  const anchor = exposedAnchor(diff);
  if (!anchor) return null;
  const readCatalog = async commit => {
    const result = await execGit(['show', `${commit}:${CATALOG_PATH}`], workspacePath,
      { ignoreExitCode: true, timeout: 10_000 }).catch(() => null);
    if (result?.exitCode !== 0) return null;
    return JSON.parse(result.stdout);
  };
  const [before, after] = await Promise.all([readCatalog(base), readCatalog(head)]).catch(() => []);
  if (!Array.isArray(before?.observations) || !Array.isArray(after?.observations)) return null;
  const previous = new Map(before.observations.filter(row => typeof row?.id === 'string').map(row => [row.id, JSON.stringify(row)]));
  const objectiveTokens = tokens(objective);
  const diffTokens = tokens(diff);
  const models = new Map();
  const rows = after.observations.filter(row => {
    if (typeof row?.id !== 'string' || typeof row.model !== 'string' || row.benchmark !== anchor
        || !measured(row.quality) || !measured(row.costPerTask)
        || previous.get(row.id) !== JSON.stringify(row)) return false;
    if (!models.has(row.model)) models.set(row.model, mentionsModel(objectiveTokens, diffTokens, row.model));
    return models.get(row.model);
  }).map(({ id, provider, model, effort, benchmark, quality, costPerTask }) =>
    ({ id, provider, model, effort, benchmark, quality, costPerTask }));
  if (!rows.length) return null;
  const evidence = JSON.stringify(rows, null, 2);
  return evidence.length <= maxChars ? evidence : null;
}
