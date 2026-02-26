import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs and fileUtils to avoid actual file I/O
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}')
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { meatspace: '/tmp/test-meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined)
}));

import { writeFile } from 'fs/promises';
import { importTSV } from './meatspaceImport.js';

// =============================================================================
// HELPER: Build TSV content
// =============================================================================

function buildTSV({ headerRow1, headerRow2, headerRow3, summaryRow1, summaryRow2, dataRows }) {
  return [headerRow1, headerRow2, headerRow3, summaryRow1, summaryRow2, ...dataRows].join('\n');
}

function makeEmptyHeaders(count) {
  return new Array(count).fill('').join('\t');
}

// Build a minimal TSV with just date and nutrition columns
function buildMinimalTSV(dataRows) {
  // Columns: 0=empty, 1=empty, 2=date, 3=cal, 4=fat, 5=satFat, 6=transFat, 7=polyFat, 8=monoFat, 9=carb, 10=fiber, 11=sugar
  const colCount = 250;
  const row1 = makeEmptyHeaders(colCount);
  const row2 = makeEmptyHeaders(colCount);
  const row3 = makeEmptyHeaders(colCount);
  const sum1 = makeEmptyHeaders(colCount);
  const sum2 = makeEmptyHeaders(colCount);

  const rows = dataRows.map(row => {
    const cells = new Array(colCount).fill('');
    if (row.date) cells[2] = row.date;
    if (row.calories != null) cells[3] = String(row.calories);
    if (row.fat != null) cells[4] = String(row.fat);
    if (row.carbs != null) cells[9] = String(row.carbs);
    if (row.fiber != null) cells[10] = String(row.fiber);
    if (row.sugar != null) cells[11] = String(row.sugar);
    // Body (cols 16-21)
    if (row.weightLbs != null) cells[16] = String(row.weightLbs);
    if (row.weightKg != null) cells[17] = String(row.weightKg);
    return cells.join('\t');
  });

  return buildTSV({
    headerRow1: row1,
    headerRow2: row2,
    headerRow3: row3,
    summaryRow1: sum1,
    summaryRow2: sum2,
    dataRows: rows
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('importTSV', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects files with fewer than 6 lines', async () => {
    const result = await importTSV('line1\nline2\nline3');
    expect(result.error).toMatch(/too short/i);
  });

  it('parses daily entries with nutrition data', async () => {
    const tsv = buildMinimalTSV([
      { date: '2024/01/15', calories: 1500, fat: 65, carbs: 180, fiber: 25, sugar: 40 },
      { date: '2024/01/16', calories: 1800, fat: 70, carbs: 200 }
    ]);

    const result = await importTSV(tsv);
    expect(result.dailyEntries).toBe(2);
    expect(result.dateRange.from).toBe('2024-01-15');
    expect(result.dateRange.to).toBe('2024-01-16');

    // Check that writeFile was called with parsed data
    const dailyLogCall = writeFile.mock.calls.find(c => c[0].includes('daily-log.json'));
    expect(dailyLogCall).toBeTruthy();

    const dailyLog = JSON.parse(dailyLogCall[1]);
    expect(dailyLog.entries).toHaveLength(2);
    expect(dailyLog.entries[0].date).toBe('2024-01-15');
    expect(dailyLog.entries[0].nutrition.calories).toBe(1500);
    expect(dailyLog.entries[0].nutrition.fatG).toBe(65);
    expect(dailyLog.entries[0].nutrition.carbG).toBe(180);
    expect(dailyLog.entries[0].nutrition.fiberG).toBe(25);
    expect(dailyLog.entries[0].nutrition.sugarG).toBe(40);
  });

  it('converts YYYY/MM/DD date format to YYYY-MM-DD', async () => {
    const tsv = buildMinimalTSV([
      { date: '2023/02/04', calories: 1000 }
    ]);

    const result = await importTSV(tsv);
    expect(result.dailyEntries).toBe(1);

    const dailyLogCall = writeFile.mock.calls.find(c => c[0].includes('daily-log.json'));
    const dailyLog = JSON.parse(dailyLogCall[1]);
    expect(dailyLog.entries[0].date).toBe('2023-02-04');
  });

  it('parses body composition data', async () => {
    const tsv = buildMinimalTSV([
      { date: '2024/03/10', weightLbs: 158, weightKg: 71.67 }
    ]);

    const result = await importTSV(tsv);
    expect(result.dailyEntries).toBe(1);

    const dailyLogCall = writeFile.mock.calls.find(c => c[0].includes('daily-log.json'));
    const dailyLog = JSON.parse(dailyLogCall[1]);
    expect(dailyLog.entries[0].body.weightLbs).toBe(158);
    expect(dailyLog.entries[0].body.weightKg).toBe(71.67);
  });

  it('skips rows without valid dates', async () => {
    const tsv = buildMinimalTSV([
      { date: '', calories: 500 },
      { date: 'invalid', calories: 600 },
      { date: '2024/01/01', calories: 700 }
    ]);

    const result = await importTSV(tsv);
    expect(result.dailyEntries).toBe(1);
  });

  it('skips empty data rows', async () => {
    const tsv = buildMinimalTSV([
      { date: '2024/01/01', calories: 700 },
      { date: '2024/01/02' } // No data besides date
    ]);

    const result = await importTSV(tsv);
    expect(result.dailyEntries).toBe(1);
  });

  it('sorts entries by date', async () => {
    const tsv = buildMinimalTSV([
      { date: '2024/03/15', calories: 1500 },
      { date: '2024/01/10', calories: 1200 },
      { date: '2024/02/20', calories: 1800 }
    ]);

    const result = await importTSV(tsv);
    expect(result.dailyEntries).toBe(3);

    const dailyLogCall = writeFile.mock.calls.find(c => c[0].includes('daily-log.json'));
    const dailyLog = JSON.parse(dailyLogCall[1]);
    expect(dailyLog.entries[0].date).toBe('2024-01-10');
    expect(dailyLog.entries[1].date).toBe('2024-02-20');
    expect(dailyLog.entries[2].date).toBe('2024-03-15');
  });

  it('handles dash and empty values as null', async () => {
    const colCount = 250;
    const row1 = makeEmptyHeaders(colCount);
    const row2 = makeEmptyHeaders(colCount);
    const row3 = makeEmptyHeaders(colCount);
    const sum1 = makeEmptyHeaders(colCount);
    const sum2 = makeEmptyHeaders(colCount);

    const cells = new Array(colCount).fill('');
    cells[2] = '2024/01/01';
    cells[3] = '1000'; // calories
    cells[4] = '-';     // fat = dash
    cells[9] = '';       // carbs = empty

    const tsv = [row1, row2, row3, sum1, sum2, cells.join('\t')].join('\n');
    const result = await importTSV(tsv);
    expect(result.dailyEntries).toBe(1);

    const dailyLogCall = writeFile.mock.calls.find(c => c[0].includes('daily-log.json'));
    const dailyLog = JSON.parse(dailyLogCall[1]);
    expect(dailyLog.entries[0].nutrition.calories).toBe(1000);
    expect(dailyLog.entries[0].nutrition.fatG).toBeUndefined();
    expect(dailyLog.entries[0].nutrition.carbG).toBeUndefined();
  });

  it('writes all four output files', async () => {
    const tsv = buildMinimalTSV([
      { date: '2024/01/01', calories: 1000 }
    ]);

    await importTSV(tsv);

    const fileNames = writeFile.mock.calls.map(c => c[0]);
    expect(fileNames.some(f => f.includes('daily-log.json'))).toBe(true);
    expect(fileNames.some(f => f.includes('blood-tests.json'))).toBe(true);
    expect(fileNames.some(f => f.includes('epigenetic-tests.json'))).toBe(true);
    expect(fileNames.some(f => f.includes('eyes.json'))).toBe(true);
  });
});
