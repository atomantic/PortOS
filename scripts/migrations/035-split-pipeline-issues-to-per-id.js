/**
 * Split `data/pipeline-issues.json` into per-record files under
 * `data/pipeline-issues/{id}/index.json`.
 *
 * The legacy single-file shape serialized every issue edit behind one write
 * queue. The collection layout keeps record writes scoped to the issue id, so
 * unrelated issue PATCHes can proceed independently.
 *
 * Shares the split skeleton with 034 / 036 / 059 via `makeSplitMigration` —
 * issues carry no cross-record type-level state, so `config` is `{}`.
 */

import { makeSplitMigration } from './_lib.js';

const VALID_ID = /^iss-[A-Za-z0-9-]+$/;

export default makeSplitMigration({
  migrationLabel: 'migration 035',
  typeDirName: 'pipeline-issues',
  legacyFilename: 'pipeline-issues.json',
  backupSuffix: '.bak-035',
  typeSchemaVersion: 1,
  typeLabel: 'pipelineIssues',
  recordsKey: 'issues',
  idPattern: VALID_ID,
  recordNoun: 'issue',
});
