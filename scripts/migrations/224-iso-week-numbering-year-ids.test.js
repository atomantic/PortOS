import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { legacyWeekId, planDigestRewrite, resolveNewWeekId, toDateHint } from './224-iso-week-numbering-year-ids.js';

const on = (year, month, day) => new Date(year, month - 1, day);
// Local midnight, serialized the way the service stores it. Built from LOCAL
// components (as the service does) so every expectation holds in any timezone —
// a bare `${ymd}T00:00:00.000Z` reads as the PREVIOUS day west of Greenwich.
const localMidnightIso = (ymd) => {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(year, month - 1, day).toISOString();
};
// A digest record with only the fields the migration reads. Values are
// obviously-synthetic, not lifted from any real install.
const digestFixture = (weekId, weekStart, extra = {}) => ({
  weekId,
  generatedAt: localMidnightIso(weekStart),
  weekStart: localMidnightIso(weekStart),
  summary: { totalTasks: 1 },
  ...extra,
});

describe('legacyWeekId', () => {
  it('reproduces the pre-#3465 calendar-year stamping', () => {
    expect(legacyWeekId(on(2025, 12, 29))).toBe('2025-W01');
    expect(legacyWeekId(on(2026, 1, 1))).toBe('2026-W01');
    expect(legacyWeekId(on(2025, 1, 1))).toBe('2025-W01');
  });
});

describe('toDateHint', () => {
  it('reads a bare YYYY-MM-DD as that LOCAL day, not UTC midnight', () => {
    // UTC midnight would read as Dec 28 west of Greenwich and pick the wrong week.
    expect(legacyWeekId(toDateHint('2025-12-29'))).toBe('2025-W01');
  });

  it('returns null for a non-date', () => {
    for (const bad of [null, undefined, '', '   ', 'nope', new Date('nope'), 42]) {
      expect(toDateHint(bad)).toBeNull();
    }
  });
});

describe('resolveNewWeekId', () => {
  it('uses the record date when it reproduces the stored old-form id', () => {
    expect(resolveNewWeekId('2025-W01', '2025-12-29')).toBe('2026-W01');
    expect(resolveNewWeekId('2026-W01', '2026-01-01')).toBe('2026-W01');
    // The collision case: the same old id, a January date — a DIFFERENT week.
    expect(resolveNewWeekId('2025-W01', '2025-01-01')).toBe('2025-W01');
  });

  it('recognizes an id already in the new form so a re-run is a no-op', () => {
    expect(resolveNewWeekId('2026-W01', '2025-12-29')).toBe('2026-W01');
    expect(resolveNewWeekId('2026-W53', '2027-01-01')).toBe('2026-W53');
  });

  it('leaves a mid-year id alone without needing a date at all', () => {
    expect(resolveNewWeekId('2026-W25', null)).toBe('2026-W25');
    expect(resolveNewWeekId('2026-W02', undefined)).toBe('2026-W02');
    expect(resolveNewWeekId('2026-W51', null)).toBe('2026-W51');
  });

  it('refuses to guess an ambiguous boundary id with no usable date', () => {
    expect(resolveNewWeekId('2026-W01', null)).toBeNull();
    expect(resolveNewWeekId('2025-W52', 'not-a-date')).toBeNull();
    expect(resolveNewWeekId('2026-W53', null)).toBeNull();
  });

  it('ignores a date that does not reproduce the stored id', () => {
    // Inconsistent record — fall back to the arithmetic rule, which cannot
    // resolve a W01, so leave it rather than move a digest onto a wrong week.
    expect(resolveNewWeekId('2025-W01', '2026-06-15')).toBeNull();
  });

  it('returns null for an unparseable id', () => {
    expect(resolveNewWeekId('garbage', '2026-01-01')).toBeNull();
  });
});

