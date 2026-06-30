import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  decodeXmlEntities,
  parseAttributes,
  createAppleHealthRecordStream,
} from './appleHealthXmlParser.js';

// Drive the parser the way the import service does: pipe a source readable into
// it, collecting every emitted Record node.
async function parse(input, { chunkSize } = {}) {
  const records = [];
  const parser = createAppleHealthRecordStream({ onRecord: (n) => records.push(n) });
  const buf = Buffer.from(input, 'utf8');
  const source = chunkSize
    ? Readable.from((function* () {
        for (let i = 0; i < buf.length; i += chunkSize) yield buf.subarray(i, i + chunkSize);
      })())
    : Readable.from([buf]);
  await pipeline(source, parser);
  return records;
}

describe('decodeXmlEntities', () => {
  it('returns the input unchanged when there are no entities', () => {
    expect(decodeXmlEntities('plain text')).toBe('plain text');
    expect(decodeXmlEntities('')).toBe('');
  });

  it('decodes the named XML entities', () => {
    expect(decodeXmlEntities('A &amp; B')).toBe('A & B');
    expect(decodeXmlEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeXmlEntities('say &quot;hi&quot;')).toBe('say "hi"');
    expect(decodeXmlEntities('it&apos;s')).toBe("it's");
  });

  it('decodes decimal and hex numeric character references', () => {
    expect(decodeXmlEntities('&#39;')).toBe("'");
    expect(decodeXmlEntities('caf&#233;')).toBe('café');
    expect(decodeXmlEntities('caf&#xe9;')).toBe('café');
  });

  it('leaves unknown entities untouched', () => {
    expect(decodeXmlEntities('&bogus;')).toBe('&bogus;');
  });
});

describe('parseAttributes', () => {
  it('lowercases attribute names but preserves value case', () => {
    const attrs = parseAttributes('<Record Type="HKQuantityTypeIdentifierHeartRate" Value="72">');
    expect(attrs.type).toBe('HKQuantityTypeIdentifierHeartRate');
    expect(attrs.value).toBe('72');
  });

  it('handles single-quoted values and decodes entities', () => {
    const attrs = parseAttributes("<Record sourceName='Adam &amp; Co' unit='count'>");
    expect(attrs.sourcename).toBe('Adam & Co');
    expect(attrs.unit).toBe('count');
  });

  it('returns an empty object for an attribute-less tag', () => {
    expect(parseAttributes('<Record>')).toEqual({});
  });
});

describe('createAppleHealthRecordStream', () => {
  const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT Record (MetadataEntry)*>
<!ATTLIST Record type CDATA #REQUIRED>
]>
<HealthData locale="en_US">
 <ExportDate value="2024-01-15 08:30:00 -0800"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="1200" startDate="2024-01-15 08:00:00 -0800" endDate="2024-01-15 08:30:00 -0800"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" value="72" startDate="2024-01-15 09:00:00 -0800">
  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="1"/>
 </Record>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning"/>
</HealthData>`;

  it('emits one node per Record opening tag with lowercased attribute names', async () => {
    const records = await parse(SAMPLE);
    expect(records).toHaveLength(2);
    expect(records[0].name).toBe('record');
    expect(records[0].attributes.type).toBe('HKQuantityTypeIdentifierStepCount');
    expect(records[0].attributes.value).toBe('1200');
    expect(records[1].attributes.type).toBe('HKQuantityTypeIdentifierHeartRate');
    expect(records[1].attributes.startdate).toBe('2024-01-15 09:00:00 -0800');
  });

  it('skips DTD declarations and non-Record elements', async () => {
    const records = await parse(SAMPLE);
    // Neither <!ATTLIST Record ...> / <!ELEMENT Record ...> nor <Workout> nor
    // <MetadataEntry> should be reported as a Record.
    expect(records.every((r) => r.attributes.type?.startsWith('HKQuantity'))).toBe(true);
  });

  it('reassembles records split across chunk boundaries (1-byte chunks)', async () => {
    const records = await parse(SAMPLE, { chunkSize: 1 });
    expect(records).toHaveLength(2);
    expect(records[0].attributes.value).toBe('1200');
    expect(records[1].attributes.value).toBe('72');
  });

  it('is robust to small chunk sizes that split UTF-8 multibyte values', async () => {
    const xml = '<HealthData><Record type="t" sourceName="café" startDate="x"/></HealthData>';
    const records = await parse(xml, { chunkSize: 3 });
    expect(records).toHaveLength(1);
    expect(records[0].attributes.sourcename).toBe('café');
  });

  it('does not treat a `>` inside an attribute value as the tag end', async () => {
    const xml = '<HealthData><Record type="a>b" value="1" startDate="x"/></HealthData>';
    const records = await parse(xml);
    expect(records).toHaveLength(1);
    expect(records[0].attributes.type).toBe('a>b');
    expect(records[0].attributes.value).toBe('1');
  });

  it('does not match a longer element name that merely starts with Record', async () => {
    const xml = '<HealthData><RecordingDevice id="1"/><Record type="t" startDate="x"/></HealthData>';
    const records = await parse(xml);
    expect(records).toHaveLength(1);
    expect(records[0].attributes.type).toBe('t');
  });

  it('does not match a longer element even when it trails at a chunk boundary', async () => {
    // <RecordingDevice ...> arriving in tiny chunks must not be retained or
    // mistaken for a Record; only the real <Record> is reported.
    const xml = '<HealthData><Record type="t" startDate="x"/><RecordingDevice id="9"/></HealthData>';
    const records = await parse(xml, { chunkSize: 2 });
    expect(records).toHaveLength(1);
    expect(records[0].attributes.type).toBe('t');
  });

  it('decodes entities in attribute values', async () => {
    const xml = '<HealthData><Record type="t" sourceName="A &amp; B" startDate="x"/></HealthData>';
    const records = await parse(xml);
    expect(records[0].attributes.sourcename).toBe('A & B');
  });

  it('handles an empty stream without emitting anything', async () => {
    expect(await parse('')).toEqual([]);
  });
});
