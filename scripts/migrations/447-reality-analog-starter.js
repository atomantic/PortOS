/** Upgrade untouched V1 photography defaults; preserve customized or locked worlds. */
import { withTransaction } from '../../server/lib/db.js';
import { isDeepStrictEqual } from 'node:util';
import { toPgJson } from '../../server/lib/pgJson.js';
import { REALITY_STARTER_V1 } from '../../server/lib/realityStarterV1.js';
import { REALITY_STARTER_V2 } from '../../server/lib/realityStarterV2.js';

export default {
  async up() {
    await withTransaction(async client => {
      const { rows } = await client.query('SELECT data, deleted FROM universes WHERE id = $1 FOR UPDATE', ['universe-reality']);
      const row = rows[0];
      const record = row?.data;
      if (!record || row.deleted || record.deleted || record.factual !== true || record.name !== 'Reality'
        || record.visualProfile != null || Object.values(record.locked || {}).some(Boolean)) return;
      if (Object.keys(REALITY_STARTER_V1).some(key => !isDeepStrictEqual(record[key], REALITY_STARTER_V1[key]))) return;
      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(record.updatedAt) || 0) + 1)).toISOString();
      const next = { ...record, ...structuredClone(REALITY_STARTER_V2), updatedAt };
      await client.query('UPDATE universes SET data = $2::jsonb, updated_at = $3 WHERE id = $1', [record.id, toPgJson(next), updatedAt]);
    });
  },
};
