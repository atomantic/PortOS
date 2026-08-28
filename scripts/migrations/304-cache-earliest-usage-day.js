/**
 * Cache the first recorded usage day so all-time usage queries do not rescan
 * every retained daily and monthly activity key on each request.
 */

import { readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

const findEarliestActivityDay = (usage) => {
  const days = [
    ...Object.keys(usage.dailyActivity || {}).filter((key) => DAY_KEY_RE.test(key)),
    ...Object.keys(usage.monthlyActivity || {})
      .filter((key) => MONTH_KEY_RE.test(key))
      .map((key) => `${key}-01`)
  ];
  return days.reduce((earliest, day) => (!earliest || day < earliest ? day : earliest), null);
};

export async function up({ rootDir }) {
  const usagePath = join(rootDir, 'data', 'usage.json');
  const raw = await readFile(usagePath, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return;

  const usage = JSON.parse(raw);
  const earliestActivityDay = findEarliestActivityDay(usage);
  if (usage.earliestActivityDay === earliestActivityDay) return;

  usage.earliestActivityDay = earliestActivityDay;
  const tempPath = `${usagePath}.304.tmp`;
  await writeFile(tempPath, `${JSON.stringify(usage, null, 2)}\n`);
  await rename(tempPath, usagePath);
  console.log('📊 Migration 304: cached earliest usage activity day');
}

export default { up };
