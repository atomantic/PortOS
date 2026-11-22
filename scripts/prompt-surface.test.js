import { describe, expect, it } from 'vitest';
import { diffSnapshots, layoutSnapshot } from './prompt-surface.js';

const tool = (name, description, props = {}) => ({ name, description, schema: { type: 'object', properties: props } });
const render = (surfaces) => layoutSnapshot(surfaces);

describe('prompt-surface diff', () => {
  const base = render({ a: { prompt: 'abcd', tools: [tool('x.y', 'old', { p: {} })] } });

  it('reports nothing for identical snapshots', () => {
    expect(diffSnapshots(base, render({ a: { prompt: 'abcd', tools: [tool('x.y', 'old', { p: {} })] } }))).toBe('No prompt-surface changes.\n');
  });

  it('summarises token deltas and per-tool parameter changes', () => {
    const head = render({ a: { prompt: 'abcdefgh', tools: [tool('x.y', 'a longer description', { q: {} })] } });
    const out = diffSnapshots(base, head);
    expect(out).toContain('| a | 2 (+1) |');
    expect(out).toContain('param `q` added');
    expect(out).toContain('param `p` removed');
  });

  it('reports a same-length schema edit instead of a blank change', () => {
    const [a, b] = [render({ a: { prompt: '', tools: [tool('t', 'd', { p: { type: 'string' } })] } }), render({ a: { prompt: '', tools: [tool('t', 'd', { p: { type: 'number' } })] } })];
    expect(diffSnapshots(a, b)).toContain('changed: schema 0 tok');
  });

  it('gives lossy-looking tool names distinct files', () => {
    const files = Object.keys(render({ a: { prompt: '', tools: [tool('foo/bar', 'd'), tool('foo_bar', 'd')] } })).filter((f) => f.startsWith('tools/'));
    expect(new Set(files).size).toBe(2);
  });

  it('keeps one tool file when surfaces share a schema and splits when they differ', () => {
    const shared = render({ a: { prompt: '', tools: [tool('t', 'd')] }, b: { prompt: '', tools: [tool('t', 'd')] } });
    expect(Object.keys(shared).filter((f) => f.startsWith('tools/'))).toEqual(['tools/t.json']);
    const split = render({ a: { prompt: '', tools: [tool('t', 'd')] }, b: { prompt: '', tools: [tool('t', 'e')] } });
    expect(Object.keys(split).filter((f) => f.startsWith('tools/'))).toEqual(['tools/t@a.json', 'tools/t@b.json']);
  });
});
