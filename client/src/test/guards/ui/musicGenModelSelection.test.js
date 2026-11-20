/**
 * Guard: MusicGenPanel's model selection must never disagree with itself.
 *
 * Two shapes, one bug class, both of which shipped red on PR #4819's CI and
 * neither of which a rendering test in this harness can reproduce — `act()`
 * drains React's passive effects between discrete events, which is exactly the
 * drain a loaded CI runner does NOT do at that moment.
 *
 * ## 1. The engine-defaults effect must reset through a functional updater
 *
 * The broken shape reads `modelId` out of the closure:
 *
 *   useEffect(() => {
 *     const ids = (engine.models || []).map((m) => m.id);
 *     if (!ids.includes(modelId)) setModelId(engine.defaultModelId || ids[0] || '');
 *   }, [engine?.id, engine?.models]);          // ← modelId is NOT a dep
 *
 * The effect is keyed on the ENGINE, so the `modelId` it reads is whatever the
 * render that queued it captured. React drains passive effects on its own
 * scheduler task, separate from the DOM mutation a `findBy*` query resolves on,
 * so a user pick landing in that window is invisible to the queued effect: it
 * reads the pick as absent and resets to the engine default. The selection
 * silently reverts, and every gate hanging off it — the "selected model weights
 * are not installed yet" warning, the sized download button, the disabled
 * Generate — goes quiet as if the un-installed snapshot had never been picked.
 *
 * Reading the value at flush time (`setModelId((current) => …)`) cannot go
 * stale. Adding `modelId` to the dep array does NOT fix it: the already-queued
 * effect still runs with its own closure before the re-keyed one does.
 *
 * ## 2. The Model <select> must be bound to the EFFECTIVE model id
 *
 * `modelId` is `''` until that effect drains, and React leaves a `<select>`
 * alone when no option matches its value — so the control keeps displaying its
 * first option while the state says "nothing selected". Bind the raw state and
 * the control shows one snapshot while every readiness gate below it reads
 * another (`selectedModelId`, which falls back through `defaultModelId`), for as
 * long as that gap lasts. That divergence is what made the CI failure look
 * impossible: the assertion that the select "has value 8-bit" passed while the
 * component held no selection at all.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const source = readText(join(REPO_ROOT, 'client/src/components/music/MusicGenPanel.jsx'));

describe('MusicGenPanel model selection', () => {
  it('resets the model through a functional updater, never a closure read', () => {
    // Scoped to the engine-defaults effect. Other call sites legitimately
    // name the default (removing the model that is currently selected); only
    // THIS one runs from a queued closure that can be older than a user pick.
    const start = source.indexOf('if (!engine) return;');
    const effect = source.slice(start, source.indexOf('}, [engine?.id, engine?.models]);', start));
    expect(effect).not.toMatch(/if \(!ids\.includes\(modelId\)\)/);
    expect(effect).toMatch(/setModelId\(\(current\) => \(ids\.includes\(current\)/);
  });

  it('binds the Model select to the effective id, not the raw state', () => {
    const modelSelect = source.slice(source.indexOf('>Model</span>'));
    expect(modelSelect).toMatch(/<select\s+value=\{selectedModelId\}/);
    expect(modelSelect.slice(0, modelSelect.indexOf('</select>'))).not.toMatch(/value=\{modelId\}/);
  });
});
