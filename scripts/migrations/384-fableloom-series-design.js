import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-editorial-remediate.md': ['c0cce5cfe63ec4e94047415bbe83881b'],
  'fableloom-feedback-series-plan.md': ['2d1b40041223baa02a1517a102f103c2'],
  'fableloom-generate-series-plan.md': ['27336d8c64e6193aecd1ba697f52315e'],
  'fableloom-outline-episode.md': ['2ff6fb72777ff0c6fc70f3afd0ddfd53'],
  'fableloom-review-episode-outline.md': ['0f549ed25dea8566ce2d3c515968783b'],
  'fableloom-review-playthroughs.md': ['27843c9a77dc9dcfb8a9b12102253541'],
  'fableloom-review-series-plan.md': ['588c82fafd733581490f24cb6fb4bfa7'],
  'fableloom-review-series-teleplay.md': ['fc87fe58f599be451d245ce4f26d9691'],
  'fableloom-weave-episode.md': ['abea2442af2be2039b70deee4919c00e'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-editorial-remediate.md': '75f23d18fdf3b4ca3f329db8c61aec9d',
  'fableloom-feedback-series-plan.md': 'ece17ecf3ee0d6018f3ca350794d8d52',
  'fableloom-generate-series-plan.md': 'ab912a52879d8ce78e9998dec19ddaa8',
  'fableloom-outline-episode.md': '76f5211b851de7a0a23d9c11c5969b25',
  'fableloom-review-episode-outline.md': '3e548d8de54dd23312a6f1024910fedc',
  'fableloom-review-playthroughs.md': 'c24c3799c8ef9050c16a3fa4b56920e2',
  'fableloom-review-series-plan.md': 'd82ff6df1d41c3e53fb0cc7ea49f8dc5',
  'fableloom-review-series-teleplay.md': '10a3289dd0824539f7ccbcd4a579c865',
  'fableloom-weave-episode.md': '94f22c0807924dadf151341c30720c71',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom series design',
  customizedHint: (filename) => `   Merge the series-design guidance from data.reference/prompts/stages/${filename} into your customized prompt.`,
});

export { applyMigration };
export default { up };