describe('planDigestRewrite', () => {
  it('renames the boundary digest and rewrites its stored weekId', () => {
    const { writes, deletes, skipped } = planDigestRewrite([
      { file: '2025-W01.json', digest: digestFixture('2025-W01', '2025-12-29') },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0].file).toBe('2026-W01.json');
    expect(writes[0].digest.weekId).toBe('2026-W01');
    expect(deletes).toEqual(['2025-W01.json']);
    expect(skipped).toEqual([]);
  });

  it('recomputes previousWeekId from weekStart so the chain still resolves', () => {
    const { writes } = planDigestRewrite([
      { file: '2025-W01.json', digest: digestFixture('2025-W01', '2025-12-29', { previousWeekId: '2025-W52' }) },
    ]);
    expect(writes[0].digest.previousWeekId).toBe('2025-W52');
  });

  it('leaves a null previousWeekId null', () => {
    const { writes } = planDigestRewrite([
      { file: '2025-W01.json', digest: digestFixture('2025-W01', '2025-12-29', { previousWeekId: null }) },
    ]);
    expect(writes[0].digest.previousWeekId).toBeNull();
  });

  it('plans nothing when every digest already uses the new ids', () => {
    const { writes, deletes, skipped } = planDigestRewrite([
      { file: '2026-W01.json', digest: digestFixture('2026-W01', '2025-12-29') },
      { file: '2026-W25.json', digest: digestFixture('2026-W25', '2026-06-15') },
    ]);
    expect(writes).toEqual([]);
    expect(deletes).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('never deletes a digest it could not resolve', () => {
    const { writes, deletes, skipped } = planDigestRewrite([
      { file: '2025-W52.json', digest: { weekId: '2025-W52' } },
    ]);
    expect(writes).toEqual([]);
    expect(deletes).toEqual([]);
    expect(skipped).toEqual(['2025-W52.json']);
  });

  it('steps previousWeekId back by a CALENDAR week, not 168 hours', () => {
    // Spring-forward week (Mon 2025-03-10 in a DST-observing zone): subtracting
    // 7 * 24h from a local-midnight weekStart lands on Sun 23:00, i.e. 2025-W09
    // — one week too far back.
    const dstWeek = { previousWeekId: '2025-W10' };

    // A correct record must not be rewritten at all.
    expect(planDigestRewrite([
      { file: '2025-W11.json', digest: digestFixture('2025-W11', '2025-03-10', dstWeek) },
    ]).writes).toEqual([]);

    // And when something else does force a rewrite, the value stays put.
    const { writes } = planDigestRewrite([
      { file: '2025-W11.json', digest: digestFixture('2025-W99', '2025-03-10', dstWeek) },
    ]);
    expect(writes[0].digest).toMatchObject({ weekId: '2025-W11', previousWeekId: '2025-W10' });
  });

  it('refuses to rename onto a name held by a digest it could not read', () => {
    const { writes, deletes, skipped } = planDigestRewrite(
      [{ file: '2025-W01.json', digest: digestFixture('2025-W01', '2025-12-29') }],
      ['2026-W01.json'],
    );
    expect(writes).toEqual([]);
    expect(deletes).toEqual([]);
    expect(skipped).toEqual(['2025-W01.json']);
  });

  it("plans a chain where one digest renames onto another digest's current name", () => {
    const { writes, deletes, skipped } = planDigestRewrite([
      { file: '2018-W01.json', digest: digestFixture('2018-W01', '2018-12-31') },
      { file: '2019-W01.json', digest: digestFixture('2019-W01', '2019-12-30') },
    ]);
    expect(writes.map(w => w.file).sort()).toEqual(['2019-W01.json', '2020-W01.json']);
    // 2019-W01.json survives as a rename TARGET, so only the head of the chain goes.
    expect(deletes).toEqual(['2018-W01.json']);
    expect(skipped).toEqual([]);
  });

  it('finishes an interrupted rename by deleting the leftover source copy', () => {
    // A run that wrote the target but died before unlinking the source leaves
    // both files with identical bodies. The re-run must converge, not stall.
    const body = digestFixture('2025-W01', '2025-12-29');
    const { writes, deletes, skipped } = planDigestRewrite([
      { file: '2025-W01.json', digest: body },
      { file: '2026-W01.json', digest: { ...body, weekId: '2026-W01' } },
    ]);
    expect(writes).toEqual([]);
    expect(deletes).toEqual(['2025-W01.json']);
    expect(skipped).toEqual([]);
  });

  it('keeps one winner when two records claim the same new name, dropping neither file', () => {
    const stays = digestFixture('2026-W01', '2025-12-29');
    const moves = digestFixture('2025-W01', '2025-12-30');
    const { writes, deletes, skipped } = planDigestRewrite([
      { file: '2025-W01.json', digest: moves },
      { file: '2026-W01.json', digest: stays },
    ]);
    // The record already sitting at the target name wins; nothing is written
    // over it, and the loser keeps its own file rather than being deleted.
    expect(writes).toEqual([]);
    expect(deletes).toEqual([]);
    expect(skipped).toEqual(['2025-W01.json']);
  });
});

describe('migration 224 up()', () => {
  let rootDir;
  const digestsDir = () => join(rootDir, 'data', 'cos', 'digests');
  const productivityFile = () => join(rootDir, 'data', 'cos', 'productivity.json');
  const readJson = async (path) => JSON.parse(await readFile(path, 'utf-8'));

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-224-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  it('no-ops on a fresh install with no digests and no productivity record', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, renamed: 0 });
  });

  it('renames a boundary digest and removes the old-form file', async () => {
    await mkdir(digestsDir(), { recursive: true });
    await writeFile(join(digestsDir(), '2025-W01.json'), JSON.stringify(digestFixture('2025-W01', '2025-12-29')));

    await migration.up({ rootDir });

    expect(existsSync(join(digestsDir(), '2025-W01.json'))).toBe(false);
    expect(await readJson(join(digestsDir(), '2026-W01.json'))).toMatchObject({ weekId: '2026-W01' });
  });

  it('resolves the overwrite collision from weekStart, keeping the surviving content', async () => {
    // The pre-fix bug: the week of 2025-12-29 and the week of 2025-01-01 both
    // stamped '2025-W01', so only ONE file exists — whichever wrote last.
    await mkdir(digestsDir(), { recursive: true });
    const survivor = digestFixture('2025-W01', '2025-12-29', { summary: { totalTasks: 7 } });
    await writeFile(join(digestsDir(), '2025-W01.json'), JSON.stringify(survivor));

    await migration.up({ rootDir });

    const moved = await readJson(join(digestsDir(), '2026-W01.json'));
    expect(moved.summary.totalTasks).toBe(7);
    expect(moved.weekId).toBe('2026-W01');
  });

  it('leaves a mid-year digest byte-identical', async () => {
    await mkdir(digestsDir(), { recursive: true });
    const path = join(digestsDir(), '2026-W25.json');
    await writeFile(path, JSON.stringify(digestFixture('2026-W25', '2026-06-15')));
    const before = await readFile(path, 'utf-8');

    await migration.up({ rootDir });

    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('does not rename over an unreadable file already sitting at the target name', async () => {
    await mkdir(digestsDir(), { recursive: true });
    await writeFile(join(digestsDir(), '2025-W01.json'), JSON.stringify(digestFixture('2025-W01', '2025-12-29')));
    await writeFile(join(digestsDir(), '2026-W01.json'), 'not json');

    await migration.up({ rootDir });

    expect(await readFile(join(digestsDir(), '2026-W01.json'), 'utf-8')).toBe('not json');
    expect(existsSync(join(digestsDir(), '2025-W01.json'))).toBe(true);
  });

  it('skips an unreadable digest instead of throwing the boot migration run', async () => {
    await mkdir(digestsDir(), { recursive: true });
    await writeFile(join(digestsDir(), '2026-W25.json'), 'not json');

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true });
    expect(existsSync(join(digestsDir(), '2026-W25.json'))).toBe(true);
  });

  it('re-keys streaks.lastActiveWeek using lastActiveDate', async () => {
    await writeFile(productivityFile(), JSON.stringify({
      streaks: { lastActiveDate: '2025-12-29', lastActiveWeek: '2025-W01', currentWeekly: 3, longestWeekly: 3 },
    }));

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ lastActiveWeekChanged: true });

    const after = await readJson(productivityFile());
    expect(after.streaks).toMatchObject({ lastActiveWeek: '2026-W01', currentWeekly: 3 });
  });

  it('leaves an ambiguous lastActiveWeek alone rather than guessing a week', async () => {
    await writeFile(productivityFile(), JSON.stringify({
      streaks: { lastActiveDate: null, lastActiveWeek: '2025-W52' },
    }));

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ lastActiveWeekChanged: false });
    expect((await readJson(productivityFile())).streaks.lastActiveWeek).toBe('2025-W52');
  });

  it('carries a whole rename chain without losing the digest in the middle', async () => {
    // 2018-W01 renames ONTO 2019-W01's current filename, while 2019-W01 itself
    // moves on to 2020-W01. Writing the first straight to its target would
    // destroy the second before its own copy was durable.
    await mkdir(digestsDir(), { recursive: true });
    await writeFile(join(digestsDir(), '2018-W01.json'), JSON.stringify(digestFixture('2018-W01', '2018-12-31', { summary: { totalTasks: 18 } })));
    await writeFile(join(digestsDir(), '2019-W01.json'), JSON.stringify(digestFixture('2019-W01', '2019-12-30', { summary: { totalTasks: 19 } })));

    await migration.up({ rootDir });

    expect((await readdir(digestsDir())).sort()).toEqual(['2019-W01.json', '2020-W01.json']);
    expect(await readJson(join(digestsDir(), '2019-W01.json'))).toMatchObject({ weekId: '2019-W01', summary: { totalTasks: 18 } });
    expect(await readJson(join(digestsDir(), '2020-W01.json'))).toMatchObject({ weekId: '2020-W01', summary: { totalTasks: 19 } });
  });

  it('promotes staged rewrites left by a run that died after staging completed', async () => {
    // Plan file present ⇒ every rewrite was durable, so the leftovers finish.
    await mkdir(digestsDir(), { recursive: true });
    await writeFile(join(digestsDir(), '2026-W01.json.staging-224'), JSON.stringify(digestFixture('2026-W01', '2025-12-29', { summary: { totalTasks: 42 } })));
    await writeFile(join(digestsDir(), '.migration-224-plan'), JSON.stringify({ migration: 224, files: ['2026-W01.json'] }));

    await migration.up({ rootDir });

    expect(await readJson(join(digestsDir(), '2026-W01.json'))).toMatchObject({ summary: { totalTasks: 42 } });
    expect((await readdir(digestsDir())).sort()).toEqual(['2026-W01.json']);
  });

  it('discards staged rewrites from a run that died BEFORE staging completed', async () => {
    // No plan file ⇒ the staged set is partial, so promoting it could overwrite
    // a live digest with half a plan. Drop it and leave the real files alone.
    await mkdir(digestsDir(), { recursive: true });
    await writeFile(join(digestsDir(), '2026-W01.json'), JSON.stringify(digestFixture('2026-W01', '2025-12-29', { summary: { totalTasks: 7 } })));
    await writeFile(join(digestsDir(), '2026-W01.json.staging-224'), JSON.stringify(digestFixture('2026-W01', '2025-12-29', { summary: { totalTasks: 999 } })));

    await migration.up({ rootDir });

    expect(await readJson(join(digestsDir(), '2026-W01.json'))).toMatchObject({ summary: { totalTasks: 7 } });
    expect((await readdir(digestsDir())).sort()).toEqual(['2026-W01.json']);
  });

  it('leaves no staging or plan files behind on a successful run', async () => {
    await mkdir(digestsDir(), { recursive: true });
    await writeFile(join(digestsDir(), '2025-W01.json'), JSON.stringify(digestFixture('2025-W01', '2025-12-29')));

    await migration.up({ rootDir });

    expect((await readdir(digestsDir())).sort()).toEqual(['2026-W01.json']);
  });

  it('is idempotent — a second run changes nothing on disk', async () => {
    await mkdir(digestsDir(), { recursive: true });
    await writeFile(join(digestsDir(), '2025-W01.json'), JSON.stringify(digestFixture('2025-W01', '2025-12-29', { previousWeekId: '2025-W52' })));
    await writeFile(join(digestsDir(), '2026-W25.json'), JSON.stringify(digestFixture('2026-W25', '2026-06-15')));
    await writeFile(productivityFile(), JSON.stringify({
      streaks: { lastActiveDate: '2025-12-29', lastActiveWeek: '2025-W01' },
    }));

    await migration.up({ rootDir });
    const snapshot = async () => {
      const names = (await readdir(digestsDir())).sort();
      const files = await Promise.all(names.map(n => readFile(join(digestsDir(), n), 'utf-8')));
      return { names, files, productivity: await readFile(productivityFile(), 'utf-8') };
    };
    const first = await snapshot();

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ renamed: 0, lastActiveWeekChanged: false });
    expect(await snapshot()).toEqual(first);
  });
});
