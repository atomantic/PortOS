/**
 * Texture baking (#17879) at the pure boundaries: the describe().bake plan, the driver events that carry it, and
 * the report's bake findings. The build, cancel and reuse workflows run through the routes in
 * routes/blenderModels.test.js.
 */
import { describe, expect, it } from 'vitest';
import { planBlenderModelBake } from './bakePlan.js';
import { parseBlenderModelDriverLine } from './protocol.js';
import { buildBlenderModelReport, collectBlenderModelFacts } from './report.js';
import { recordedStarterEvents } from './__modelFixture.js';

const PARTS = ['base', 'stem', 'shade'];
const line = (event) => `PORTOS_MODEL ${JSON.stringify(event)}`;
const parsedBake = (bake) => parseBlenderModelDriverLine(line({ event: 'described', bake })).bake;
// Events reach the report as the driver protocol parses them, as in a real build.
const ingest = (collector, events) => events.forEach((event) => collector.add(parseBlenderModelDriverLine(line(event))));
const valid = { size: 2048, samples: 32, sets: [{ id: 'metal', partIds: ['base', 'stem'] }, { id: 'cloth', partIds: ['shade'] }] };

describe('describe().bake plan', () => {
  it('accepts sets of declared parts and answers none when nothing is asked', () => {
    expect(planBlenderModelBake(null, PARTS)).toMatchObject({ requested: false, sets: [], problems: [] });
    expect(planBlenderModelBake(parsedBake(valid), PARTS)).toEqual({
      requested: true, size: 2048, samples: 32, problems: [],
      sets: [{ id: 'metal', partIds: ['base', 'stem'] }, { id: 'cloth', partIds: ['shade'] }],
    });
  });

  it.each([
    ['size', { ...valid, size: 512 }, 'bake-size-invalid'],
    ['a text size', { ...valid, size: '2048' }, 'bake-size-invalid'],
    ['samples of zero', { ...valid, samples: 0 }, 'bake-samples-invalid'],
    ['fractional samples', { ...valid, samples: 2.5 }, 'bake-samples-invalid'],
    ['too many samples', { ...valid, samples: 5000 }, 'bake-samples-invalid'],
    ['no sets', { ...valid, sets: [] }, 'bake-sets-invalid'],
    ['sets that are not a list', { ...valid, sets: 'metal' }, 'bake-sets-invalid'],
    ['a set with no id', { ...valid, sets: [{ partIds: ['base'] }] }, 'bake-set-invalid'],
    ['a set with an id Blender cannot use as a folder', { ...valid, sets: [{ id: '../x', partIds: ['base'] }] }, 'bake-set-invalid'],
    ['a set with no parts', { ...valid, sets: [{ id: 'metal', partIds: [] }] }, 'bake-set-invalid'],
    ['a set that is not an object', { ...valid, sets: ['metal'] }, 'bake-set-invalid'],
    ['two sets with one id', { ...valid, sets: [{ id: 'a', partIds: ['base'] }, { id: 'a', partIds: ['stem'] }] }, 'bake-set-duplicate'],
    ['an undeclared part', { ...valid, sets: [{ id: 'metal', partIds: ['base', 'handle'] }] }, 'bake-part-unknown'],
    ['a part in two sets', { ...valid, sets: [{ id: 'a', partIds: ['base'] }, { id: 'b', partIds: ['base', 'stem'] }] }, 'bake-part-shared'],
  ])('names %s', (_label, bake, code) => {
    const plan = planBlenderModelBake(parsedBake(bake), PARTS);
    expect(plan.problems.map((problem) => problem.code)).toContain(code);
    expect(plan.sets).toEqual([]);
  });

  it('refuses a bake that is not a dict, and bounds an oversized one', () => {
    expect(planBlenderModelBake(parsedBake('sets'), PARTS).problems.map((problem) => problem.code)).toEqual(['bake-invalid']);
    const many = { ...valid, sets: Array.from({ length: 70 }, (_, index) => ({ id: `set${index}`, partIds: ['base'] })) };
    const parsed = parsedBake(many);
    expect(parsed.sets).toHaveLength(64);
    expect(planBlenderModelBake(parsed, PARTS).problems.map((problem) => problem.code)).toContain('bake-sets-invalid');
  });
});

