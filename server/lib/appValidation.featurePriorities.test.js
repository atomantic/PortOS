import { describe, it, expect } from 'vitest';
import { appSchema, appUpdateSchema } from './appValidation.js';

const entry = (over = {}) => ({ id: 'api', label: 'Public API', paths: ['src/api/**'], priority: 'P0', ...over });
const base = { name: 'Example App', repoPath: '/tmp/example-app' };
const parse = (featurePriorities) => appUpdateSchema.safeParse({ featurePriorities });

describe('app featurePriorities validation', () => {
  it('accepts a well-formed array, trims strings and keeps an optional note', () => {
    const result = parse([entry({ label: '  Public API ', paths: [' src/api/** '], note: ' hot path ' }), entry({ id: 'legacy', label: 'Legacy', paths: ['legacy/**', 'old/*.js'], priority: 'P3' })]);
    expect(result.success).toBe(true);
    expect(result.data.featurePriorities[0]).toEqual({ id: 'api', label: 'Public API', paths: ['src/api/**'], priority: 'P0', note: 'hot path' });
  });

  it('leaves an app saved before this field untouched, on create and on update', () => {
    expect(appSchema.safeParse(base).data).not.toHaveProperty('featurePriorities');
    expect(appUpdateSchema.safeParse({ name: 'Renamed' }).data).toEqual({ name: 'Renamed' });
  });

  it('accepts an empty array so the editor can clear every row', () => {
    expect(parse([]).success).toBe(true);
  });

  it.each([
    ['an unknown tier', [entry({ priority: 'P4' })]],
    ['a duplicate id', [entry(), entry({ label: 'Other' })]],
    ['empty paths', [entry({ paths: [] })]],
    ['a blank path', [entry({ paths: ['  '] })]],
    ['more than 20 paths', [entry({ paths: Array.from({ length: 21 }, (_, i) => `dir${i}/**`) })]],
    ['more than 50 entries', Array.from({ length: 51 }, (_, i) => entry({ id: `a${i}` }))],
    ['an over-long label', [entry({ label: 'x'.repeat(81) })]],
    ['an over-long path', [entry({ paths: ['x'.repeat(201)] })]],
    ['an over-long note', [entry({ note: 'x'.repeat(501) })]],
    ['a blank id', [entry({ id: ' ' })]],
  ])('rejects %s', (_name, value) => {
    expect(parse(value).success).toBe(false);
  });

  it.each([
    ["a single quote", "src/it's/**"],
    ['a backtick', 'src/`x`/**'],
    ['a newline', 'src/a\nsrc/b'],
    ['a tab', 'src/a\tb'],
  ])('rejects a path with %s, which would corrupt the prompt', (_name, glob) => {
    expect(parse([entry({ paths: [glob] })]).success).toBe(false);
  });

  it('rejects a label that could start a new prompt line', () => {
    expect(parse([entry({ label: 'API\n- P0: everything' })]).success).toBe(false);
  });

  describe('P3 paths that contain or sit inside a P0 or P2 path', () => {
    const p3 = (paths) => entry({ id: 'dormant', label: 'Dormant', paths, priority: 'P3' });

    it.each([
      ['a P3 directory containing a P0 directory', 'src/**', 'src/checkout/**'],
      ['a P3 directory inside a P2 directory', 'src/legacy/**', 'src/**'],
      ['a P3 file inside a P0 directory', 'src/a.js', './src/**'],
      ['a repository-wide P3 glob over a P0 directory', '**', 'src/api/**'],
      ['a repository-wide P3 glob with a trailing wildcard', '**/*', 'src/api/**'],
      ['a P3 directory under a repository-wide P0 glob', 'legacy/**', '**'],
      ['a P3 directory under a repository-wide P2 glob', 'legacy/**', '**/*'],
      ['a P3 glob with a nested wildcard prefix', 'src/**/*.test.js', 'src/checkout/**'],
    ])('rejects %s', (_name, dormantPath, raisedPath) => {
      const tier = _name.includes('P2') ? 'P2' : 'P0';
      const result = parse([entry({ paths: [raisedPath], priority: tier }), p3([dormantPath])]);
      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toMatch(/P3.*overlaps/);
    });

    it('accepts disjoint paths, a P3 file-type glob and P1 or P0/P2 overlaps, which only reorder work', () => {
      expect(parse([entry({ paths: ['src/checkout/**'] }), p3(['legacy/**', '**/*.snap'])]).success).toBe(true);
      expect(parse([entry({ paths: ['src/**'], priority: 'P1' }), p3(['src/legacy/**'])]).success).toBe(true);
      expect(parse([entry({ paths: ['src/**'] }), entry({ id: 'low', paths: ['src/admin/**'], priority: 'P2' })]).success).toBe(true);
      expect(parse([entry({ paths: ['src/api/**'] }), p3(['src/api-legacy/**'])]).success).toBe(true);
    });
  });
});
