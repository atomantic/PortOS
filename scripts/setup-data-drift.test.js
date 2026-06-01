/**
 * Contract test for the prompt-drift sweep that scripts/setup-data.js uses to
 * warn about pending migrations. Before this, setup-data.js hand-mirrored every
 * migration's ACCEPTED_OLD_MD5 / NEW_SHIPPED_MD5 hashes — the spot most likely
 * to drift out of sync. `buildPromptDriftTables` now sweeps those constants
 * straight from the migration files, so this test pins the swept result against
 * the known-good baseline: if a migration ships a new prompt hash without
 * exporting it (or exports a wrong one), the baseline assertion fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { buildPromptDriftTables } from './migrations/_lib.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// The current shipped baseline for every migration-managed prompt. This is the
// single source of truth the sweep must reproduce — keep it in lockstep with
// the latest NEW_SHIPPED_MD5 a migration exports for each file.
const EXPECTED_STAGE_NEW = {
  'pipeline-idea-expansion.md': '49a208628290543ba2607a5ed48fdc8c',
  'pipeline-prose.md': '84523d531eeafa60959c65c553b2563f',
  'pipeline-comic-script.md': 'dea7d497d1cb38e7574f236f4ff8e644',
  'pipeline-teleplay.md': 'afa4215330bf856429d70d7e2f856605',
  'pipeline-season-episodes.md': '50c68a29c3ebc275db3095d06bd87100',
  'pipeline-arc-overview.md': '0a1f6ffa6908522e3690c5e9e53a6ee0',
  'pipeline-arc-verify.md': '36aa70cdfc25d7549573a4d556e7702c',
  'pipeline-volume-verify.md': '49458d36700cb94e34806d536ffe2940',
  'pipeline-arc-resolve.md': '5b340885c6e8f8afc63424d6b5bc7eb7',
  'pipeline-extract-scenes.md': 'c51fb208568d0d903eb43b437478b0ba',
  'writers-room-places.md': 'a7f68e51dd6b4421d20f5bd9d855d9b4',
  'cos-agent-briefing.md': 'dccb392a43cbd3dac900fee12c31619a',
  'universe-character-expand.md': '67b6e73ed47f318451a730088b4cff14',
  'story-builder-idea-expand.md': 'c12d76fefaaded2838023065bfc94bb0',
  'pipeline-editorial-analysis.md': 'daeb02bd54b0c099b21af659c6298cfe',
  'pipeline-manuscript-completeness.md': '1ee5ac936fbf1d365e0eaea99bcf1e77',
  'pipeline-manuscript-fix.md': 'c88a56304eb5e290ae0de9dadd20b310',
};

describe('buildPromptDriftTables', () => {
  it('sweeps the current shipped hash for every migration-managed stage prompt', async () => {
    const { stages } = await buildPromptDriftTables(migrationsDir);
    for (const [file, hash] of Object.entries(EXPECTED_STAGE_NEW)) {
      expect(stages.newMap[file], `${file} current hash`).toBe(hash);
    }
  });

  it('keys partial fragments under the _partials subdir, not stages', async () => {
    const tables = await buildPromptDriftTables(migrationsDir);
    // bible-deference.md is a _partials fragment (migration 022 declares it via
    // DRIFT_SUBDIRS) — it must land in the partial table, never the stage table.
    expect(tables._partials.newMap['bible-deference.md']).toBe('a4681348c27776e414acf6e0be566a99');
    expect(tables._partials.oldMap['bible-deference.md']).toEqual(['218f0e85643609ed85a12b1ccc7b5a8d']);
    expect(tables.stages.newMap['bible-deference.md']).toBeUndefined();
  });

  it('unions the accepted-old hashes across a multi-migration lineage', async () => {
    const { stages } = await buildPromptDriftTables(migrationsDir);
    // pipeline-idea-expansion.md evolved through 003 → 004 → 025 → 054(+fence).
    // Every intermediate shipped hash must be auto-updatable to the latest.
    expect(stages.oldMap['pipeline-idea-expansion.md'].sort()).toEqual([
      '1ee44cf95851ff8debf18729ebcd40b4',
      '1f3c5d077a5ef9a4b610335d5e3edd9c',
      '41facefbc0c0549d456bef9111f95ab9',
      'aee25112b2c596f643b17c559b772c22',
      'b5c47c94ffc74637983c95761ab0c66c',
    ]);
  });

  it('covers a prompt whose lineage spans two custom-export migrations', async () => {
    const { stages } = await buildPromptDriftTables(migrationsDir);
    // writers-room-places.md's hashes come from migrations 007 + 022 — both of
    // which export the standard constants only because this feature required it.
    expect(stages.oldMap['writers-room-places.md'].sort()).toEqual([
      '24a33628cc94d80fa5ca60831d973daf',
      '7f1f80eb63d67a21161994cde115045e',
    ]);
  });

  it('never lists the current hash among its own accepted-old set', async () => {
    const tables = await buildPromptDriftTables(migrationsDir);
    for (const table of [tables.stages, tables._partials]) {
      for (const file of table.files) {
        expect(table.oldMap[file]).not.toContain(table.newMap[file]);
      }
    }
  });
});
