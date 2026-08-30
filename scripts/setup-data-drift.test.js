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
  'pipeline-idea-expansion.md': ['1ee44cf95851ff8debf18729ebcd40b4', '1f3c5d077a5ef9a4b610335d5e3edd9c', '41facefbc0c0549d456bef9111f95ab9', '49a208628290543ba2607a5ed48fdc8c', '93e9552c6662811e597a97296f3776a4', 'aee25112b2c596f643b17c559b772c22', 'b5c47c94ffc74637983c95761ab0c66c', 'c50f016639d41cd8244f5ff13429f997', 'd6fa86a435f978336661dcabca67258f'],
  'pipeline-prose.md': ['30ac30ec2b9d3e2a9eb869c181732cc6', '84523d531eeafa60959c65c553b2563f', 'bef1bc2767b78f585f2bd89f3d615130', 'bfea5aeeb471aae9749baee765b473a7', 'd1f8e3f1d214725b5aa67f309a81cd7d', '25e3d58c2741bd98acd5d08ba70d8a5e', '430d38ed2da59e0d4212e65edc499a74'],
  'writers-room-continue.md': ['93bfe80543ceca39842201a78b8393fa', '67663696c97ebaeb23de25f7410cfdd4'],
  'pipeline-comic-script.md': ['133d200d069c2e8173b7c129eea58f53', '1e0af305c27d0c80c4b482d2ebcb4a0d', '40e5fdc1a1e68a7419b7dad936366c1a', '7c05ecde539f04c9fa91e87543057204', 'a4303016c34b65e4b0e641fe71252de3', 'beab031951859ca13579cdb9c4dbe769', 'dea7d497d1cb38e7574f236f4ff8e644', 'e530fc76b89cedaef848ad7ec99c934c', 'e9ee70bf18888492edada6633cd9928a'],
  'pipeline-teleplay.md': ['1280ef6b1ad68fa44070ca7478ec2a5f', '2568e14beaa574d43f8018a5def51d04', '376f779f4687b598f1c92ca4e770fd5a', '3f6fecc25573ed054b47db392250034a', 'afa4215330bf856429d70d7e2f856605'],
  'pipeline-season-episodes.md': ['6e349ad26bed8a0ccb042571f03f03eb', 'c4928e2a5f833358116b29d2d669888d', '50c68a29c3ebc275db3095d06bd87100', 'a88e8e78a949b7aaf500d03314e2ea0b'],
  'pipeline-arc-overview.md': ['6a3ecab43d1f46b7ef9aab6c69ea0326', 'd34d72b8e49ba303d38607845dd87f1c', '0a1f6ffa6908522e3690c5e9e53a6ee0', '612f8b04950e2ff26dd350dd76a062fe', '74d6c26548660d85fc345b2099c63b6c', '648e11352cd1565aee490de1f662bef0'],
  'pipeline-arc-verify.md': ['52e31abc93e3105176236fcaa5d1575a', 'ff56d8387162017e08d5d0491060ddd6', '36aa70cdfc25d7549573a4d556e7702c', '83347e7d923580a3062033ab39b3c14b', '68f6956d7e09ebdb3870d8726b1b2a7a', '9f32e91bd33b97d30e1cbb2e697f4fc3', '90712f66ec68061ebed2147044e5baee', 'a397f158fd9c0dca1c8dbe62df253f70'],
  'importer-issue-proposal.md': ['a6838832f8289932836db84ee565b870'],
  'pipeline-volume-verify.md': ['03f3c874cb80e1c98abcf03168fa7a92', 'c6ea28e972ad6e229bafb2d602b4dda3', '49458d36700cb94e34806d536ffe2940', '3e8a8f00d5faaee9d8e08a49d801b812'],
  'pipeline-arc-resolve.md': ['0611db539437083621e19bb88b005e8d', '0787128babf3c4c50e2f2cdb60214030', '5b340885c6e8f8afc63424d6b5bc7eb7', '87bc5c01f1a8a97b681727a38b05edc6', '8bb134554c122d1583c479ab3010e53d', '8e348f3d1894382889f9f0ee7d5c6792', '96f73a7e90526d65ef2bb100fb1cd4bf', 'a8677bbe1eb38f871fb152a5b0fec7c6', 'cc27b4da1d1a13c35e35d1c2d6183815', '31eca76b68f40de1b93734fe9bc9f4bb', '17fbb066d7957dc2e345df1795bb0d9d', 'ebd85d3a0b5949f16877c25ca498cce9', '2349bce80e9df8caafa391a6106327b6', 'aa2e463ebe0857859d79aa0c6ccb0256'],
  'pipeline-script-verify.md': ['ed6c8101644cfe56a100eb6bfe3587f3'],
  'pipeline-extract-scenes.md': ['59fa5ee305ce53d91eb15224d8b546d3', 'c51fb208568d0d903eb43b437478b0ba'],
  'writers-room-places.md': ['24a33628cc94d80fa5ca60831d973daf', '7f1f80eb63d67a21161994cde115045e'],
  'universe-character-expand.md': ['ef109eb8e12ddb664c11c790271b5139', '67b6e73ed47f318451a730088b4cff14', '177b6e4e8bdf445308cf8ac423cd5ad8'],
  'story-builder-idea-expand.md': ['778c86e2caa120856c36e4d5a4da3355', 'a23939626a226f7420cebfb45d47950c'],
  'pipeline-editorial-analysis.md': ['14d9879697c66d51830cc798040d5369'],
  'pipeline-manuscript-completeness.md': ['4f2b95778aed85f5fc461d71eb461b79', 'e6858c74ab2cead752d388e3f428406c', '1ee5ac936fbf1d365e0eaea99bcf1e77', 'cec8faeb75dfff74e41b8221145c2e92'],
  'pipeline-manuscript-fix.md': ['196625952f4a36f3cb962c729f60f0ee', 'c88a56304eb5e290ae0de9dadd20b310', '88199bf7b5b50155bd2e1624bd920ebd'],
  'cos-agent-briefing.md': ['181b26838e526427173e4dccfc884d01', '3e1ca7f7b14b799f89a193c568003624', '699d053875472df455258724a0162bd5', '9bcd3a0167dd4aed7cfff7f404494dfb', 'af73fd50d6f29d561772474c12346e53', 'd761133753da290a0c02eca1c87709e4', 'dccb392a43cbd3dac900fee12c31619a'],
  'pipeline-editorial-telling-emotion.md': ['2c5c33709732fe7ffa319d32b8755354'],
  'pipeline-editorial-chekhov.md': ['bfacbf343ba2b9a3f6037bb45b94e1bb'],
  'pipeline-editorial-on-the-nose.md': ['48182b49149e6b5829fbed71b3ffc242'],
  'pipeline-tv-script.md': ['3f6fecc25573ed054b47db392250034a'],
  'cd-treatment.md': ['2ffa482e7bfb6fe8b7224505fedbf712', '16d0ef6a7fd2533719a846019122ebee', '95b7685690ecfee4f682b0293b790277'],
  'cd-plan.md': ['3ce871196a8fd04781b71b6780e89c86', '0768d6809645c2c1fe73cacae9740fe9', 'ef0d96f6ebde43af6c4579969d31cfb7'],
  'pipeline-series-generate.md': ['bc72731124a2bd6304362f4402c6305d'],
  'pipeline-character-foundation.md': ['f1c0b75a8161c0bc7f26752d148a5c1c', 'cda34127b40754ddbcc8544e3d82572b', 'd6c449c06de73a0868141c899b26e52c', '04419e382f3b46ed92bfaaa1d4f39e13'],
  'pipeline-judge-foundation.md': ['74c0244e641dcf7a73e9c83123ebdee9', '4c0bd349ff4d329048c9f4ac068745d4', 'edf7850d0c724c63761bc9fb667227d9', '02a8e9215ba534b333f3a29f11f3ac4f'],
  'pipeline-observer.md': ['f3dc51ac077050a887c2161ee7438181'],
  'pipeline-self-improve.md': ['ed0b0df42e0690d515b8dd88911931e4'],
  'fableloom-weave-episode.md': ['1fea11b8c4269008561ac22a30494d46', '1b27f5b0073a304c21079aa6e2c71447', '4c9454d1537c4ebb3becbfa04fae3ed8', '18a442e39b973e4074a0d595928a665d'],
  'fableloom-branch-node.md': ['f558e4804b056a5961af1ea74fdef2ba', '6279b1c9912c300363a727245d22fe84', 'c14e2b9c435e43a8c3b134a62cd66d08'],
  'fableloom-play-turn.md': ['bb33dc9bc483668d88196ca972d5f364'],
  'fableloom-feedback-episode.md': ['43d1525fcedce99b933ae5b003516a36', 'd09bb405478d24c294b0c658ef365cd1'],
  'fableloom-review.md': ['2802f269f246e00ec5a8937637d42de6'],
  'fableloom-outline-episode.md': ['3f5144103b2ab6203fa071ff5026251b'],
  'fableloom-review-episode-outline.md': ['96d631104155ff11be08bcc5144cca1c'],
};
const EXPECTED_STAGE_NEW = {
  'pipeline-idea-expansion.md': 'a032e4a724251ed3e3495d33c4dbab8e',
  'pipeline-prose.md': '4cb3ef48309f3673570cf80e4d544b54',
  'writers-room-continue.md': '458dc5ff4732befc1fb90890bdc885c2',
  'pipeline-comic-script.md': '49af30c05f008b20f6998a0f113f7d87',
  'pipeline-teleplay.md': '2ea9974ac3803658b2314db1f5818b77',
  'pipeline-season-episodes.md': '7c24df53c097c2525a52bfb766239647',
  'pipeline-arc-overview.md': '5ed760caaf3cf88916ec28b220e2f590',
  'pipeline-arc-verify.md': '4b60a322e35b536405d0fbf543580562',
  'importer-issue-proposal.md': '9ba2ff965fba61efb85a3568bb530055',
  'pipeline-volume-verify.md': '9c0839d7fe1760c0891464afd4a3b8fd',
  'pipeline-arc-resolve.md': '638b988c84b3e5599f7a2ce09fa149ce',
  'pipeline-script-verify.md': '722c62462d05462603cf67ca0ed1dee8',
  'pipeline-extract-scenes.md': '9f404b0c4721b23932a6d2dcfc1fba43',
  'writers-room-places.md': 'a7f68e51dd6b4421d20f5bd9d855d9b4',
  'cos-agent-briefing.md': 'a01c81d3a7f4ac0ca9e8d5137735c0e3',
  'universe-character-expand.md': '924fe8836f3014873d1789e98e997db2',
  'story-builder-idea-expand.md': 'c12d76fefaaded2838023065bfc94bb0',
  'pipeline-editorial-analysis.md': 'daeb02bd54b0c099b21af659c6298cfe',
  'pipeline-manuscript-completeness.md': 'fd26f928c33803c12878a1bfb8561ece',
  'pipeline-manuscript-fix.md': 'e2baaf0f2f53c8aa1e934a428c0ca583',
  'pipeline-editorial-telling-emotion.md': '871f7e8bea2a2d95f28875ab45a318e2',
  'pipeline-editorial-chekhov.md': '1f8a1696b5e4f476051dc5b2e5737db9',
  'pipeline-editorial-on-the-nose.md': 'e5786fb019e5bf19c7aa6ed0c8b35cda',
  'pipeline-tv-script.md': '376f779f4687b598f1c92ca4e770fd5a',
  'cd-treatment.md': 'd940eadfb406ce584f0e244032f33382',
  'cd-plan.md': '41a61590896d1327df2c6915557361de',
  'pipeline-series-generate.md': '21352c21ed6d4edb7a4b7c32704eff55',
  'pipeline-character-foundation.md': 'b7d2bac347e11171606f4c6acfcd32e1',
  'pipeline-judge-foundation.md': 'e44b6c50d741bbd21fc86f481684c410',
  'pipeline-observer.md': '29e0212d2252b1be3278f20e2959eb8e',
  'pipeline-self-improve.md': '95b378832ff78e5976a6a63fcf328090',
  'fableloom-weave-episode.md': 'e0f8d864caa8746912b56cd567f1c09d',
  'fableloom-branch-node.md': '39a208c8cc593d0531af50760e3cf0da',
  'fableloom-play-turn.md': 'e35ad91aae263e3adf28d1e047a46661',
  'fableloom-feedback-episode.md': '1aaa6f17acad6a3215e48dcce14e8670',
  'fableloom-review.md': 'c26a641f6d0530caef7d1186c3b09937',
  'fableloom-outline-episode.md': '513b2b5b8fa98766852cdde7b87198c9',
  'fableloom-review-episode-outline.md': '8154b4c289b10268df8fd3c625bcdac2',
};
const EXPECTED_PARTIAL_OLD = {
  'bible-deference.md': ['218f0e85643609ed85a12b1ccc7b5a8d'],
  'craft-anti-patterns.md': ['bd0149bf1a5c721e65e053dad8e536d3'],
};
const EXPECTED_PARTIAL_NEW = {
  'bible-deference.md': 'a4681348c27776e414acf6e0be566a99',
  'craft-anti-patterns.md': 'f34e75f19ac4e41aa0533a0abcb38a2a',
};

