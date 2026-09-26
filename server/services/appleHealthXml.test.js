/**
 * Temp-file / read-stream lifecycle contract for the Apple Health XML import.
 *
 * An `export.xml` is routinely 0.5-3GB and the route has already unlinked the
 * uploaded ZIP by the time the import runs, so `importAppleHealthXml` is the
 * last owner of that file: it must remove it and release its fd on EVERY exit,
 * not just the success path (issue #5654).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'stream';
import { mkdtemp, writeFile, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Keep the import off the real health day-file store; `writeDayFile` doubles as
// the injection point for a failing flush.
const store = vi.hoisted(() => ({ writeDayFile: null }));
vi.mock('./appleHealthIngest.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readDayFile: vi.fn(async (date) => ({ date, metrics: {} })),
    writeDayFile: vi.fn((...args) => store.writeDayFile(...args)),
  };
});

// Capture the read streams the service opens, and trace stream-close vs unlink
// order: unlink alone succeeds on POSIX with the fd still open, so only the
// ordering proves the fd was released first (it is what Windows requires).
const streams = [];
const trace = vi.hoisted(() => []);
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createReadStream: (...args) => {
      const s = actual.createReadStream(...args);
      s.on('close', () => trace.push('close'));
      streams.push(s);
      return s;
    },
  };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual,
    unlink: async (...args) => {
      trace.push('unlink');
      return actual.unlink(...args);
    },
  };
});

// Swap in a parser that fails on its first write, to reject while the source
// stream is still mid-file (the state a real parser/stream error leaves behind).
const parser = vi.hoisted(() => ({ impl: null }));
vi.mock('./appleHealthXmlParser.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAppleHealthRecordStream: (opts) =>
      (parser.impl ? parser.impl(opts) : actual.createAppleHealthRecordStream(opts)),
  };
});

const { importAppleHealthXml } = await import('./appleHealthXml.js');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2025-01-15 08:00:00 -0800" endDate="2025-01-15 08:05:00 -0800" value="120"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2025-01-15 08:01:00 -0800" endDate="2025-01-15 08:01:00 -0800" value="72"/>
</HealthData>`;

const exists = (p) => access(p).then(() => true, () => false);

describe('importAppleHealthXml temp-file lifecycle', () => {
  let dir;
  let xmlPath;

  beforeEach(async () => {
    streams.length = 0;
    trace.length = 0;
    parser.impl = null;
    store.writeDayFile = async () => {};
    dir = await mkdtemp(join(tmpdir(), 'portos-ahxml-fixture-'));
    xmlPath = join(dir, 'export.xml');
    await writeFile(xmlPath, XML, 'utf-8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the input file and releases its fd after a successful import', async () => {
    const result = await importAppleHealthXml(xmlPath, null);

    expect(result).toEqual({ days: 1, records: 2 });
    expect(await exists(xmlPath)).toBe(false);
    expect(streams).toHaveLength(1);
    expect(streams[0].destroyed).toBe(true);
    expect(trace).toEqual(['close', 'unlink']);
  });

  it('removes the input file and releases its fd when the flush rejects', async () => {
    store.writeDayFile = async () => { throw new Error('disk full'); };

    await expect(importAppleHealthXml(xmlPath, null)).rejects.toThrow('disk full');

    // Without the try/finally the multi-GB file and the open fd both survived
    // the rejection for the life of the process.
    expect(await exists(xmlPath)).toBe(false);
    expect(streams).toHaveLength(1);
    expect(streams[0].destroyed).toBe(true);
    // Order matters: destroy() releases the fd asynchronously, so unlinking
    // before 'close' would fail on Windows and silently leak the file.
    expect(trace).toEqual(['close', 'unlink']);
  });

  it('removes the input file when the parse fails with the source mid-file', async () => {
    // Pad past the read stream's high-water mark so the source is still open
    // (not at EOF) when the parser errors — .pipe() unpipes but never destroys
    // it, which is how the fd used to stay held for the life of the process.
    await writeFile(xmlPath, `${XML}\n<!--${'x'.repeat(1024 * 1024)}-->`, 'utf-8');
    parser.impl = () => new Writable({ write(_chunk, _enc, cb) { cb(new Error('parser exploded')); } });

    await expect(importAppleHealthXml(xmlPath, null)).rejects.toThrow('parser exploded');

    expect(await exists(xmlPath)).toBe(false);
    expect(streams[0].destroyed).toBe(true);
    expect(trace).toEqual(['close', 'unlink']);
  });
});

describe('importAppleHealthXml upsert behavior', () => {
  let dir;
  let xmlPath;
  let readCalls;
  let writeCalls;

  beforeEach(async () => {
    streams.length = 0;
    trace.length = 0;
    parser.impl = null;
    readCalls = [];
    writeCalls = [];

    // Track calls to readDayFile and writeDayFile
    store.writeDayFile = async (dateStr, data) => {
      writeCalls.push({ dateStr, data: JSON.parse(JSON.stringify(data)) });
    };

    dir = await mkdtemp(join(tmpdir(), 'portos-ahxml-upsert-'));
    xmlPath = join(dir, 'export.xml');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('updates step count when re-importing with a higher total', async () => {
    const XML_PARTIAL = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2025-01-15 08:00:00 -0800" endDate="2025-01-15 08:05:00 -0800" value="100"/>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2025-01-15 08:10:00 -0800" endDate="2025-01-15 08:15:00 -0800" value="50"/>
</HealthData>`;

    await writeFile(xmlPath, XML_PARTIAL, 'utf-8');
    await importAppleHealthXml(xmlPath, null);

    // Should have written one day with aggregated step count
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].dateStr).toBe('2025-01-15');
    // The aggregation should sum to 150
    expect(writeCalls[0].data.metrics.step_count[0].qty).toBe(150);
  });

  it('updates day with aggregated sleep analysis from re-import', async () => {
    const XML_SLEEP = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="iPhone" value="HKCategoryValueSleepAnalysisAsleep" startDate="2025-01-14 23:00:00 -0800" endDate="2025-01-15 07:00:00 -0800"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="iPhone" value="HKCategoryValueSleepAnalysisAwake" startDate="2025-01-15 07:00:00 -0800" endDate="2025-01-15 07:10:00 -0800"/>
</HealthData>`;

    await writeFile(xmlPath, XML_SLEEP, 'utf-8');
    await importAppleHealthXml(xmlPath, null);

    // Should have written two days with sleep analysis
    expect(writeCalls).toHaveLength(2);
    // Check that sleep_analysis was aggregated
    const day15 = writeCalls.find(c => c.dateStr === '2025-01-15');
    expect(day15.data.metrics.sleep_analysis).toBeDefined();
  });
});
