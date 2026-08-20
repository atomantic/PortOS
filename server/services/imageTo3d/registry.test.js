import { describe, expect, it } from 'vitest';
import { IMAGE_TO_3D_TARGETS, IMAGE_TO_3D_TARGET_IDS, EXECUTION_LANES, OUTPUT_KINDS } from './targets.js';
import { TARGET_ADAPTERS } from './adapters.js';

// Registry-wide invariants, asserted by LOOPING over the registry rather than by a
// hand-written block per target. The per-target blocks in targets.test.js only cover
// the targets someone remembered to write them for, so a newly registered target
// inherits no checks at all — which is how a descriptor can reach production missing a
// field that only fails at generate time (a 501 from models.js), never in CI.
describe('image-to-3D registry invariants', () => {
  it('registers an adapter for exactly the declared targets', () => {
    // A descriptor with no adapter resolves, renders a card, accepts a generate
    // request, and only then 501s in models.js — so this pairing must fail in CI.
    expect(Object.keys(TARGET_ADAPTERS).sort()).toEqual([...IMAGE_TO_3D_TARGET_IDS].sort());
  });

  for (const id of IMAGE_TO_3D_TARGET_IDS) {
    describe(id, () => {
      const target = IMAGE_TO_3D_TARGETS[id];
      const adapter = TARGET_ADAPTERS[id];

      it('carries the descriptor fields every consumer reads', () => {
        expect(target.id).toBe(id);
        expect(target.label).toBeTruthy();
        expect(target.description).toBeTruthy();
        expect(EXECUTION_LANES).toContain(target.executionLane);
        expect(OUTPUT_KINDS).toContain(target.outputKind);
        expect(Object.isFrozen(target)).toBe(true);
      });

      it('satisfies the adapter contract', () => {
        expect(typeof adapter.isInstalled).toBe('function');
        expect(typeof adapter.run).toBe('function');
        for (const optional of ['install', 'resolveEnv', 'describeInstallState']) {
          if (adapter[optional] !== undefined) expect(typeof adapter[optional]).toBe('function');
        }
      });

      it('supplies install copy when it has an install step', () => {
        // The install modal is shared by every target and has no per-target copy of its
        // own, so a target with an installer MUST bring its own prose or the modal
        // silently falls back to a generic description.
        if (adapter.install) expect(typeof target.installNotes).toBe('string');
      });

      it('declares only boolean render-option support, when it declares any', () => {
        if (target.supportsRenderOptions === undefined) return;
        for (const [knob, supported] of Object.entries(target.supportsRenderOptions)) {
          expect(['steps', 'seed', 'keyBackground']).toContain(knob);
          expect(typeof supported).toBe('boolean');
        }
      });

      it('states a hardware floor matching its execution lane', () => {
        const req = target.requires || {};
        if (target.executionLane === 'local-mps') expect(req.appleSilicon).toBe(true);
        if (target.executionLane === 'local-cuda') {
          expect(req.cuda).toBe(true);
          expect(req.minVramGb).toBeGreaterThan(0);
        }
      });
    });
  }
});
