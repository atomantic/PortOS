import { describe, it, expect } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MANIFEST_RELATIVE_PATH,
  REGENERATE_COMMAND,
  REPO_ROOT,
  buildStageCallSites,
  generateStageCallSites,
  readShippedStageKeys,
  readStageCallSitesManifest,
  serializeManifest,
} from './generate-prompt-stage-call-sites.js';

// Fixture sources exercise the scanner's contract without depending on the
// real tree, so a legitimate refactor of `server/` can't turn these into
// false failures.
const src = (path, source) => ({ path, source });

describe('prompt stage call-site scanner', () => {
  const shippedStageKeys = ['demo-alpha', 'demo-beta', 'demo-panel-one', 'demo-panel-two', 'demo-unused'];

  it('catches each direct call shape', () => {
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [
        src('server/services/a.js', "await getStage('demo-alpha');"),
        src('server/services/b.js', 'await buildPrompt("demo-beta", {});'),
        src('server/services/c.js', "await runStage('demo-alpha', {});"),
        src('server/services/d.js', "await runStagedLLM('demo-beta', {});"),
        src('server/services/e.js', "await runStageScopedInlineLLM('demo-alpha', body);"),
      ],
    });

    expect(index['demo-alpha']).toEqual(['server/services/a.js', 'server/services/c.js', 'server/services/e.js']);
    expect(index['demo-beta']).toEqual(['server/services/b.js', 'server/services/d.js']);
  });

  it('ignores a stage key that only appears in a comment', () => {
    // A JSDoc block naming `cd-plan` is prose, not a call site — listing that
    // file under "Referenced in" in the delete dialog would be a lie.
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [
        src('server/lib/note.js', "/**\n * The planner ('demo-alpha') writes this.\n */\nexport const x = 1;"),
        src('server/lib/line.js', "// falls back to 'demo-alpha' when unset\nexport const y = 2;"),
        src('server/lib/real.js', "getStage('demo-alpha');"),
      ],
    });

    expect(index['demo-alpha']).toEqual(['server/lib/real.js']);
  });

  it('does not mistake a URL inside a literal for the start of a comment', () => {
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [src('server/services/a.js', "const url = 'https://example.com/x';\ngetStage('demo-alpha');")],
    });

    expect(index['demo-alpha']).toEqual(['server/services/a.js']);
  });

  it('catches keys reached indirectly through a lookup table or module constant', () => {
    // The shapes a call-shape-only regex would miss: textStages.js's
    // `{ idea: 'pipeline-idea-expansion' }` map and liveDirector.js's
    // `const STAGE = 'writers-room-continue'`.
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [
        src('server/services/map.js', "const STAGES = { first: 'demo-alpha' };\nrunStage(STAGES[kind]);"),
        src('server/services/const.js', "const STAGE = 'demo-beta';\nawait buildPrompt(STAGE, {});"),
      ],
    });

    expect(index['demo-alpha']).toEqual(['server/services/map.js']);
    expect(index['demo-beta']).toEqual(['server/services/const.js']);
  });

  it('catches stages reached only through an interpolated prefix', () => {
    // `pipeline-panel-${personaId}` in readerPanel.js — no literal key exists
    // anywhere, so a literal-only scan would leave these deletable.
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [src('server/services/panel.js', 'const stage = (id) => `demo-panel-${id}`;')],
    });

    expect(index['demo-panel-one']).toEqual(['server/services/panel.js']);
    expect(index['demo-panel-two']).toEqual(['server/services/panel.js']);
    // The prefix itself is not a key, and unrelated stages stay untouched.
    expect(index['demo-panel-']).toBeUndefined();
    expect(index['demo-alpha']).toBeUndefined();
  });

  it('finds an interpolated prefix that is not at the start of the template', () => {
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [src('server/services/panel.js', 'const stage = `${scope}:demo-panel-${id}`;')],
    });

    expect(index['demo-panel-one']).toEqual(['server/services/panel.js']);
  });

  it('ignores an interpolated prefix inside a comment', () => {
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [src('server/services/panel.js', '// resolves `demo-panel-${id}` at runtime\nexport const x = 1;')],
    });

    expect(index['demo-panel-one']).toBeUndefined();
  });

  it('does not match a longer key that merely starts with a shorter one', () => {
    const index = buildStageCallSites({
      shippedStageKeys: ['demo-alpha', 'demo-alpha-extended'],
      sources: [src('server/services/a.js', "getStage('demo-alpha-extended');")],
    });

    expect(index['demo-alpha']).toBeUndefined();
    expect(index['demo-alpha-extended']).toEqual(['server/services/a.js']);
  });

  it('records a call site for a key the shipped stage config never listed', () => {
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [src('server/services/a.js', "getStage('demo-unshipped');")],
    });

    expect(index['demo-unshipped']).toEqual(['server/services/a.js']);
  });

  it('omits keys nothing references and dedupes repeated references', () => {
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [src('server/services/a.js', "getStage('demo-alpha');\nbuildPrompt('demo-alpha', {});")],
    });

    expect(index['demo-unused']).toBeUndefined();
    expect(index['demo-alpha']).toEqual(['server/services/a.js']);
  });

  it('sorts keys and paths so the manifest is byte-stable', () => {
    const index = buildStageCallSites({
      shippedStageKeys,
      sources: [
        src('server/services/z.js', "getStage('demo-beta');\ngetStage('demo-alpha');"),
        src('server/services/a.js', "getStage('demo-beta');"),
      ],
    });

    expect(Object.keys(index)).toEqual(['demo-alpha', 'demo-beta']);
    expect(index['demo-beta']).toEqual(['server/services/a.js', 'server/services/z.js']);
  });
});

