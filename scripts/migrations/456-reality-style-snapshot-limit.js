/** Bring Reality's assembled style under the concept snapshot limit (#15151). */
import { withTransaction } from '../../server/lib/db.js';
import { toPgJson } from '../../server/lib/pgJson.js';
import { assembleUniverseStyleText, STYLE_SNAPSHOT_MAX } from '../../server/lib/universeVisualStyle.js';

export default {
  async up() {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT data, deleted FROM universes WHERE id = $1 FOR UPDATE', ['universe-reality']);
      const row = rows[0];
      const record = row?.data;
      if (!record || row.deleted || record.deleted || record.name !== 'Reality') return;
      const currentLength = assembleUniverseStyleText(record).length;
      if (currentLength <= STYLE_SNAPSHOT_MAX) return;

      let nextStyleNotes = record.styleNotes || '';
      if (nextStyleNotes.includes('Analog images should resemble actual film capture, without decorative borders, fake scratches or light-leak overlays.')) {
        nextStyleNotes = nextStyleNotes.replace(
          'without decorative borders, fake scratches or light-leak overlays.',
          'without decorative borders or light-leak overlays.',
        );
      }
      if (nextStyleNotes.includes('Do not impose a permanent gloomy palette, flattering beauty key or polished cinematic rim light.')) {
        nextStyleNotes = nextStyleNotes.replace(
          'Do not impose a permanent gloomy palette, flattering beauty key or polished cinematic rim light.',
          'Do not impose a permanent gloomy palette or polished rim light.',
        );
      }
      const excess = assembleUniverseStyleText({ ...record, styleNotes: nextStyleNotes }).length - STYLE_SNAPSHOT_MAX;
      if (excess > 0 && nextStyleNotes.length > excess) {
        nextStyleNotes = nextStyleNotes.slice(0, nextStyleNotes.length - excess).trim();
      }

      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(record.updatedAt) || 0) + 1)).toISOString();
      const next = { ...record, styleNotes: nextStyleNotes, updatedAt };
      await client.query('UPDATE universes SET data = $2::jsonb, updated_at = $3 WHERE id = $1', [record.id, toPgJson(next), updatedAt]);
    });
  },
};
