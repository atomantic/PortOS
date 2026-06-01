/**
 * Contract test for the prompt-drift sweep that scripts/setup-data.js uses to
 * warn about pending migrations. Before this, setup-data.js hand-mirrored every
 * migration's ACCEPTED_OLD_MD5 / NEW_SHIPPED_MD5 hashes — the spot most likely
 * to drift out of sync. `buildPromptDriftTables` now sweeps those constants
 * straight from the migration files, so this test pins the FULL swept result
 * (every file's old-hash set + current hash) against the known-good baseline —
 * the exact tables setup-data.js used to carry by hand. If a migration ships a
 * new prompt hash without exporting it, drops an accepted-old hash, or exports
 * a wrong one, the baseline assertion fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { buildPromptDriftTables } from './migrations/_lib.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// The complete, independent baseline — transcribed from the hand-maintained
// SHIPPED_PROMPT_OLD_MD5 / SHIPPED_PROMPT_NEW_MD5 tables this sweep replaced.
// `pipeline-tv-script.md` is the one addition: it's a retired prompt (renamed
// to teleplay) that the sweep surfaces from migration 003 and setup-data.js's
// sample-existence filter drops downstream — so its presence here documents
// that the sweep itself is expected to carry it.
const EXPECTED_STAGE_OLD = {
  'pipeline-idea-expansion.md': ['1ee44cf95851ff8debf18729ebcd40b4', '1f3c5d077a5ef9a4b610335d5e3edd9c', '41facefbc0c0549d456bef9111f95ab9', 'aee25112b2c596f643b17c559b772c22', 'b5c47c94ffc74637983c95761ab0c66c'],
  'pipeline-prose.md': ['30ac30ec2b9d3e2a9eb869c181732cc6', 'bef1bc2767b78f585f2bd89f3d615130', 'bfea5aeeb471aae9749baee765b473a7', 'd1f8e3f1d214725b5aa67f309a81cd7d'],
  'pipeline-comic-script.md': ['133d200d069c2e8173b7c129eea58f53', '1e0af305c27d0c80c4b482d2ebcb4a0d', '40e5fdc1a1e68a7419b7dad936366c1a', 'beab031951859ca13579cdb9c4dbe769', 'e530fc76b89cedaef848ad7ec99c934c'],
  'pipeline-teleplay.md': ['1280ef6b1ad68fa44070ca7478ec2a5f', '2568e14beaa574d43f8018a5def51d04', '376f779f4687b598f1c92ca4e770fd5a', '3f6fecc25573ed054b47db392250034a'],
  'pipeline-season-episodes.md': ['6e349ad26bed8a0ccb042571f03f03eb', 'c4928e2a5f833358116b29d2d669888d'],
  'pipeline-arc-overview.md': ['6a3ecab43d1f46b7ef9aab6c69ea0326', 'd34d72b8e49ba303d38607845dd87f1c'],
  'pipeline-arc-verify.md': ['52e31abc93e3105176236fcaa5d1575a', 'ff56d8387162017e08d5d0491060ddd6'],
  'pipeline-volume-verify.md': ['03f3c874cb80e1c98abcf03168fa7a92', 'c6ea28e972ad6e229bafb2d602b4dda3'],
  'pipeline-arc-resolve.md': ['87bc5c01f1a8a97b681727a38b05edc6', '8e348f3d1894382889f9f0ee7d5c6792', 'a8677bbe1eb38f871fb152a5b0fec7c6'],
  'pipeline-extract-scenes.md': ['59fa5ee305ce53d91eb15224d8b546d3'],
  'writers-room-places.md': ['24a33628cc94d80fa5ca60831d973daf', '7f1f80eb63d67a21161994cde115045e'],
  'universe-character-expand.md': ['ef109eb8e12ddb664c11c790271b5139'],
  'story-builder-idea-expand.md': ['778c86e2caa120856c36e4d5a4da3355', 'a23939626a226f7420cebfb45d47950c'],
  'pipeline-editorial-analysis.md': ['14d9879697c66d51830cc798040d5369'],
  'pipeline-manuscript-completeness.md': ['4f2b95778aed85f5fc461d71eb461b79', 'e6858c74ab2cead752d388e3f428406c'],
  'pipeline-manuscript-fix.md': ['196625952f4a36f3cb962c729f60f0ee'],
  'cos-agent-briefing.md': ['181b26838e526427173e4dccfc884d01', '3e1ca7f7b14b799f89a193c568003624', '699d053875472df455258724a0162bd5', '9bcd3a0167dd4aed7cfff7f404494dfb', 'af73fd50d6f29d561772474c12346e53', 'd761133753da290a0c02eca1c87709e4'],
  'pipeline-tv-script.md': ['3f6fecc25573ed054b47db392250034a'],
};
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
  'pipeline-tv-script.md': '376f779f4687b598f1c92ca4e770fd5a',
};
const EXPECTED_PARTIAL_OLD = {
  'bible-deference.md': ['218f0e85643609ed85a12b1ccc7b5a8d'],
};
const EXPECTED_PARTIAL_NEW = {
  'bible-deference.md': 'a4681348c27776e414acf6e0be566a99',
};

// Compare a swept oldMap to a baseline with each hash list order-normalized.
const sortValues = (map) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].sort()]));

describe('buildPromptDriftTables', () => {
  it('reproduces the full stage drift table the hand-mirror used to carry', async () => {
    const { stages } = await buildPromptDriftTables(migrationsDir);
    expect(stages.newMap).toEqual(EXPECTED_STAGE_NEW);
    expect(sortValues(stages.oldMap)).toEqual(sortValues(EXPECTED_STAGE_OLD));
    expect(stages.files.sort()).toEqual(Object.keys(EXPECTED_STAGE_NEW).sort());
  });

  it('keys partial fragments under the _partials subdir, not stages', async () => {
    const { stages, _partials } = await buildPromptDriftTables(migrationsDir);
    // bible-deference.md is a _partials fragment (migration 022 declares it via
    // DRIFT_SUBDIRS) — it must land in the partial table, never the stage table.
    expect(_partials.newMap).toEqual(EXPECTED_PARTIAL_NEW);
    expect(sortValues(_partials.oldMap)).toEqual(sortValues(EXPECTED_PARTIAL_OLD));
    expect(stages.newMap['bible-deference.md']).toBeUndefined();
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
