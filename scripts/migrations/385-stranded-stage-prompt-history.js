import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'catalog-ideas-scenes-concepts.md': ['243074821ebc58eec63e26d284101b29'],
  'fableloom-branch-node.md': [
    'e5005826c4577623ba362a0292741c7c',
    'ff5d40b3090c775fc9c1f48c2ea96bbd',
  ],
  'fableloom-feedback-episode.md': ['9ff21b47c4251585da9500c306d91a28'],
  'fableloom-feedback-series-plan.md': ['c56a3de3776cf7ef8ba16782f0691144'],
  'fableloom-review-series-plan.md': ['d7d3b306c82cea4d7f13a78512a46948'],
  'fableloom-weave-episode.md': ['990cdecf9e46fa049ae4aae27e3b172d'],
  'manuscript-reformat.md': ['4df6381d5c685c683a518326b7908e18'],
  'pipeline-comic-script.md': ['9fe2451b573fc60eb6c971e1b8808ef3'],
  'pipeline-editorial-appearance-continuity.md': [
    '25ccc731f1596a99d21600919896a8e3',
  ],
  'pipeline-editorial-arc-transitions.md': ['4c297e92df472965be8641f8b9ce9853'],
  'pipeline-editorial-chekhov.md': ['21246b605f442f8c749fc2835bd293b5'],
  'pipeline-editorial-climax-agency.md': [
    '55c25664b9904806146f92cc739d7208',
    'f6611ff22e36d6738b3b4faa9c1310df',
  ],
  'pipeline-editorial-endings-cliffhanger.md': [
    '3ef5e6fbc160f9f33902ab22d9284281',
  ],
  'pipeline-editorial-eyeline-match.md': ['5d0b8d0d4605225d208786165e26abb4'],
  'pipeline-editorial-head-hopping.md': ['460e6449c4f1daec815b9ff0a6573f97'],
  'pipeline-editorial-object-weight-proportionality.md': [
    '89f6f6c6856ebcf0183b7760d71a6898',
    'c1b7b58e0255c86b6ba5cece4330ac48',
    'f4f91a4ea55a9fd89eaebc70074a89ec',
  ],
  'pipeline-editorial-on-the-nose.md': ['8d9038a2b197728f6edeedb84699f364'],
  'pipeline-editorial-reaction-proportionality.md': [
    '38ca1b6edaa55c8989e22e7ffdbd76c7',
    '8787e6e40f8bb46067b8303b866c7ff8',
  ],
  'pipeline-editorial-secondary-arc.md': ['6ad9eb7c4969d8baeb2c8c38d8f6695e'],
  'pipeline-editorial-timeline-contradiction.md': [
    'f39272a486d4cc031ebb7b3b8fc01ed3',
  ],
  'pipeline-editorial-unmodeled-names.md': [
    '2e562a414726b5b412537ad4ecbdbff5',
    '50029186d6009d50c3850f3f4b90a5d6',
    '9b9732f729c96dd7154175b77755fdd2',
    'd34323ee9bf05fffc3584ad9d91146bd',
  ],
  'pipeline-editorial-world-cost-free-power.md': [
    '42db5691fa6e4b2db9a146a821ed1fe7',
  ],
  'pipeline-editorial-world-unforeshadowed-solution.md': [
    '9a23180e49fbac1699c846ced1625575',
  ],
  'pipeline-idea-expansion.md': ['c5b2e719e232a281b3829a5348cb29c1'],
  'pipeline-manuscript-fix.md': ['87c6e47030df07b37ace44d2a15372cf'],
  'pipeline-pov-rewrite.md': ['cd073c8dbca2bf25eea07b6103e27d81'],
  'pipeline-script-verify.md': ['cec35763c134fcac8bd4e9669ab5505a'],
  'story-builder-reader-map-refine.md': ['befd154bb319c221f16ca357a23f1aa7'],
  'story-builder-reader-map.md': ['af375710531a34b8fe265b425be42b3d'],
};

export const NEW_SHIPPED_MD5 = {
  'catalog-ideas-scenes-concepts.md': 'e6cce39c76689ea9c5233f233cd0f153',
  'fableloom-branch-node.md': '39a208c8cc593d0531af50760e3cf0da',
  'fableloom-feedback-episode.md': '1aaa6f17acad6a3215e48dcce14e8670',
  'fableloom-feedback-series-plan.md': 'ece17ecf3ee0d6018f3ca350794d8d52',
  'fableloom-review-series-plan.md': 'd82ff6df1d41c3e53fb0cc7ea49f8dc5',
  'fableloom-weave-episode.md': '94f22c0807924dadf151341c30720c71',
  'manuscript-reformat.md': '1a02cf3ac59b5c253359357608c1c4ad',
  'pipeline-comic-script.md': '49af30c05f008b20f6998a0f113f7d87',
  'pipeline-editorial-appearance-continuity.md':
    '8ef03aa3ed15557febe85d7ee66b6cc6',
  'pipeline-editorial-arc-transitions.md': '46cb5444f41d05fb7bdbc219d62619b2',
  'pipeline-editorial-chekhov.md': '1f8a1696b5e4f476051dc5b2e5737db9',
  'pipeline-editorial-climax-agency.md': '255ad29214f48e6dd1c17adbb5887478',
  'pipeline-editorial-endings-cliffhanger.md':
    'deaebfa026d40a6e576479ecc4f1e98b',
  'pipeline-editorial-eyeline-match.md': '7c66926cbf8f7174ca17043e1f2e2251',
  'pipeline-editorial-head-hopping.md': '00e596e9dea15b3154a6a9f3509e90a5',
  'pipeline-editorial-object-weight-proportionality.md':
    '761890e3dcdc2cd828ec2be2a5f9cb82',
  'pipeline-editorial-on-the-nose.md': 'e5786fb019e5bf19c7aa6ed0c8b35cda',
  'pipeline-editorial-reaction-proportionality.md':
    'b15471388a184d6f805e6dfac76fb164',
  'pipeline-editorial-secondary-arc.md': 'a9bd4dd9a06bc571f0363e0031d9a5d7',
  'pipeline-editorial-timeline-contradiction.md':
    '2d797a9fa3b55f4c9f85c22cc0baa547',
  'pipeline-editorial-unmodeled-names.md': '6b35274e08ea9b5727c42f6ef6653cd5',
  'pipeline-editorial-world-cost-free-power.md':
    '2b761163f63c2e4fbe8dc6d7f6e577f7',
  'pipeline-editorial-world-unforeshadowed-solution.md':
    '09d5997e8c9ea77a5cf1bf446ef211f1',
  'pipeline-idea-expansion.md': 'a032e4a724251ed3e3495d33c4dbab8e',
  'pipeline-manuscript-fix.md': 'e2baaf0f2f53c8aa1e934a428c0ca583',
  'pipeline-pov-rewrite.md': 'eedcc03aaaf7e22e7726491f08d52974',
  'pipeline-script-verify.md': '722c62462d05462603cf67ca0ed1dee8',
  'story-builder-reader-map-refine.md': 'd8f02936a237a9e4e964d7250a118e17',
  'story-builder-reader-map.md': '21929c9f7a7bd54c17c9dfdf00213987',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'Previously stranded shipped stage-prompt history',
  customizedHint: (filename) =>
    `   Merge the current shipped guidance from data.reference/prompts/stages/${filename} into the customized prompt.`,
});

export { applyMigration };
export default { up };
