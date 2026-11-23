// Ratchet: client/src/hooks/ is reserved for hooks imported by two or more modules
// (.claude/skills/portos-add-module/SKILL.md). A single-importer hook belongs beside its owner.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '../../..');
const HOOKS = path.join(SRC, 'hooks');

/**
 * Grandfathered single-importer hooks whose owner is a page (or another
 * hook), not a component directory. The list may only shrink: move the hook
 * beside its owner (or add a second importer) and delete its entry.
 */
const GRANDFATHERED = new Set([
  'useAutoscroll.js',
  'useConfigDraftRevision.js',
  'useDeckRenderTarget.js',
  'useImporterProgress.js',
  'useOpenClawAttachments.js',
  'useOpenClawStream.js',
  'useReactorContinuableClips.js',
  'useRoundDraft.js',
  'useRoundPartners.js',
  'useRoundRows.js',
  'useRoundViewParams.js',
  'useSceneBatch.js',
  'useSceneRenderLifecycle.js',
  'useSpritePendingRenders.js',
  'useVideoGenByovRuntime.js',
  'useVideoGenEpisodeImport.js',
  'useVideoGenHistory.js',
  'useVideoGenRemixHandoff.js',
  'useVideoGenRun.js',
  'useVideoGenServiceStatus.js',
  'useVideoGenSubmitGates.js',
  'useVideoGenWeightAssets.js',
]);

const IMPORT_SPEC = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)(['"])(\.[^'"]*)\1/g;

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
};

const resolveImport = (from, spec) => {
  const t = path.resolve(path.dirname(from), spec);
  return [t, `${t}.js`, `${t}.jsx`, path.join(t, 'index.js')].find(c => fs.existsSync(c) && fs.statSync(c).isFile());
};

const importerCounts = () => {
  const hooks = fs.readdirSync(HOOKS).filter(f => /^use.*\.jsx?$/.test(f) && !/\.test\./.test(f));
  const counts = new Map(hooks.map(h => [h, new Set()]));
  for (const file of walk(SRC)) {
    if (/\.test\.jsx?$/.test(file) || file.startsWith(path.join(SRC, 'test') + path.sep)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_SPEC)) {
      const target = resolveImport(file, m[2]);
      if (target && path.dirname(target) === HOOKS && target !== file) counts.get(path.basename(target))?.add(file);
    }
  }
  return counts;
};

describe('client/src/hooks single-importer ratchet', () => {
  const counts = importerCounts();

  it('adds no new single-importer hook to client/src/hooks/', () => {
    const offenders = [...counts].filter(([h, s]) => s.size < 2 && !GRANDFATHERED.has(h)).map(([h]) => h);
    expect(offenders, 'move beside the sole importer (components/<feature>/useX.js)').toEqual([]);
  });

  it('drops allowlist entries once a hook is moved or gains a second importer', () => {
    const stale = [...GRANDFATHERED].filter(h => !counts.has(h) || counts.get(h).size >= 2);
    expect(stale, 'remove from GRANDFATHERED').toEqual([]);
  });
});
