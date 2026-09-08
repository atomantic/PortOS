/**
 * Teach the five character-arc editorial checks the five-stage evolution lens
 * (#6442, epic #6418).
 *
 * The checks could already see the AUTHORED arcs (want/need, start → end state,
 * transition beats) but not the staged causal chain underneath them — which
 * belief was under test, what pressure forced the exploration, what the
 * character chose, what it cost, and what final BEHAVIOR proves the change. Two
 * consequences: a climax won purely by external victory read as a clean
 * resolution, and a deliberately flat or tragic ending read as a defect. The
 * new `{{characterEvolution}}` section carries the chain plus the four declared
 * outcomes, makes the outcome change the verdict rather than suppress the
 * check, and splits "no authored intent" from "authored intent not delivered"
 * so the two get different repairs.
 *
 * The section is mustache-gated, so an install with no lens authored renders
 * byte-identical prompts to the pre-migration ones. Hash replacement preserves
 * customized prompts.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-editorial-character-consistency.md': ['69bbee3a1bb126b2675d8b00f5aef48c'],
  'pipeline-editorial-secondary-arc.md': ['8a96ce93f6592fed3d30e221497739a4'],
  'pipeline-editorial-arc-transitions.md': ['72e27707f0dc82eab84eed74e9707587'],
  'pipeline-editorial-arc-regression.md': ['85b15c9e913fe8a436d407f1562a2b10'],
  'pipeline-editorial-climax-agency.md': ['1bca84f9a0b7cde84e20e43702a12ffa'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-editorial-character-consistency.md': 'bbefd9b033cc7830752acf87722659a0',
  'pipeline-editorial-secondary-arc.md': 'a9bd4dd9a06bc571f0363e0031d9a5d7',
  'pipeline-editorial-arc-transitions.md': '46cb5444f41d05fb7bdbc219d62619b2',
  'pipeline-editorial-arc-regression.md': '8e34b3a84cd7f948592a2a94b28caee4',
  'pipeline-editorial-climax-agency.md': '255ad29214f48e6dd1c17adbb5887478',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'Character-evolution editorial prompts',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the\n` +
    '   "Authored character evolution (five-stage lens)" section with its\n' +
    '   {{characterEvolution}} block, declared-outcome rulings, and the\n' +
    '   "no authored intent" / "authored intent not delivered" split.',
});

export { applyMigration };
export default { up };