// The guard the whole generated-manifest posture exists for: adding a
// literal-key call site (or renaming a file that has one) without rerunning
// the generator leaves stages unprotected, and this fails until it's rerun.
describe('prompt stage call-site manifest', () => {
  it('matches a fresh scan of the tracked server sources', () => {
    const stale = `${MANIFEST_RELATIVE_PATH} is stale — run \`${REGENERATE_COMMAND}\` and commit the result.`;
    const fresh = generateStageCallSites();

    // Structural first, so a genuine drift reports as a readable key diff…
    expect(fresh, stale).toEqual(readStageCallSitesManifest());
    // …then byte-exact, so a hand-edit that reformats the file is caught too.
    expect(readFileSync(join(REPO_ROOT, MANIFEST_RELATIVE_PATH), 'utf8'), stale)
      .toBe(serializeManifest(fresh));
  });

  it('covers the shipped stages that features resolve by name', () => {
    const manifest = readStageCallSitesManifest();
    // A sample from the four call paths #3335 named — a scanner regression
    // that silently stopped matching one of them would still pass the drift
    // test above (both sides regenerate), so pin the expectation here.
    for (const key of [
      'pipeline-series-concept-judge',
      'pipeline-canon-describe-from-prose',
      'catalog-ideas-scenes-concepts',
      'soul-contradiction-detector',
      'pipeline-panel-editor',
    ]) {
      expect(manifest[key], `${key} lost its call-site entry`).toBeTruthy();
      expect(manifest[key].length).toBeGreaterThan(0);
    }

    // Most of the shipped catalog is reachable by name; a large drop means the
    // scan broke rather than that the code genuinely stopped calling stages.
    const shipped = readShippedStageKeys();
    const referenced = shipped.filter((key) => manifest[key]);
    expect(referenced.length).toBeGreaterThan(shipped.length * 0.75);
  });

  it('lists only tracked, repo-relative server paths', () => {
    for (const [key, paths] of Object.entries(readStageCallSitesManifest())) {
      for (const path of paths) {
        expect(path, `${key} -> ${path}`).toMatch(/^server\/[\w./-]+\.js$/);
        expect(path.endsWith('.test.js')).toBe(false);
      }
    }
  });
});