describe('bake driver events', () => {
  it('reduces bakeSet and bakeResult to the fields the server reads', () => {
    expect(parseBlenderModelDriverLine(line({ event: 'bakeSet', id: 'metal', partIds: ['base', 1], hash: 'a'.repeat(64), uvOverlap: 0.01, unwrapped: true, extra: 'x' })))
      .toEqual({ event: 'bakeSet', id: 'metal', partIds: ['base', null], hash: 'a'.repeat(64), uvOverlap: 0.01, unwrapped: true });
    expect(parseBlenderModelDriverLine(line({ event: 'bakeSet', id: 'metal', hash: 'not-a-hash', uvOverlap: 'x' }))).toMatchObject({ hash: null, uvOverlap: null, unwrapped: false });
    expect(parseBlenderModelDriverLine(line({
      event: 'bakeResult', id: 'metal', size: 1024, samples: 8, device: 'CPU',
      images: [{ name: 'normal', file: 'normal.png', max: 255 }, { name: 'secret', file: 'x', max: 1 }],
    }))).toEqual({ event: 'bakeResult', id: 'metal', size: 1024, samples: 8, device: 'CPU', images: [{ name: 'normal', file: 'normal.png', max: 255 }] });
    expect(parseBlenderModelDriverLine(line({ event: 'saved', deferred: true, glb: null }))).toMatchObject({ deferred: true, glb: null });
  });
});

