import { describe, expect, it } from 'vitest';

import { buildCiTestPlan } from './ci-test-plan.js';

const TRACKED = [
  'server/lib/index.test.js',
  'server/routes/auth.test.js',
  'server/routes/sprites.test.js',
  'server/services/auth.test.js',
  'server/services/catalogDB/facets.db.test.js',
  'server/services/sprites/animationTracks.test.js',
  'server/services/sprites/atlas.test.js',
  'server/services/sprites/atlasGrid.test.js',
  'server/services/sprites/atlasLayout.test.js',
  'server/services/taskPromptDefaults.test.js',
  'client/src/a11yConventions.test.js',
  'client/src/hooks/mountedRefConventions.test.js',
  'client/src/components/catalog/CatalogCard.jsx',
  'client/src/components/catalog/CatalogCard.test.jsx',
  'client/src/components/sprites/WalkWorkflow.test.jsx',
  'client/src/lib/catalogLinks.js',
  'client/src/lib/index.test.js',
  'client/src/services/apiSprites.test.js',
  'scripts/migrations/210-example.test.js',
];

describe('CI test impact planner', () => {
  it('skips all expensive jobs for documentation-only changes, keeping the always-run guards', () => {
    const plan = buildCiTestPlan([
      '.changelog/NEXT.md',
      'docs/GITHUB_ACTIONS.md',
    ], { trackedFiles: TRACKED });

    expect(plan).toMatchObject({
      full: false,
      reason: 'documentation-only change',
      server: { mode: 'files', files: ['server/services/taskPromptDefaults.test.js'] },
      client: { mode: 'skip' },
      db: false,
      lint: { mode: 'skip' },
      build: false,
      smoke: false,
    });
  });

  // The prompt-integrity snapshot guards a cross-install upgrade contract that
  // no other test covers, so no impact scope may drop it — including the scopes
  // that otherwise skip the server runner entirely.
  it('runs the prompt-integrity guard under every impact scope', () => {
    const scopes = [
      [],                                                   // no changed files
      ['docs/GITHUB_ACTIONS.md'],                           // documentation-only
      ['client/src/components/catalog/CatalogCard.jsx'],    // client-only (server would skip)
      ['server/services/auth.js'],                          // server related-mode
      ['server/services/sprites/atlas.js'],                 // server files-mode
    ];

    for (const changed of scopes) {
      const plan = buildCiTestPlan(changed, { trackedFiles: TRACKED });
      expect(plan.server.mode, JSON.stringify(changed)).not.toBe('skip');
      expect(plan.server.files, JSON.stringify(changed))
        .toContain('server/services/taskPromptDefaults.test.js');
    }

    // A full plan runs everything, so it carries no explicit selector list.
    const full = buildCiTestPlan(['.github/workflows/ci.yml'], { trackedFiles: TRACKED });
    expect(full.server.mode).toBe('full');
  });

  it('omits an untracked always-run guard rather than handing Vitest a missing selector', () => {
    const plan = buildCiTestPlan(['docs/GITHUB_ACTIONS.md'], {
      trackedFiles: TRACKED.filter((path) => path !== 'server/services/taskPromptDefaults.test.js'),
    });

    expect(plan.server).toEqual({ mode: 'skip', files: [] });
  });

  it('forces the full suite when CI or shared test configuration changes', () => {
    for (const path of [
      '.github/workflows/ci.yml',
      'server/vitest.config.js',
      'client/src/test/setup.js',
      'server/lib/validation.js',
    ]) {
      const plan = buildCiTestPlan([path], { trackedFiles: TRACKED });
      expect(plan.full, path).toBe(true);
      expect(plan.server.mode, path).toBe('full');
      expect(plan.client.mode, path).toBe('full');
      expect(plan.db, path).toBe(true);
    }
  });

  it('selects the touched feature across server and client without pulling unrelated tests', () => {
    const plan = buildCiTestPlan([
      '.changelog/NEXT.md',
      'server/services/sprites/animationTracks.js',
      'server/services/sprites/animationTracks.test.js',
      'server/services/sprites/atlas.js',
      'server/services/sprites/atlas.test.js',
      'server/services/sprites/atlasGrid.js',
      'server/services/sprites/atlasGrid.test.js',
      'server/services/sprites/atlasLayout.js',
      'server/services/sprites/atlasLayout.test.js',
    ], { trackedFiles: TRACKED });

    expect(plan).toMatchObject({
      full: false,
      reason: 'targeted features: sprites',
      server: { mode: 'files' },
      client: { mode: 'files' },
      db: false,
      lint: { mode: 'skip' },
      build: false,
      smoke: true,
    });
    expect(plan.server.files).toEqual([
      'server/routes/sprites.test.js',
      'server/services/sprites/animationTracks.test.js',
      'server/services/sprites/atlas.test.js',
      'server/services/sprites/atlasGrid.test.js',
      'server/services/sprites/atlasLayout.test.js',
      'server/services/taskPromptDefaults.test.js',
    ]);
    expect(plan.client.files).toEqual([
      'client/src/components/sprites/WalkWorkflow.test.jsx',
      'client/src/services/apiSprites.test.js',
    ]);
    expect(plan.server.files).not.toContain('server/services/auth.test.js');
  });

  it('uses Vitest related mode for flat modules whose impact is defined by imports', () => {
    const plan = buildCiTestPlan(['server/services/auth.js'], {
      trackedFiles: TRACKED,
    });

    expect(plan.full).toBe(false);
    expect(plan.server).toEqual({
      mode: 'related',
      files: ['server/services/auth.test.js', 'server/services/taskPromptDefaults.test.js'],
    });
    expect(plan.client.mode).toBe('skip');
    expect(plan.smoke).toBe(true);
  });

  it('adds structural guard tests and changed-file linting for client modules', () => {
    const plan = buildCiTestPlan([
      'client/src/components/catalog/CatalogCard.jsx',
      'client/src/lib/catalogLinks.js',
    ], { trackedFiles: TRACKED });

    expect(plan.full).toBe(false);
    expect(plan.client.mode).toBe('related');
    expect(plan.client.files).toContain('client/src/lib/index.test.js');
    expect(plan.client.files).toContain('client/src/a11yConventions.test.js');
    expect(plan.client.files).toContain('client/src/hooks/mountedRefConventions.test.js');
    expect(plan.lint).toEqual({
      mode: 'files',
      files: [
        'client/src/components/catalog/CatalogCard.jsx',
        'client/src/lib/catalogLinks.js',
      ],
    });
    expect(plan.build).toBe(true);
  });

  it('selects the mounted-ref guard for a plain-.js client change', () => {
    // The a11y guard only triggers on `.jsx`, but the StrictMode mounted-ref bug
    // reached 94 call sites through a `.js` hook — so this guard must be selected
    // by a change that touches no `.jsx` at all.
    const plan = buildCiTestPlan(['client/src/hooks/useAsyncAction.js'], { trackedFiles: TRACKED });

    expect(plan.client.files).toContain('client/src/hooks/mountedRefConventions.test.js');
    expect(plan.client.files).not.toContain('client/src/a11yConventions.test.js');
  });

  it('runs the DB suite when a database-backed adapter changes', () => {
    const plan = buildCiTestPlan([
      'server/services/catalogDB/facets.js',
      'server/services/catalogDB/facets.db.test.js',
    ], { trackedFiles: TRACKED });

    expect(plan.full).toBe(false);
    expect(plan.server.mode).toBe('files');
    expect(plan.db).toBe(true);
  });

  it('runs a directly changed migration test without broadening to the full suite', () => {
    const plan = buildCiTestPlan([
      'scripts/migrations/210-example.js',
      'scripts/migrations/210-example.test.js',
    ], { trackedFiles: TRACKED });

    expect(plan.full).toBe(false);
    expect(plan.server).toEqual({
      mode: 'related',
      files: ['scripts/migrations/210-example.test.js', 'server/services/taskPromptDefaults.test.js'],
    });
  });

  it('excludes a deleted test file from the exact server selector list, and a deleted client file from lint', () => {
    // `changed` includes deleted paths (diff-filter ACMRD), but neither
    // `TRACKED` (git ls-files) nor the trackedFiles fixture below lists them
    // — a deletion-only PR must not hand a nonexistent path to Vitest/ESLint
    // as an exact selector, which exits non-zero on a perfectly valid PR.
    const plan = buildCiTestPlan([
      'server/services/sprites/atlas.test.js', // deleted alongside its source
      'client/src/components/catalog/CatalogCard.test.jsx', // deleted test
      'client/src/lib/catalogLinks.js', // deleted lint-relevant client file
    ], { trackedFiles: TRACKED.filter((path) => ![
      'server/services/sprites/atlas.test.js',
      'client/src/components/catalog/CatalogCard.test.jsx',
      'client/src/lib/catalogLinks.js',
    ].includes(path)) });

    expect(plan.full).toBe(false);
    expect(plan.server.files).not.toContain('server/services/sprites/atlas.test.js');
    expect(plan.lint.files).not.toContain('client/src/lib/catalogLinks.js');
  });

  it('falls back to full CI for unknown artifacts and wide changes', () => {
    const unknown = buildCiTestPlan(['data.reference/bootstrap.bin'], {
      trackedFiles: TRACKED,
    });
    expect(unknown.full).toBe(true);
    expect(unknown.reason).toMatch(/unclassified/);

    const unmappedExecutable = buildCiTestPlan(['ecosystem.config.cjs'], {
      trackedFiles: TRACKED,
    });
    expect(unmappedExecutable.full).toBe(true);
    expect(unmappedExecutable.reason).toMatch(/unmapped executable/);

    const wide = buildCiTestPlan(
      Array.from({ length: 31 }, (_, i) => `server/services/feature${i}.js`),
      { trackedFiles: TRACKED },
    );
    expect(wide.full).toBe(true);
    expect(wide.reason).toMatch(/wide change/);
  });

  it('honors an explicit full-CI request', () => {
    const plan = buildCiTestPlan(['docs/README.md'], {
      trackedFiles: TRACKED,
      forceFull: true,
    });

    expect(plan).toMatchObject({
      full: true,
      reason: 'full CI requested',
      server: { mode: 'full' },
      client: { mode: 'full' },
      db: true,
      lint: { mode: 'full' },
      build: true,
      smoke: true,
    });
  });
});
