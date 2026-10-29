/** Publication ownership is db-primary and machine-local, never federated.
 * The JSON adapter exists only for the supported dev/test escape hatch.
 */
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createPgFileFacade, resolvePgBackend } from '../lib/pgFileFacade.js';
import { toPgJson } from '../lib/pgJson.js';

const file = () => join(PATHS.cos, 'release-synchronization.json');
const immutable = ({ registeredAt: _registeredAt, attempts: _attempts, lastAttemptAt: _lastAttemptAt, blocker: _blocker, retryAt: _retryAt,
  obligations: _obligations, synchronization: _synchronization, legacyRecovery: _legacyRecovery, operatorReset: _operatorReset, ...record }) => record;
const conflict = () => { throw new Error('Release synchronization immutable ownership changed'); };

const facade = createPgFileFacade({
  makeFile: () => ({
    async read() { return readJSONFile(file(), { version: 1, publications: {} }, { strict: true }); },
    async save(entry) {
      const outbox = await this.read();
      if (outbox.version !== 1 || !outbox.publications || Array.isArray(outbox.publications)) throw new Error('Release synchronization outbox is unreadable');
      const prior = outbox.publications[entry.identity];
      if (prior && (!isDeepStrictEqual(immutable(prior), immutable(entry))
        || (prior.legacyRecovery && !isDeepStrictEqual(prior.legacyRecovery, entry.legacyRecovery))
        || (prior.operatorReset && !isDeepStrictEqual(prior.operatorReset, entry.operatorReset)))) conflict();
      outbox.publications[entry.identity] = entry;
      await atomicWrite(file(), outbox);
    },
  }),
  makePg: () => resolvePgBackend({
    requirement: 'Release synchronization requires PostgreSQL', loadDb: () => import('../lib/db.js'),
    makePg: ({ query }) => ({
      async read() {
        const { rows } = await query('SELECT identity, record FROM cos_release_synchronizations ORDER BY identity');
        return { version: 1, publications: Object.fromEntries(rows.map(row => [row.identity, row.record])) };
      },
      async save(entry) {
        const { rows } = await query(`INSERT INTO cos_release_synchronizations (identity, record) VALUES ($1, $2::jsonb)
          ON CONFLICT (identity) DO UPDATE SET record = EXCLUDED.record
          WHERE cos_release_synchronizations.record - ARRAY['registeredAt', 'attempts', 'lastAttemptAt', 'blocker', 'retryAt', 'obligations', 'synchronization', 'legacyRecovery', 'operatorReset']
            = EXCLUDED.record - ARRAY['registeredAt', 'attempts', 'lastAttemptAt', 'blocker', 'retryAt', 'obligations', 'synchronization', 'legacyRecovery', 'operatorReset']
            AND (NOT (cos_release_synchronizations.record ? 'legacyRecovery')
              OR cos_release_synchronizations.record->'legacyRecovery' = EXCLUDED.record->'legacyRecovery')
            AND (NOT (cos_release_synchronizations.record ? 'operatorReset')
              OR cos_release_synchronizations.record->'operatorReset' = EXCLUDED.record->'operatorReset')
          RETURNING identity`, [entry.identity, toPgJson(entry)]);
        if (rows.length !== 1) conflict();
      },
    }),
  }),
});

// The lifecycle's single queue owns read/merge/write AND task publication.
export async function readReleaseSynchronizationOutbox() { return (await facade.getBackend()).read(); }
export async function saveReleaseSynchronization(entry) { return (await facade.getBackend()).save(entry); }