describe('bake findings in the build report', () => {
  const image = (name, file, overrides = {}) => ({ name, file, bytes: 4096, max: 200, ...overrides });
  const set = (id, partIds, overrides = {}) => ({
    id, partIds, hash: 'a'.repeat(64), size: 1024, samples: 8, uvOverlap: 0, unwrapped: true, reused: false, reusedFrom: null, device: 'CPU', skipped: null,
    images: [image('baseColor', 'base_color.png'), image('normal', 'normal.png'), image('orm', 'orm.png')], ...overrides,
  });
  const plan = { size: 1024, samples: 8, sets: [{ id: 'metal', partIds: ['base', 'stem'] }, { id: 'cloth', partIds: ['shade'] }] };

  function reportFor({ quality = 'full', bake, described = plan, reimportImages = 6 } = {}) {
    const collector = collectBlenderModelFacts();
    ingest(collector, recordedStarterEvents().map((event) => (event.event === 'described' ? { ...event, bake: described }
      : event.event === 'reimport' ? { ...event, images: reimportImages } : event)));
    return buildBlenderModelReport(collector.facts(), { modelId: 'bmodel-x', buildId: 'build-x', quality, startedAt: 'a', finishedAt: 'b', srcHash: 'h', glbBytes: 100, bake });
  }
  const finding = (report, code) => report.findings.find((entry) => entry.code === code);

  it('records the texture size, samples and reuse of each set, and stays publishable', () => {
    const report = reportFor({ bake: { sets: [set('metal', ['base', 'stem']), set('cloth', ['shade'], { reused: true, reusedFrom: 'build-w' })] } });
    expect(report.publishable).toBe(true);
    expect(report.checks.bake).toMatchObject({ size: 1024, samples: 8, skipped: null });
    expect(report.checks.bake.sets).toMatchObject([{ id: 'metal', reused: false }, { id: 'cloth', reused: true, reusedFrom: 'build-w' }]);
    expect(finding(report, 'bake-sets')).toMatchObject({ severity: 'note', values: { size: 1024, samples: 8, sets: 2, reused: 1 } });
  });

  it('says a draft build skipped baking, without an error', () => {
    const report = reportFor({ quality: 'draft', bake: null });
    expect(finding(report, 'bake-skipped-draft')).toMatchObject({ severity: 'note' });
    expect(report.checks.bake).toMatchObject({ skipped: 'draft', sets: [] });
    expect(report.publishable).toBe(true);
  });

  it('has no bake check when describe() asked for none', () => {
    const collector = collectBlenderModelFacts();
    ingest(collector, recordedStarterEvents());
    const report = buildBlenderModelReport(collector.facts(), { modelId: 'm', buildId: 'b', quality: 'full', startedAt: 'a', finishedAt: 'b', srcHash: 'h', glbBytes: 100 });
    expect(report.checks.bake).toBeNull();
    expect(report.findings.map((entry) => entry.code)).toEqual(['materials']);
  });

  it('errors on an image the bake never wrote', () => {
    const report = reportFor({ bake: { sets: [set('metal', ['base', 'stem']), set('cloth', ['shade'], { images: [image('baseColor', 'base_color.png'), image('normal', 'normal.png', { bytes: null }), image('orm', 'orm.png')] })] } });
    expect(finding(report, 'bake-image-missing')).toMatchObject({ severity: 'error', subjects: ['cloth/normal.png'] });
    expect(report.publishable).toBe(false);
  });

  it('errors on an image with no pixel above black, and not on a dark one', () => {
    const report = reportFor({ bake: { sets: [set('metal', ['base', 'stem'], { images: [image('baseColor', 'base_color.png', { max: 0 }), image('normal', 'normal.png'), image('orm', 'orm.png', { max: 3 })] }), set('cloth', ['shade'])] } });
    expect(finding(report, 'bake-all-black')).toMatchObject({ severity: 'error', subjects: ['metal/base_color.png'] });
    expect(report.publishable).toBe(false);
  });

  it('errors on a UV overlap over 2% and not at 2%', () => {
    const over = reportFor({ bake: { sets: [set('metal', ['base', 'stem'], { uvOverlap: 0.2, skipped: 'uv-overlap', images: [] }), set('cloth', ['shade'])] } });
    expect(finding(over, 'bake-uv-overlap')).toMatchObject({ severity: 'error', subjects: ['metal'], values: { metal: 0.2 } });
    expect(finding(over, 'bake-image-missing')).toBeUndefined();
    expect(over.publishable).toBe(false);
    const edge = reportFor({ bake: { sets: [set('metal', ['base', 'stem'], { uvOverlap: 0.02 }), set('cloth', ['shade'])] } });
    expect(finding(edge, 'bake-uv-overlap')).toBeUndefined();
  });

  it('errors when a part could not be prepared and when nothing was baked', () => {
    const unprepared = reportFor({ bake: { sets: [set('metal', ['base', 'stem'], { skipped: 'not-prepared', hash: null, images: [] }), set('cloth', ['shade'])] } });
    expect(finding(unprepared, 'bake-set-unprepared')).toMatchObject({ severity: 'error', subjects: ['metal'] });
    expect(finding(reportFor({ bake: null }), 'bake-not-run')).toMatchObject({ severity: 'error' });
  });

  it('warns when the re-imported GLB has fewer images than the baked sets', () => {
    const report = reportFor({ reimportImages: 4, bake: { sets: [set('metal', ['base', 'stem']), set('cloth', ['shade'])] } });
    expect(finding(report, 'bake-glb-images')).toMatchObject({ severity: 'warning', values: { expected: 6, reimported: 4 } });
    expect(report.publishable).toBe(true);
  });

  it('turns every plan problem into an error and reports the bake as invalid', () => {
    const report = reportFor({ described: { ...plan, size: 999, samples: 0 }, bake: null });
    expect(report.findings.filter((entry) => entry.severity === 'error').map((entry) => entry.code).sort()).toEqual(['bake-samples-invalid', 'bake-size-invalid']);
    expect(report.checks.bake).toMatchObject({ skipped: 'invalid', sets: [] });
  });
});
