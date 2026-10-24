/** Populate the blank Reality seeded by 395; preserve customization and tombstones. */
import { withTransaction } from '../../server/lib/db.js';
import { REALITY_STARTER_V1 } from '../../server/lib/realityStarterV1.js';

export default {
  async up() {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT data, deleted FROM universes WHERE id = $1 FOR UPDATE', ['universe-reality']);
      const row = rows[0];
      const record = row?.data;
      if (!record || row.deleted || record.deleted || record.name !== 'Reality' || record.factual !== true) return;
      const fields = ['starterPrompt', 'logline', 'premise', 'styleNotes', 'stylePrompt', 'negativePrompt'];
      if (fields.some(key => record[key]?.trim())
        || record.influences?.embrace?.length || record.influences?.avoid?.length
        || Object.values(record.locked || {}).some(Boolean)) return;
      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(record.updatedAt) || 0) + 1)).toISOString();
      const next = { ...record, ...structuredClone(REALITY_STARTER_V1), updatedAt };
      await client.query('UPDATE universes SET data = $2::jsonb, updated_at = $3 WHERE id = $1', ['universe-reality', JSON.stringify(next), updatedAt]);
    });
  },
};