// Compare a swept oldMap to a baseline with each hash list order-normalized.
const sortValues = (map) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].sort()]));

// A deep-equal on 28 keys reports only "expected { …(28) } to deeply equal
// { …(28) }", which reads as an unrelated regression on whatever PR happens to
// inherit it — three PRs were triaged past this break before it was traced to
// `main`. Name the files and hashes that actually moved, and say what to do.
// Interpolating an array renders it comma-joined and indistinguishable from the
// single joined string it is NOT — the same collapse the filter avoids below.
const render = (value) => (value === undefined ? '(absent)' : JSON.stringify(value));

const describeDrift = (actual, expected) =>
  [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .map((file) => ({ file, was: expected[file], now: actual[file] }))
    // Structural, not stringified: String(['a', 'b']) === String('a,b'), so a
    // hash list that lost its element boundaries would compare equal.
    .filter(({ was, now }) => JSON.stringify(was) !== JSON.stringify(now))
    .map(({ file, was, now }) => `  ${file}: baseline ${render(was)} -> migrations ship ${render(now)}`);

const expectMatchesBaseline = (actual, expected, label) => {
  const drifted = describeDrift(actual, expected);
  expect(
    drifted.length === 0 ||
      `${label} drifted from the baseline in scripts/setup-data-drift.test.js:\n${drifted.join('\n')}\n` +
        'A prompt migration shipped a new body without carrying this baseline with it. ' +
        'Point the baseline at the shipped hash and add the superseded hash to that file\'s accepted-old set.',
  ).toBe(true);
};

describe('buildPromptDriftTables', () => {
  it('reproduces the full stage drift table the hand-mirror used to carry', async () => {
    const { stages } = await buildPromptDriftTables(migrationsDir);
    expectMatchesBaseline(stages.newMap, EXPECTED_STAGE_NEW, 'Current stage-prompt hashes');
    expectMatchesBaseline(
      sortValues(stages.oldMap),
      sortValues(EXPECTED_STAGE_OLD),
      'Accepted-old stage-prompt hashes',
    );
    expect(stages.files.sort()).toEqual(Object.keys(EXPECTED_STAGE_NEW).sort());
  });

  it('keys partial fragments under the _partials subdir, not stages', async () => {
    const { stages, _partials } = await buildPromptDriftTables(migrationsDir);
    // bible-deference.md is a _partials fragment (migration 022 declares it via
    // DRIFT_SUBDIRS) — it must land in the partial table, never the stage table.
    expect(_partials.newMap).toEqual(EXPECTED_PARTIAL_NEW);
    expect(sortValues(_partials.oldMap)).toEqual(sortValues(EXPECTED_PARTIAL_OLD));
    expect(stages.newMap['bible-deference.md']).toBeUndefined();
    expect(stages.newMap['craft-anti-patterns.md']).toBeUndefined();
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
