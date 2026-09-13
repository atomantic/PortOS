/**
 * Per-record retired-model-pin source (#7326) — the collector's contract with
 * the audit: which stored pins it surfaces, which it must NOT, and that a clear
 * touches only the model field.
 *
 * `lib/db.js` is mocked so the query text and the rows it returns are both
 * observable, which is what lets the mode gate and the "don't read whole
 * tables" rule be asserted at all. The SQL is exercised against real Postgres
 * in modelPinRecords.db.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({ query: vi.fn(), isTestDatabase: () => true }));
vi.mock('./universeBuilder/crud.js', () => ({ updateUniverse: vi.fn() }));
vi.mock('./pipeline/series.js', () => ({ updateSeries: vi.fn() }));
vi.mock('./sprites/records.js', () => ({ updateRecord: vi.fn() }));
vi.mock('./decks.js', () => ({ updateDeck: vi.fn() }));
vi.mock('./musicVideo/projects.js', () => ({ updateProject: vi.fn() }));

const { query } = await import('../lib/db.js');
const { updateUniverse } = await import('./universeBuilder/crud.js');
const { updateSeries } = await import('./pipeline/series.js');
const { updateRecord } = await import('./sprites/records.js');
const { updateDeck } = await import('./decks.js');
const { updateProject } = await import('./musicVideo/projects.js');
const {
  RECORD_PIN_FAMILIES, clearRecordPin, collectRecordPins, pinnedRowsSql,
} = await import('./modelPinRecords.js');

const familyOf = (name) => RECORD_PIN_FAMILIES.find((entry) => entry.family === name);

// Answer one family's scan with `rows`; every other family scans empty.
const rowsFor = (family, rows) => {
  query.mockImplementation(async (sql) => (
    sql.includes(` FROM ${familyOf(family).table}\n`) ? { rows } : { rows: [] }
  ));
};

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
});

describe('collectRecordPins', () => {
  it('surfaces a stored pin with its mode, its model, and a deep link to the record', async () => {
    rowsFor('universe', [{ id: 'u-1', name: 'Neon Dusk', image_mode: 'agy', image_model_id: 'gemini-3.5-flash-low' }]);

    expect(await collectRecordPins()).toEqual([{
      id: 'record:universe:u-1',
      family: 'universe',
      recordId: 'u-1',
      mode: 'agy',
      model: 'gemini-3.5-flash-low',
      label: 'Neon Dusk · universe render model',
      location: 'Universes → Render',
      href: '/universes/u-1?tab=render',
    }]);
  });

  it('reports the mode unjudged, so the audit can apply its one gate', async () => {
    // A LOCAL pin names a diffusion checkpoint, not a CLI model, and 'auto'/absent
    // names no backend at all — modelPinAudit drops all three through
    // pinnedModeProviderId. This source must therefore SAY which mode it found
    // rather than silently keeping or discarding the row.
    rowsFor('series', [
      { id: 's-1', name: 'Local', image_mode: 'local', image_model_id: 'sdxl-base' },
      { id: 's-2', name: 'Auto', image_mode: 'auto', image_model_id: 'gpt-5-codex' },
      { id: 's-3', name: 'No mode', image_mode: null, image_model_id: 'gpt-5-codex' },
    ]);

    expect((await collectRecordPins()).map((pin) => pin.mode)).toEqual(['local', null, null]);
  });

  it('treats a blank or auto model id as no pin at all', async () => {
    rowsFor('sprite', [
      { id: 'sp-1', name: 'Blank', image_mode: 'codex', image_model_id: '   ' },
      { id: 'sp-2', name: 'Sentinel', image_mode: 'codex', image_model_id: 'auto' },
    ]);

    expect(await collectRecordPins()).toEqual([]);
  });

  it('falls back to the record id when the row carries no usable name', async () => {
    rowsFor('musicVideo', [{ id: 'mv-1', name: '  ', image_mode: 'codex', image_model_id: 'gpt-5-codex' }]);

    const [pin] = await collectRecordPins();
    expect(pin.label).toBe('mv-1 · music video render model');
    expect(pin.href).toBe('/music-video/mv-1');
  });

  it('keeps scanning the other families when one table fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql) => {
      if (sql.includes(' FROM universes\n')) throw new Error('relation does not exist');
      if (sql.includes(' FROM decks\n')) return { rows: [{ id: 'd-9', name: 'Playing', image_mode: 'codex', image_model_id: 'gpt-5-codex' }] };
      return { rows: [] };
    });

    expect(await collectRecordPins()).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('universes'));
    logged.mockRestore();
  });

  it('scans every family exactly once per audit', async () => {
    await collectRecordPins();
    expect(query).toHaveBeenCalledTimes(RECORD_PIN_FAMILIES.length);
  });
});

describe('pinnedRowsSql', () => {
  // The audit is derive-on-read: it must not hydrate every record in a table to
  // answer one request. Each family's query filters IN THE DATABASE and projects
  // four scalars — never the record document.
  it.each(RECORD_PIN_FAMILIES)('filters $family to pinned, live rows without selecting the document', (family) => {
    const sql = pinnedRowsSql(family);
    expect(sql).toContain(`${family.json} ->> 'imageModelId' IS NOT NULL`);
    expect(sql).toContain('deleted = FALSE');
    expect(sql).not.toMatch(new RegExp(`SELECT[^;]*\\b${family.json}\\b\\s*(,|\\n\\s*FROM)`));
    expect(sql).not.toContain('SELECT *');
  });
});

describe('clearRecordPin', () => {
  // The sibling `imageMode` is a separate choice the user did not ask to undo —
  // every family's clear sends the model key ALONE.
  it.each([
    ['universe', () => updateUniverse],
    ['series', () => updateSeries],
    ['sprite', () => updateRecord],
    ['deck', () => updateDeck],
    ['musicVideo', () => updateProject],
  ])('clears only the model field of a %s record', async (family, update) => {
    await clearRecordPin({ family, recordId: 'r-1' });
    expect(update()).toHaveBeenCalledWith('r-1', { imageModelId: null });
  });

  it('rejects a pin naming a family that does not exist', async () => {
    await expect(clearRecordPin({ family: 'nope', recordId: 'r-1' })).rejects.toThrow(/Unknown record pin family/);
  });
});
