/**
 * Refresh stock Prompt Manager descriptions while preserving edited copy and
 * all other installed stage settings.
 */
import { join } from 'node:path';
import { md5, readJsonOrNull, writeJsonAtomic } from './_lib.js';

const CONFIG_PATH = join('prompts', 'stage-config.json');

// Before this migration only missing stages received their shipped descriptions.
// Recognize the outgoing copy by stage so settings and custom copy stay intact.
const previousHashes = {
  'writers-room-format': '91fef72032b783d0f642541ea8989f32',
  'manuscript-reformat': '314854e8a438f98ff16f26f5935352aa',
  'writers-room-script': '6cd7c40fddca17b6a293173e8903be32',
  'writers-room-characters': '8d50766e46f60157d1102221bf82d8d7',
  'writers-room-places': '107ded24ee7e34823a125ad1332e580a',
  'writers-room-objects': '85f4d899619269f9e77ca5ab867a6d36',
  'writers-room-cuts': '4985c17b97e2de15bcaee25ac6c24c1e',
  'writers-room-revise': 'cdea6e9d7a0277bd2b53bb8b6d5b3bee',
  'writers-room-continue': '19fe7846586ab42b9f40e7d058277dee',
  'writers-room-cd-bridge': '0c5865b95c1cc65ff96a8431fccc2f2e',
  'catalog-ideas-scenes-concepts': 'd933c97923d490dadf7bd17bf58438fb',
  'cd-plan': '4aa4923d781d83a35b3eb6bc90d787aa',
  'pipeline-idea-expansion': '05215ad80ed5466f5d2b846d483c0f9f',
  'pipeline-prose': 'af24df6786b447fec67f55af84e7bd29',
  'pipeline-comic-script': '6f5c7eb7fc4da9ade3683b3f41788294',
  'pipeline-teleplay': 'be2b00e341769c73535c9a33a2646024',
  'pipeline-editorial-analysis': '8e1ff17157331358488034e1b9fe863b',
  'pipeline-judge-issue': 'b77abc33ada5c70d3fca457f38959a8b',
  'pipeline-judge-compare': 'ae0065532da27ea46233364714c6b55e',
  'pipeline-judge-foundation': '0e3fa25f4cbb744fc336acce1ce55291',
  'pipeline-character-foundation': '9ccdab3f8114ac0c363721d570e80089',
  'pipeline-foundation-repair': '054b8db04c9d94cbf5f6887294b752dc',
  'pipeline-panel-editor': 'c7618f6fba7b7407e7810c8487feb1f4',
  'pipeline-panel-genre-reader': 'a930b3a88a9e8ed73db72b55360537d1',
  'pipeline-panel-writer': '59dd14f432a5b6438bbc3aaf887aed1b',
  'pipeline-panel-first-reader': '9306fc4a95a59f5642697890fdcc0ecb',
  'pipeline-reverse-outline': '8fd7df695180a04cdf6a6b8ca1b84098',
  'pipeline-continuity-bible': 'c5175b03ce2cfd2a9150d2736442c508',
  'pipeline-extract-scenes': '2d6f755e0303d13a4577b0a5d29d21ba',
  'pipeline-audio-cues': '935f104c6b485429fe83884b71789bfc',
  'story-builder-idea-expand': '2e6c095678955c337b61aec5afce44a3',
  'story-builder-reader-map': '84934d5940b4375443cba4316e3d34be',
  'story-builder-reader-map-refine': 'e8ab4958281258a20c3b9545e3dfeefc',
  'story-builder-arc-refine': 'a9d9e1639196d03ba174d9f3c481572c',
  'pipeline-arc-overview': 'e5cad359047e09a3dd72504dc2d1fc60',
  'pipeline-season-episodes': 'b8f9e75f75dcdba76760862570455b2f',
  'pipeline-arc-verify': 'd9a53c4737dde8c752c951c0156cba4f',
  'pipeline-arc-resolve': 'ab4f2943da54a66c80e43945c143b3aa',
  'pipeline-volume-verify': '90bf6d549dd148e98409fc85ab12cdea',
  'pipeline-beat-continuity': '2c7bf918d6747ab3282ba7bbd410098e',
  'pipeline-beat-continuity-resolve': '05f615e1154be52b07c87914395dc3ec',
  'pipeline-script-verify': 'a5ae244a1bde3bd5cc018e34c15a854f',
  'pipeline-self-improve': '0845ad3cca2087ce965b28c87cb80da0',
  'pipeline-observer': '269188be4ed903d0129a9a78934e8394',
  'pipeline-manuscript-completeness': 'fd0ab1f366df67073a9220241c27064f',
  'pipeline-manuscript-fix': 'ec39d77a4850c62be126277d89a19a38',
  'pipeline-volume-cover-concepts': '4682d4a0d839a6f7912c29cf58d767b6',
  'pipeline-comic-cover-concepts': '5787cd990fe88ee968f2875dc31606a9',
  'pipeline-series-title-logo': '56de2107faaec79ee9d672a6a78fe4c4',
  'pipeline-series-generate': '258d25754b8507e317d9c4cb0458f6f5',
  'pipeline-series-concept-judge': 'c42b389f3326f4ea84b582c999b6cc1c',
  'pipeline-series-voice-discover': 'e2368ab841630f78626bdb299cd8b8c2',
  'pipeline-comic-panel-image-prompt': '3d48696369119d254175d0865dd378db',
  'pipeline-storyboard-image-prompt': '1502d0c4360923191854c787698f5afc',
  'pipeline-comic-page-refine-render': '6315c88d1019863b9ed0171818e88afd',
  'universe-character-expand': 'c2fd281b33e863a01810c1cafb56b62b',
  'universe-canon-entry-expand': '46bf6625942670a42685113daa2fb937',
  'importer-classify': 'e8eb9016bc0dc976a6f7316495bf951a',
  'importer-canon-extract': 'a75238b7ea3b1c6c55f11f807628ab88',
  'importer-arc-extract': '2a9c3f2e369d997711f87a11582a54d5',
  'importer-issue-proposal': '3571d3542e5a18400ef5c0724068c5e9',
  'pipeline-character-refine': 'f59662200b4241b7d705bb593f09a57f',
  'pipeline-character-differentiate-cast': '2c30b07b66c7e569bc484a882fae6745',
  'pipeline-canon-describe-from-prose': '635bb826687e37e2e8d535adb5e55f83',
  'pipeline-editorial-info-dumping': 'd02cd9b90031b4b962e6771146ad1a0a',
  'pipeline-editorial-interiority': 'b6228a555a0e5a705395c95dc7235823',
  'pipeline-editorial-chekhov': '05ca07276050e034d30b5836b36ffe7e',
  'pipeline-editorial-premature-reveal': 'c1d5856374501a9adeefa54464fbbe34',
  'pipeline-editorial-world-unforeshadowed-solution': 'aa776bbf37fc7f6afe9aaffc3371f6e2',
  'pipeline-editorial-world-cost-free-power': 'a07faf5305d33e2efd0ce07fc1acc397',
  'pipeline-editorial-comic-page-turn': '98d56024816aa8a3982215395e21ea4e',
  'pipeline-editorial-dead-metaphor': '475e83adb2def9e530927c5a346af130',
  'pipeline-editorial-opening-start': '5f06969a7e4f4aad4c975f4abd789597',
  'pipeline-editorial-mirror-description': 'e39a7cf3ad0d79280ac9956907b7e535',
  'pipeline-editorial-dialogue-pleasantries': 'e9d6f8e3743744dca56c034eda72bf3c',
  'pipeline-editorial-kill-your-darlings': '70c5320a18ecf261d9d061359db1be95',
  'pipeline-editorial-endings-cliffhanger': 'c9b7ab248685935587912417f98a6fa8',
  'pipeline-editorial-sensory-balance': 'c9e5bf88d84964eb6e61212953ef6287',
  'pipeline-editorial-white-room': 'e61f751cf8619e5b1eab4b52e0f71320',
  'pipeline-editorial-summary-not-scene': 'af6c6a97f6745ae97a84bad02f7bc12f',
  'pipeline-editorial-interiority-balance': '205e85da2dbfd5121154fedeedb63fc5',
  'pipeline-editorial-arc-transitions': 'd6f1aeac8cefae05e50e55bfab1cf758',
  'pipeline-editorial-timeline-contradiction': '9f34977c947e1edc0f77dfbf85193652',
  'pipeline-editorial-fact-accuracy': '3d462982b46d8696498571912ea6ff36',
  'pipeline-editorial-character-consistency': 'cefceee3b94847dd2d907ef57b234a22',
  'pipeline-editorial-object-motivation': '5c15ca92bd8e909349b6da7f7e9e0983',
  'pipeline-editorial-object-backstory': '1c2e64b2f746289ea8a7eecb17eca84f',
  'pipeline-editorial-object-weight-proportionality': 'bc4395acaf3e9305f2564f07a532b9a5',
  'pipeline-editorial-style-conformance': '29a1a71da1f83fd466763ef5dab963a7',
  'pipeline-pov-rewrite': 'c7c6dc2fff2a6461fa3fec5ec855db68',
  'pipeline-pov-analysis': 'c1ec15dd0ab124113ba07f87a1605ab3',
  'pipeline-editorial-telling-emotion': '3da2b320c2f0b269f75f5416c252d468',
  'pipeline-editorial-interiority-register': '3697bac890c06ba9985783764c11aa80',
  'pipeline-editorial-on-the-nose': 'd19c6834572088d91a45c2dc656299e8',
  'pipeline-editorial-reported-speech': '6cb43fab56d8bfd23724c6a3c502a904',
  'pipeline-editorial-voice-distinctiveness': '48b8401647e0f12897a1bbd8bc83fc49',
  'pipeline-editorial-voice-consistency': 'f5b6d1f4cccd0a0db7c6341f37c14391',
  'pipeline-editorial-plot-structure': '66a2d8db760fbaa4271930c233150d6c',
  'pipeline-editorial-head-hopping': 'bc3b3ed18706efe9ebebf8c60fd8d947',
  'pipeline-editorial-climax-agency': 'da1804a9dd55c6b98598c321558ba5d5',
  'pipeline-editorial-reaction-proportionality': 'ed00bb73a82fd13257feabd045a23909',
  'pipeline-editorial-secondary-arc': 'a0334f7bfef5ac2713cd91d098427eaf',
  'pipeline-editorial-theme-coherence': 'dc6f17da204f0fa59643036cad6b1c28',
  'pipeline-editorial-unmodeled-names': 'dced8fe4371ff64921186ed1328c9ffd',
  'pipeline-editorial-eyeline-match': 'ea3ee864fcb17c55cee284c4778a3bae',
  'pipeline-editorial-appearance-continuity': '7852b8a5043b52a5d0bbb1a13e375f35',
  'pipeline-editorial-comic-prose-sync': '0d250285fb5c8c4966c3d39299c2780b',
  'pipeline-editorial-pacing-escalation-curve': '97528a7442226f76e2e14b9d7e8d44dd',
  'pipeline-editorial-arc-regression': 'ac0180e658e341438f2606099b9fe996',
  'pipeline-editorial-adversarial-cuts': '9a0fbaddb4e4a2504fdcfec6695ec78b',
  'fableloom-weave-episode': 'cd561fe144c8a237a566eb6b806f23f7',
  'fableloom-outline-episode': '11c801d2fa0f04a2988f6a7e0b634651',
  'fableloom-branch-node': '87bd5ca44559a04008a8d9f6c1d6e1ca',
  'fableloom-generate-series-plan': '9f87b2eb746426218b6ce37eaa33f882',
  'fableloom-feedback-episode': '1cd54f528bb0386af6337a8cd77c3cdb',
  'fableloom-feedback-series-plan': 'e856c070b4fc26ec8c484298f5d4fdd6',
  'fableloom-play-turn': 'f960f530fa55423b4b152c1a5feecf97',
  'fableloom-reformat-scenes': 'fd164bfbdad4a7d7f6239f2048601dcf',
  'fableloom-review': '3d5bb77ad014f6fa91ff1a764f819612',
  'fableloom-review-series-plan': '908a296f0811977a4e7ebcc1a183ca84',
  'fableloom-review-series-teleplay': 'ae3111674bed58db0c7ac630fa892be0',
  'fableloom-editorial-remediate': '9d14545a363fd210e6dde515695b11b7',
  'fableloom-editorial-self-improve': 'ec3fd2c7eb98c00b4e94157e138dc15d',
  'fableloom-review-playthroughs': 'd415d3517794355956964098120f7f84',
  'universe-cast-integrity-review': 'b8db2cdef00d7c9ee002c169ff492ad8',
  'universe-character-augment': '5086ba76673b9669cc0c560cf5aaa80f',
};

export default {
  async up({ rootDir }) {
    const installedPath = join(rootDir, 'data', CONFIG_PATH);
    const installed = await readJsonOrNull(installedPath);
    if (!installed?.stages) return { updated: 0 };

    const reference = await readJsonOrNull(join(rootDir, 'data.reference', CONFIG_PATH));
    let updated = 0;
    for (const [name, previousHash] of Object.entries(previousHashes)) {
      const stage = installed.stages[name];
      const description = reference?.stages?.[name]?.description;
      if (
        typeof stage?.description !== 'string' || typeof description !== 'string' ||
        stage.description === description || md5(stage.description) !== previousHash
      ) continue;
      stage.description = description;
      updated += 1;
    }

    if (updated) await writeJsonAtomic(installedPath, installed);
    return { updated };
  },
};
