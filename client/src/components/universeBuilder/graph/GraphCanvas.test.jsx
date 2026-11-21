import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GraphCanvas from './GraphCanvas';

const nodes = Array.from({ length: 12 }, (_, i) => ({
  id: `character:c${i}`, kind: 'character', name: `Person ${i}`, role: 'Role', hasImage: false, firstIssue: 0,
}));
const index = {
  nodes, edges: [], adjacency: new Map(), byId: new Map(nodes.map((n) => [n.id, n])),
  series: [], issues: [], totalIssues: 0,
};
const visible = { nodes, edges: [], degree: new Map(), match: null };

let translates;
const ctxStub = new Proxy({}, {
  get: (target, prop) => {
    if (prop === 'measureText') return () => ({ width: 10 });
    if (prop === 'translate') return (x, y) => translates.push([x, y]);
    if (prop === 'createRadialGradient') return () => ({ addColorStop() {} });
    return typeof target[prop] === 'undefined' ? () => {} : target[prop];
  },
  set: (target, prop, value) => { target[prop] = value; return true; },
});

beforeEach(() => {
  translates = [];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctxStub);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => vi.restoreAllMocks());

const setup = () => {
  const onSelect = vi.fn();
  const onFocus = vi.fn();
  render(
    <GraphCanvas
      index={index} visible={visible} layout="force" kinds={new Set(['character'])}
      selectedId={null} hoveredId={null} focusId={null} timeIndex={null}
      loading={false} statsLabel="12 nodes" resetToken={0}
      onSelect={onSelect} onHover={vi.fn()} onFocus={onFocus}
    />,
  );
  return { canvas: screen.getByRole('application'), onSelect, onFocus };
};

describe('GraphCanvas keyboard navigation', () => {
  it('is focusable with an accessible name', () => {
    const { canvas } = setup();
    expect(canvas.getAttribute('tabindex')).toBe('0');
    expect(canvas.getAttribute('aria-label')).toMatch(/arrow keys to pan/);
  });

  it('cycles through every visible node, announces it, then selects and focuses it', () => {
    const { canvas, onSelect, onFocus } = setup();
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(canvas, { key: ']' });
    // Index 9 is past any "top 8" shortlist.
    expect(screen.getByRole('status').textContent).toContain('Person 9');
    fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('character:c9');
    fireEvent.keyDown(canvas, { key: 'f' });
    expect(onFocus).toHaveBeenCalledWith('character:c9');
    fireEvent.keyDown(canvas, { key: '[' });
    expect(screen.getByRole('status').textContent).toContain('Person 8');
  });

  it('does nothing on Enter with no active node and clears on Escape', () => {
    const { canvas, onSelect, onFocus } = setup();
    fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(canvas, { key: ']' });
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(onFocus).toHaveBeenCalledWith(null);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('pans the view with the arrow keys', async () => {
    const { canvas } = setup();
    await new Promise((r) => requestAnimationFrame(() => r()));
    const lastX = () => translates[translates.length - 1][0];
    const before = lastX();
    translates.length = 0;
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    await new Promise((r) => requestAnimationFrame(() => r()));
    expect(lastX()).toBe(before - 60);
  });
});
