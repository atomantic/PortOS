import { makeSeedMigration } from './_seedStageHelpers.js';

// A new stage: seed missing assets without replacing customized legacy prompts.
export default makeSeedMigration('catalog-extract');
