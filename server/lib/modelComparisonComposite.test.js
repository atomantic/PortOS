import { expect, it } from 'vitest';
import { buildModelComparisonComposite, COMPARISON_ANCHOR } from './modelComparisonComposite.js';
const metric = value => ({ value, source: { url: 'https://example.com/results', retrievedAt: '2026-09-01T00:00:00Z', methodology: 'Published result' } });
const observation = (model, effort, value, extra = {}) => ({ id: `${model}-${effort}`, model, effort, provider: 'Example', benchmark: COMPARISON_ANCHOR, quality: value === null ? null : metric(value), inputPerMillion: metric(1), outputPerMillion: metric(5), ...extra });
const inventory = (model, efforts = ['low', 'medium', 'high']) => [{ id: 'example', name: 'Example', models: [{ model, efforts }] }];

it('compares generations and vendors on a stable scale, interpolates only missing efforts, and retains unknown models', () => {
  const observations = [observation('example-old', 'low', 20), observation('example-old', 'high', 40), observation('example-new', 'low', 30), observation('example-new', 'high', 50)];
  const providers = [...inventory('example-old'), { ...inventory('example-new')[0], id: 'other' }, { ...inventory('unknown')[0], id: 'unknown' }];
  const { rows } = buildModelComparisonComposite(observations, providers);
  expect(rows.map(row => row.quality?.value ?? null)).toEqual([20, 30, 40, 30, 40, 50, null, null, null]);
  expect(rows[1].quality.estimated).toBe(true);
  expect(rows[0].quality.estimated).toBe(false);
  expect(rows[0].blendedPerMillion.value).toBe(2);
  expect(rows[6].needsResearch).toBe(true);
  expect(rows[6].blendedPerMillion).toBeNull();
  expect(buildModelComparisonComposite(observations, inventory('example-old')).rows).toEqual(rows.slice(0, 3));
});

it('calibrates unlike scores with shared configurations and does not average raw scales or extrapolate', () => {
  const anchors = ['a', 'b', 'c'].map((model, i) => observation(model, 'high', 20 + i * 10));
  const other = ['a', 'b', 'c', 'd', 'e'].map((model, i) => observation(model, 'high', [100, 200, 300, 150, 900][i], { id: `other-${model}`, benchmark: 'Other evaluation v1' }));
  const result = buildModelComparisonComposite([...anchors, ...other], inventory('d', ['high'])).rows[0];
  expect(result.quality.value).toBe(25);
  expect(result.quality.estimated).toBe(true);
  expect(result.quality.method).toContain('3 shared configurations');
  expect(buildModelComparisonComposite([...anchors, ...other], inventory('e', ['high'])).rows[0].quality).toBeNull();
  expect(buildModelComparisonComposite([...anchors.slice(0, 2), ...other], inventory('d', ['high'])).rows[0].quality).toBeNull();
});

it('keeps zero-priced exact endpoints, separates task workloads, and labels publisher estimates', () => {
  const observations = [observation('vendor/example:free', 'high', 40, { inputPerMillion: metric(0), outputPerMillion: metric(0), provider: 'Example', quality: { ...metric(40), source: { ...metric(40).source, methodology: 'Publisher estimate: score' } }, costPerTask: metric(0.1) }), observation('example', 'high', 90, { id: 'other', benchmark: 'Unrelated task suite', costPerTask: metric(100) })];
  const row = buildModelComparisonComposite(observations, inventory('vendor/example:free', ['high'])).rows[0];
  expect(row.blendedPerMillion.value).toBe(0);
  expect(row.quality.estimated).toBe(true);
  expect(row.costPerTask.value).toBe(0.1);
});

it('uses route-specific standard prices without leaking free or long-context prices to paid routes', () => {
  const prices = [
    observation('gpt-example', 'high', 30),
    observation('gpt-example', 'unspecified', null, { id: 'route-paid', provider: 'OpenRouter', configuration: 'OpenRouter routed model vendor/gpt-example; standard pricing tier', inputPerMillion: metric(2), outputPerMillion: metric(10) }),
    observation('gpt-example', 'unspecified', null, { id: 'route-free', provider: 'OpenRouter', configuration: 'OpenRouter routed model vendor/gpt-example:free; standard pricing tier', inputPerMillion: metric(0), outputPerMillion: metric(0) }),
    observation('gpt-example', 'unspecified', null, { id: 'route-long', provider: 'OpenRouter', configuration: 'OpenRouter routed model vendor/gpt-example; minimum 200000 prompt tokens pricing tier', inputPerMillion: metric(20), outputPerMillion: metric(100) }),
  ];
  const providers = [{ id: 'router', name: 'Example router', gateway: 'openrouter', models: [{ model: 'vendor/gpt-example', efforts: ['high'] }, { model: 'vendor/gpt-example:free', efforts: ['high'] }] }];
  const { rows } = buildModelComparisonComposite(prices, providers);
  expect(rows.map(row => row.blendedPerMillion.value)).toEqual([4, 0]);
  expect(rows.map(row => row.quality.value)).toEqual([30, 30]);
});

it('marks new-generation family baselines as estimates and preserves their evidence', () => {
  const observations = [observation('gpt-5-luna', 'high', 30), observation('gpt-6-luna', 'high', 40)];
  const { rows, sources } = buildModelComparisonComposite(observations, inventory('gpt-7-luna', ['high']));
  expect(rows[0].quality).toMatchObject({ value: 35, estimated: true });
  expect(rows[0].quality.method).toContain('Low-confidence family baseline');
  expect(rows[0].needsResearch).toBe(true);
  expect(rows[0].quality.sourceIds.every(id => sources[id].url.startsWith('https://'))).toBe(true);
});

it('uses same-model evidence with unknown effort before a broader family estimate', () => {
  const observations = [observation('gpt-oss-20b', 'unspecified', 25)];
  const { rows } = buildModelComparisonComposite(observations, inventory('gpt-oss-20b', ['low']));
  expect(rows[0].quality).toMatchObject({ value: 25, estimated: true });
  expect(rows[0].quality.method).toContain('Same-model configuration baseline');
});

it('keeps the standard first-party price when a newer long-context tier shares the provider name', () => {
  const standard = observation('grok-4.7', 'unspecified', null, { provider: 'xAI', id: 'standard', benchmark: 'Official API pricing', configuration: 'Standard context' });
  const long = { ...standard, id: 'long-context', configuration: 'Above 200000 context tokens', inputPerMillion: metric(10), outputPerMillion: metric(50) };
  const providers = [{ id: 'xai', name: 'xAI', models: [{ model: 'grok-4.7', efforts: [] }] }];
  expect(buildModelComparisonComposite([standard, long], providers).rows[0].blendedPerMillion.value).toBe(2);
});
