/** Teach existing Pipeline installs to diagnose stalled scene tactics (#7205). */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-editorial-plot-structure.md': ['400d829dd291753a299fa08d6afbe561'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-editorial-plot-structure.md': '2a4fe67b7b5e128314c385bb458decf2',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'Pipeline stalled-scene progression',
  customizedHint: (filename) =>
    `   Merge the stalled-scene tactic and chunk-boundary guidance from data.reference/prompts/stages/${filename}.`,
});

export { applyMigration };
export default { up };
