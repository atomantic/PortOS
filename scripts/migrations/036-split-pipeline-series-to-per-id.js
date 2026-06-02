/**
 * Split `data/pipeline-series.json` into per-record files under
 * `data/pipeline-series/{id}/index.json`.
 *
 * Shares the split skeleton with 034 / 035 / 059 via `makeSplitMigration` —
 * series carry no cross-record type-level state, so `config` is `{}`.
 */

import { makeSplitMigration } from './_lib.js';

const VALID_ID = /^ser-[A-Za-z0-9-]+$/;

export default makeSplitMigration({
  migrationLabel: 'migration 036',
  typeDirName: 'pipeline-series',
  legacyFilename: 'pipeline-series.json',
  backupSuffix: '.bak-036',
  typeSchemaVersion: 1,
  typeLabel: 'pipelineSeries',
  recordsKey: 'series',
  idPattern: VALID_ID,
  recordNoun: 'series record',
});
