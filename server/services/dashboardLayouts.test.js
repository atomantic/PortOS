import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The service captures STATE_PATH at module-load time, so the scratch dir
// must exist before the import resolves. vi.hoisted runs before any imports
// (including the mocked module), so we mint the dir there and just clear
// its contents between tests.
const scratch = vi.hoisted(() => {
  const { mkdtempSync: mk, mkdirSync: mkd } = require('fs');
  const { tmpdir: tmp } = require('os');
  const { join: j } = require('path');
  const dir = mk(j(tmp(), 'dashboard-svc-'));
  mkd(j(dir, 'data'), { recursive: true });
  return { dir };
});
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: join(scratch.dir, 'data') },
  };
});

import * as svc from './dashboardLayouts.js';

const STATE_FILE = join(scratch.dir, 'data', 'dashboard-layouts.json');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));

describe('dashboardLayouts service', () => {
  beforeEach(() => {
    // Each test starts with a clean state file. The dir itself is reused.
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  });

  afterEach(() => {});

  describe('saveLayout — activateWindow merge behavior', () => {
    const stateFile = () => STATE_FILE;

    it('preserves activateWindow when the caller omits the key', async () => {
      writeJson(stateFile(), {
        activeLayoutId: 'morning',
        layouts: [
          { id: 'morning', name: 'Morning', builtIn: false, widgets: ['cos'], grid: [], activateWindow: { start: '06:00', end: '11:00' } },
        ],
      });
      // Vanilla edit: rename only. The caller doesn't know about activateWindow.
      await svc.saveLayout({ id: 'morning', name: 'Morning v2', widgets: ['cos'], grid: [] });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'morning');
      expect(found.name).toBe('Morning v2');
      expect(found.activateWindow).toEqual({ start: '06:00', end: '11:00' });
    });

    it('clears activateWindow when the caller sends null', async () => {
      writeJson(stateFile(), {
        activeLayoutId: 'morning',
        layouts: [
          { id: 'morning', name: 'Morning', builtIn: false, widgets: ['cos'], grid: [], activateWindow: { start: '06:00', end: '11:00' } },
        ],
      });
      await svc.saveLayout({ id: 'morning', name: 'Morning', widgets: ['cos'], grid: [], activateWindow: null });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'morning');
      expect(found.activateWindow).toBe(null);
    });

    it('sets activateWindow when the caller provides one', async () => {
      writeJson(stateFile(), {
        activeLayoutId: 'morning',
        layouts: [
          { id: 'morning', name: 'Morning', builtIn: false, widgets: ['cos'], grid: [] },
        ],
      });
      await svc.saveLayout({
        id: 'morning',
        name: 'Morning',
        widgets: ['cos'],
        grid: [],
        activateWindow: { start: '07:00', end: '10:00' },
      });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'morning');
      expect(found.activateWindow).toEqual({ start: '07:00', end: '10:00' });
    });

    it('drops malformed activateWindow on read', async () => {
      // Hand-edit produces garbage shapes — sanitizer must null them out.
      writeJson(stateFile(), {
        activeLayoutId: 'busted',
        layouts: [
          { id: 'busted', name: 'Busted', builtIn: false, widgets: ['cos'], grid: [], activateWindow: { start: '25:99', end: '11:00' } },
        ],
      });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'busted');
      expect(found.activateWindow).toBe(null);
    });
  });

  describe('saveLayout — surfaces builtIn correctly for new ids', () => {
    it('persists builtIn=true for a built-in id (deep-work) when seeded through saveLayout', async () => {
      // A fresh state file is fine — getState() will seed defaults, then we save.
      await svc.saveLayout({ id: 'deep-work', name: 'Deep Work renamed', widgets: ['cos'], grid: [] });
      const after = await svc.getState();
      const found = after.layouts.find((l) => l.id === 'deep-work');
      expect(found?.builtIn).toBe(true);
    });
  });

  describe('write-tail serialization', () => {
    const stateFile = () => STATE_FILE;

    it('serializes concurrent setActiveLayout + saveLayout — both writes survive, no lost-update', async () => {
      writeJson(stateFile(), {
        activeLayoutId: 'default',
        layouts: [
          { id: 'default', name: 'Everything', builtIn: true, widgets: ['cos'], grid: [] },
          { id: 'morning', name: 'Morning', builtIn: false, widgets: ['cos'], grid: [] },
        ],
      });
      // Fire concurrently. Without serialization the second call's getState
      // would read the file before the first call's atomicWrite, and the
      // second call's atomicWrite would clobber the first.
      const [resA, resB] = await Promise.all([
        svc.setActiveLayout('morning'),
        svc.saveLayout({ id: 'morning', name: 'Morning v2', widgets: ['cos', 'goal-progress'], grid: [] }),
      ]);
      // Last-queued result wins at the server.
      const final = await svc.getState();
      const m = final.layouts.find((l) => l.id === 'morning');
      expect(m.name).toBe('Morning v2');
      expect(m.widgets).toEqual(['cos', 'goal-progress']);
      // Both writes' return shapes must be coherent (each saw committed state
      // from its predecessor — second call's response reflects active='morning'
      // because setActiveLayout committed first).
      expect(resA.activeLayoutId).toBe('morning');
      expect(resB.activeLayoutId).toBe('morning');
    });

    it('a failed write doesn\'t break the chain — subsequent writes still complete', async () => {
      writeJson(stateFile(), {
        activeLayoutId: 'default',
        layouts: [{ id: 'default', name: 'Everything', builtIn: true, widgets: ['cos'], grid: [] }],
      });
      const [bad, good] = await Promise.allSettled([
        svc.setActiveLayout('nonexistent'),
        svc.saveLayout({ id: 'default', name: 'Everything v2', widgets: ['cos'], grid: [] }),
      ]);
      expect(bad.status).toBe('rejected');
      expect(bad.reason?.code).toBe('NOT_FOUND');
      expect(good.status).toBe('fulfilled');
      const after = await svc.getState();
      expect(after.layouts.find((l) => l.id === 'default').name).toBe('Everything v2');
    });
  });

  describe('built-in layouts ship with the three new intent variants', () => {
    it('seeds deep-work, health, agent-watch on first read', async () => {
      const state = await svc.getState();
      const ids = state.layouts.map((l) => l.id);
      expect(ids).toContain('deep-work');
      expect(ids).toContain('health');
      expect(ids).toContain('agent-watch');
      // The new built-ins should be flagged so the editor refuses to delete them.
      expect(state.layouts.find((l) => l.id === 'deep-work').builtIn).toBe(true);
    });

    it('does not write the state file on first read (defaults are in-memory)', async () => {
      // getState() doesn't write — only saveLayout / setActive / delete do.
      // Verify by reading getState() and confirming no file got written.
      await svc.getState();
      expect(existsSync(STATE_FILE)).toBe(false);
    });
  });

  describe('built-in layout grids have no overlapping cells', () => {
    // Regression: a hand-tuned grid edit can place two widgets in the same
    // rows/cols, so fresh installs render stacked cards. Every built-in
    // layout's grid rectangles must be pairwise non-overlapping.
    const rectsOverlap = (a, b) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

    it('no two grid items overlap in any seeded built-in layout', async () => {
      const state = await svc.getState();
      const collisions = [];
      for (const layout of state.layouts) {
        const grid = layout.grid || [];
        for (let i = 0; i < grid.length; i += 1) {
          for (let j = i + 1; j < grid.length; j += 1) {
            if (rectsOverlap(grid[i], grid[j])) {
              collisions.push(`${layout.id}: ${grid[i].id} ∩ ${grid[j].id}`);
            }
          }
        }
      }
      expect(collisions).toEqual([]);
    });
  });
});
