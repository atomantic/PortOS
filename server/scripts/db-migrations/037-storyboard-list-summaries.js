import { toPgJson } from '../../lib/pgJson.js';
import { sanitizeStoryboard, summarizeStoryboard } from '../../lib/storyboardRecord.js';

export async function up(client) {
  // Derive from the same sanitizer and summary used by the old list. Keep the
  // source record and LWW clocks intact, and only load a batch at a time.
  let after = null;
  while (true) {
    const { rows } = await client.query(`SELECT id, data FROM storyboards
      WHERE list_summary IS NULL AND ($1::text IS NULL OR id > $1) ORDER BY id LIMIT 100 FOR UPDATE`, [after]);
    if (!rows.length) break;
    for (const { id, data } of rows) {
      const board = sanitizeStoryboard(data);
      await client.query('UPDATE storyboards SET list_summary = $2::jsonb WHERE id = $1',
        [id, toPgJson(board && summarizeStoryboard(board))]);
    }
    after = rows.at(-1).id;
  }
}
