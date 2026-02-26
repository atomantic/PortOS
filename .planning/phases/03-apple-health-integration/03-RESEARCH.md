# Phase 3: Apple Health Integration - Research

**Researched:** 2026-02-26
**Domain:** Health data ingestion, streaming XML parsing, time-series dashboard
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Import workflow:**
- Two ingest paths: Health Auto Export REST push to `/api/health/ingest` AND manual file upload in the Import tab
- Bulk XML import via file picker in the existing Import tab (replace the disabled placeholder)
- XML import progress shown as progress bar with percentage + live record counts, updated via WebSocket
- Duplicate handling: silent dedup by metric type + timestamp — no user notification unless error

**Health metric scope:**
- Import ALL Apple Health metric types into day-partitioned storage (not just core four)
- Dashboard cards built for core four only: steps, heart rate, sleep analysis, HRV
- All other metrics stored for future use (Phase 4 correlations, future dashboard expansion)
- Apple Health nutrition data REPLACES existing daily-log nutrition for overlapping days (overwrite silently, no backup)
- One file per day with all metrics: `data/health/YYYY-MM-DD.json`

**Dashboard cards:**
- New "Health" tab added to MeatSpace (alongside Overview, Alcohol, Blood & Body, Genome, Lifestyle)
- Default time range: last 7 days
- Range selector buttons: 7d / 30d / 90d / 1y — consistent across all health cards
- Card layout: hero number (current/average value) at top, line chart trend below
- Sleep card: total hours as hero number, stacked horizontal bar showing deep/REM/light/awake stage proportions, time-in-bed vs actual sleep

**Health correlations:**
- Correlations section at the bottom of the new Health tab
- Alcohol vs HRV: dual-axis overlay chart (HRV left axis, alcohol grams right axis, same time range)
- Activity vs blood work: 30-day rolling average steps/activity leading up to each blood test date, plotted alongside key blood markers
- Each correlation chart includes an auto-generated text summary below (e.g., "HRV averages 42ms on drinking days vs 58ms on sober days (-28%)") — computed from data, no LLM
- Minimum data threshold: 14+ days before showing correlations. Show message: "Need 14+ days of data for correlations — X days so far."

### Claude's Discretion
- Chart library choice and styling details
- Exact JSON schema for day-partitioned health files
- SAX parser implementation details for XML streaming
- Health Auto Export JSON validation schema specifics
- Card grid layout and responsive breakpoints
- Color palette for chart lines and sleep stage bars
- How to handle Apple Health records with no date or invalid timestamps

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| HLT-01 | POST `/api/health/ingest` accepts Health Auto Export JSON, validates with Zod, deduplicates by metric+timestamp | Health Auto Export JSON schema documented below; Zod patterns from existing project; dedup logic is in-memory before write |
| HLT-02 | Health data persists to day-partitioned `data/health/YYYY-MM-DD.json` files | Day-partition file layout documented; PATHS.health constant needs adding to fileUtils.js |
| HLT-03 | Bulk XML import streams Apple Health export (500MB+) without OOM via SAX parser | `sax` npm package streaming API verified; multer diskStorage → sax stream pipeline documented |
| HLT-04 | XML import reports progress via WebSocket during processing | Socket.io `io.emit` pattern confirmed from backup.js; `req.app.get('io')` is the access pattern |
| HLT-05 | MeatSpace dashboard cards for steps, heart rate, sleep, HRV trends | `recharts` v3 already installed; LineChart, ComposedChart (dual-axis), stacked BarChart all confirmed |
| HLT-06 | Correlate Apple Health data with existing MeatSpace data (alcohol vs HRV, activity vs blood work) | `getDailyAlcohol()` and blood test services exist; correlation math is pure JS; recharts ComposedChart dual-axis confirmed |
</phase_requirements>

---

## Summary

Phase 3 requires three distinct subsystems: (1) an ingest API for Health Auto Export JSON push, (2) a streaming SAX XML importer for bulk Apple Health exports, and (3) a Health tab on the MeatSpace dashboard with trend charts and correlation views.

The technical stack is well-matched to existing PortOS patterns. The `sax` npm package (v1.4.4, actively maintained) provides Node.js streaming XML parsing via `createStream()` and is the correct tool for 500MB+ files — multer diskStorage saves the upload to a temp file, which is then piped to the SAX stream without loading the file into memory. Health Auto Export pushes JSON with a documented schema (`data.metrics[]` array), and Zod validation follows the established project pattern. WebSocket progress events follow the exact same pattern as `backup.js` (`req.app.get('io')`, `io.emit(event, payload)`). `recharts` v3 is already installed in the client and supports all required chart types.

The key unknowns are: (a) the exact metric `name` strings used in Health Auto Export JSON v7 for steps/HRV (confirmed: `step_count`, `heart_rate`, `heart_rate_variability_sdnn`, `sleep_analysis` — but app version naming may vary), and (b) Apple Health XML `type` attribute values for the four core metrics (confirmed: `HKQuantityTypeIdentifierStepCount`, `HKQuantityTypeIdentifierHeartRate`, `HKQuantityTypeIdentifierHeartRateVariabilitySDNN`, `HKCategoryTypeIdentifierSleepAnalysis`). Sleep XML records have text values (`HKCategoryValueSleepAnalysisAsleepREM` etc.) not numeric, requiring separate handling.

**Primary recommendation:** Use `sax` npm for XML streaming, `multer` with diskStorage for file upload, `recharts` ComposedChart for dual-axis correlation charts, and follow the backup.js pattern for WebSocket progress.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `sax` | 1.4.4 | Streaming SAX XML parser | 1896 dependents, actively maintained (published ~1 month ago), the de-facto Node.js SAX parser; supports `createStream()` for pipe-based parsing |
| `multer` | latest | Multipart file upload middleware | Standard Express file upload; diskStorage keeps 500MB files off heap |
| `recharts` | 3.7.0 | Chart rendering | **Already installed** in client; supports LineChart, ComposedChart, stacked BarChart |
| `zod` | 3.24.1 | Input validation | **Already installed** in server; all routes use it |
| `socket.io` | 4.8.3 | WebSocket progress events | **Already installed** and wired; `io.emit` pattern confirmed |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `fs` (Node built-in) | — | `createReadStream` for pipe to SAX | Pipe temp file into SAX parser |
| `fs/promises` | — | Day-partition file read/write | Read existing day file, merge, write back |
| `path` | — | `join(PATHS.health, dateStr + '.json')` | Build file paths |
| `os.tmpdir()` | — | Temp dir for multer diskStorage | Safe temp location for XML upload |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `sax` | `saxes` | saxes is faster but last published 4 years ago; sax is actively maintained |
| `sax` | `fast-xml-parser` | fast-xml-parser loads DOM; not suitable for 500MB streaming |
| `multer diskStorage` | `multer memoryStorage` | memoryStorage would load 500MB into RAM — causes OOM |
| `recharts` | `chart.js` | recharts is already installed; no reason to add chart.js |

**Installation (new packages only):**
```bash
# In server/
npm install sax multer
```

---

## Architecture Patterns

### Recommended Project Structure

New files following PortOS conventions:

```
server/
├── routes/
│   └── appleHealth.js          # POST /api/health/ingest, POST /api/health/import/xml
├── services/
│   ├── appleHealthIngest.js    # JSON ingest: parse, dedup, write day files
│   ├── appleHealthXml.js       # SAX XML streaming: parse export.xml, write day files
│   └── appleHealthQuery.js     # Read day-partitioned files for dashboard queries
├── lib/
│   └── appleHealthValidation.js # Zod schemas for ingest payload

client/src/components/meatspace/
├── tabs/
│   └── HealthTab.jsx           # New Health tab (steps, HR, sleep, HRV cards + correlations)
├── AppleHealthImport.jsx       # XML upload UI with WebSocket progress bar
├── StepsCard.jsx               # Steps trend (LineChart)
├── HeartRateCard.jsx           # Heart rate trend (LineChart avg/min/max)
├── SleepCard.jsx               # Sleep stacked bar + total hours
├── HrvCard.jsx                 # HRV trend (LineChart)
├── AlcoholHrvCorrelation.jsx   # Dual-axis ComposedChart
└── ActivityBloodCorrelation.jsx # Steps + blood markers ComposedChart
```

### Pattern 1: SAX Streaming XML Import

**What:** Pipe uploaded file through SAX parser event-by-event; accumulate records in memory one batch at a time; write day files; emit progress every N records via WebSocket.
**When to use:** Any import of Apple Health XML export (potentially 500MB+)

```javascript
// Source: sax npm docs (https://github.com/isaacs/sax-js)
import sax from 'sax';
import { createReadStream, unlink } from 'fs';
import { writeFile, readFile } from 'fs/promises';

export async function importAppleHealthXml(filePath, io = null) {
  const saxStream = sax.createStream(false, { lowercase: true });

  let totalRecords = 0;
  let processedRecords = 0;
  const dayBuckets = {}; // { 'YYYY-MM-DD': { metrics: { type: [...] } } }

  saxStream.on('opentag', (node) => {
    // node.name is 'record' (lowercase because lowercase: true)
    // node.attributes has: type, value, startdate, enddate, unit, sourcename
    if (node.name !== 'record') return;

    const { type, value, startdate, unit } = node.attributes;
    if (!startdate) return;

    const dateStr = startdate.split(' ')[0]; // 'YYYY-MM-DD HH:mm:ss +0000' -> 'YYYY-MM-DD'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;

    if (!dayBuckets[dateStr]) dayBuckets[dateStr] = { metrics: {} };
    if (!dayBuckets[dateStr].metrics[type]) dayBuckets[dateStr].metrics[type] = [];

    dayBuckets[dateStr].metrics[type].push({
      ts: startdate,
      end: node.attributes.enddate ?? null,
      val: value,
      unit: unit ?? null,
      src: node.attributes.sourcename ?? null
    });

    processedRecords++;
    if (processedRecords % 10000 === 0 && io) {
      io.emit('health:xml:progress', { processed: processedRecords });
      console.log(`🍎 XML import progress: ${processedRecords} records`);
    }
  });

  saxStream.on('error', function (e) {
    // Clear error and resume — Apple Health XML sometimes has minor malformations
    console.error(`❌ XML parse error at record ${processedRecords}: ${e.message}`);
    this._parser.error = null;
    this._parser.resume();
  });

  await new Promise((resolve, reject) => {
    saxStream.on('end', resolve);
    saxStream.on('error', reject); // Only catastrophic errors reach here
    createReadStream(filePath).pipe(saxStream);
  });

  // Write day files
  const days = Object.keys(dayBuckets);
  for (const dateStr of days) {
    await writeDayFile(dateStr, dayBuckets[dateStr]);
  }

  // Cleanup temp file
  unlink(filePath, () => {});

  if (io) io.emit('health:xml:complete', { days: days.length, records: processedRecords });
  console.log(`🍎 XML import complete: ${processedRecords} records across ${days.length} days`);
  return { days: days.length, records: processedRecords };
}
```

### Pattern 2: multer diskStorage Upload (500MB-safe)

**What:** Store uploaded file to temp dir on disk (not memory), return path to route handler.
**When to use:** XML file upload endpoint.

```javascript
// Source: multer docs (https://www.npmjs.com/package/multer)
import multer from 'multer';
import { tmpdir } from 'os';
import { join } from 'path';

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpdir()),
    filename: (req, file, cb) => cb(null, `apple-health-${Date.now()}.xml`)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB max
});

// In route:
router.post('/import/xml', upload.single('file'), asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const filePath = req.file?.path;
  if (!filePath) throw new ServerError('No file uploaded', 400);

  const result = await importAppleHealthXml(filePath, io);
  res.json(result);
}));
```

### Pattern 3: Health Auto Export JSON Ingest with Zod + Dedup

**What:** Accept POST body with `data.metrics[]` array; validate with Zod; dedup by metric_name+timestamp; write to day files.

Health Auto Export JSON schema (confirmed from official wiki):
```json
{
  "data": {
    "metrics": [
      {
        "name": "step_count",
        "units": "count",
        "data": [{ "qty": 8432, "date": "2024-01-15 08:30:00 -0800" }]
      },
      {
        "name": "heart_rate",
        "units": "bpm",
        "data": [{ "date": "2024-01-15 08:30:00 -0800", "Min": 68, "Avg": 72, "Max": 85 }]
      },
      {
        "name": "sleep_analysis",
        "units": "hr",
        "data": [{ "date": "2024-01-15", "totalSleep": 7.2, "deep": 1.1, "rem": 1.8, "core": 4.1, "awake": 0.2 }]
      },
      {
        "name": "heart_rate_variability_sdnn",
        "units": "ms",
        "data": [{ "qty": 42.3, "date": "2024-01-15 06:00:00 -0800" }]
      }
    ]
  }
}
```

Zod schema pattern (following `lib/meatspaceValidation.js` style):
```javascript
// Source: project pattern from server/lib/meatspaceValidation.js
import { z } from 'zod';

const healthDataPointSchema = z.object({
  date: z.string(),
  qty: z.number().optional(),
  Min: z.number().optional(),
  Avg: z.number().optional(),
  Max: z.number().optional(),
  totalSleep: z.number().optional(),
  deep: z.number().optional(),
  rem: z.number().optional(),
  core: z.number().optional(),
  awake: z.number().optional(),
  hrv: z.number().optional()
}).passthrough(); // Allow additional fields from future app versions

const healthMetricSchema = z.object({
  name: z.string().min(1),
  units: z.string().optional(),
  data: z.array(healthDataPointSchema)
});

export const healthIngestSchema = z.object({
  data: z.object({
    metrics: z.array(healthMetricSchema).default([]),
    workouts: z.array(z.unknown()).default([])
  }).passthrough()
});
```

Deduplication pattern:
```javascript
// Dedup key: metricName + date string (normalize to YYYY-MM-DD HH:mm:ss)
function dedupKey(metricName, dataPoint) {
  return `${metricName}::${dataPoint.date}`;
}

// On write: load existing day file, merge new records, skip duplicates
async function mergeIntoDay(dateStr, metricName, newPoints) {
  const existing = await readDayFile(dateStr);
  const existingKeys = new Set(
    (existing.metrics?.[metricName] ?? []).map(p => p.date)
  );
  const unique = newPoints.filter(p => !existingKeys.has(p.date));
  existing.metrics ??= {};
  existing.metrics[metricName] ??= [];
  existing.metrics[metricName].push(...unique);
  await writeDayFile(dateStr, existing);
  return unique.length;
}
```

### Pattern 4: Day-Partitioned File Schema

**What:** One JSON file per day at `data/health/YYYY-MM-DD.json`. All metric types for that day stored together.

```json
{
  "date": "2024-01-15",
  "metrics": {
    "step_count": [
      { "date": "2024-01-15 08:30:00 -0800", "qty": 4211, "unit": "count" },
      { "date": "2024-01-15 18:00:00 -0800", "qty": 4221, "unit": "count" }
    ],
    "heart_rate": [
      { "date": "2024-01-15 08:30:00 -0800", "Min": 62, "Avg": 71, "Max": 88 }
    ],
    "heart_rate_variability_sdnn": [
      { "date": "2024-01-15 06:00:00 -0800", "qty": 42.3, "unit": "ms" }
    ],
    "sleep_analysis": [
      { "date": "2024-01-15", "totalSleep": 7.2, "deep": 1.1, "rem": 1.8, "core": 4.1, "awake": 0.2 }
    ]
  },
  "updated": "2024-01-16T10:00:00.000Z"
}
```

PATHS constant to add to `server/lib/fileUtils.js`:
```javascript
health: join(__lib_dirname, '../../data/health'),
```

### Pattern 5: WebSocket Progress (following backup.js)

**What:** Route gets `io` from `req.app.get('io')`, passes to service, service emits events.

```javascript
// Route (matches backup.js pattern exactly)
router.post('/import/xml', upload.single('file'), asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const result = await importAppleHealthXml(req.file.path, io);
  res.json(result);
}));

// Service emits (matches backup.js pattern):
if (io) io.emit('health:xml:progress', { processed: N, total: estimatedTotal });
if (io) io.emit('health:xml:complete', { days: N, records: M });
```

Client subscribes:
```javascript
// In AppleHealthImport.jsx
import socket from '../../../services/socket';
useEffect(() => {
  socket.on('health:xml:progress', ({ processed }) => setProgress(processed));
  socket.on('health:xml:complete', (result) => { setResult(result); setImporting(false); });
  return () => {
    socket.off('health:xml:progress');
    socket.off('health:xml:complete');
  };
}, []);
```

### Pattern 6: Recharts Dual-Axis Chart (Alcohol vs HRV)

**What:** `ComposedChart` with two `YAxis` components — one for HRV (ms), one for alcohol (grams).
**Already installed:** recharts v3.7.0

```jsx
// Source: recharts docs + verified from project's existing AlcoholChart.jsx patterns
import { ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

<ComposedChart data={correlationData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
  <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 11 }} />
  <YAxis yAxisId="hrv" orientation="left" tick={{ fill: '#9ca3af', fontSize: 11 }} />
  <YAxis yAxisId="alcohol" orientation="right" tick={{ fill: '#9ca3af', fontSize: 11 }} />
  <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }} />
  <Legend />
  <Line yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#3b82f6" dot={false} />
  <Bar yAxisId="alcohol" dataKey="alcoholGrams" fill="#f59e0b" opacity={0.7} />
</ComposedChart>
```

### Pattern 7: Sleep Stacked Horizontal Bar (per day)

**What:** Single `BarChart layout="vertical"` with stacked `Bar` components for sleep stages.

```jsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from 'recharts';

// One entry per day: { date, deep, rem, core, awake }
<BarChart layout="vertical" data={sleepData} height={60 * sleepData.length}>
  <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 11 }} />
  <YAxis type="category" dataKey="date" tick={{ fill: '#9ca3af', fontSize: 11 }} width={70} />
  <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }} />
  <Legend />
  <Bar dataKey="deep" stackId="sleep" fill="#3b82f6" />
  <Bar dataKey="rem" stackId="sleep" fill="#8b5cf6" />
  <Bar dataKey="core" stackId="sleep" fill="#06b6d4" />
  <Bar dataKey="awake" stackId="sleep" fill="#6b7280" />
</BarChart>
```

### Anti-Patterns to Avoid

- **Loading the full XML into memory:** Never use `fs.readFile()` on the upload — always pipe via `createReadStream()` to `sax.createStream()`.
- **multer memoryStorage for XML:** Will cause OOM on 500MB files — always use diskStorage.
- **DOM/SAX confusion:** Never use `DOMParser` or `xml2js` (loads full DOM) — use SAX stream only.
- **Hardcoding metric names:** Health Auto Export metric name strings differ from Apple's `HKQuantityTypeIdentifier*` XML type strings — maintain separate maps for each ingest path.
- **Single monolithic health file:** Never write all health data to one file — day-partitioned layout is required (and locked).
- **Blocking event loop during write:** Day file writes should be sequential per day or use `Promise.all` with a concurrency limit (< 50 concurrent writes) to avoid fs exhaustion.
- **Storing `io` in module scope from routes:** Follow backup.js pattern — pass `io` as function argument, get it from `req.app.get('io')` in the route.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Streaming XML parsing | Custom XML tokenizer | `sax` npm | SAX handles encoding, entity refs, malformed tags, attribute parsing — all edge cases handled |
| Multipart file upload | Custom body parser | `multer` diskStorage | Handles chunked transfer, temp file cleanup, file size limits |
| Chart rendering | Custom SVG charts | `recharts` (already installed) | Already in the project — line, bar, composed chart all ready to use |
| Date parsing | String splitting | Use `date.split(' ')[0]` (YYYY-MM-DD) | Apple Health dates are consistently formatted `YYYY-MM-DD HH:mm:ss ±HHMM` |

**Key insight:** The XML parsing domain has many edge cases (encoding, malformed tags, entity references). SAX handles them; hand-rolled parsers fail on real Apple Health exports.

---

## Common Pitfalls

### Pitfall 1: XML Not Strict-Mode Safe
**What goes wrong:** Apple Health `export.xml` sometimes contains duplicate attributes or minor malformations that cause strict-mode SAX parsers to throw and halt.
**Why it happens:** Apple's Health app generates the XML, and edge cases like workout metadata can produce slightly non-conformant XML.
**How to avoid:** Use `sax.createStream(false, { lowercase: true })` (non-strict mode). In the `error` handler: clear `this._parser.error = null` and call `this._parser.resume()` to skip bad records and continue.
**Warning signs:** Import halting at specific record counts; "duplicate attribute" errors in logs.

### Pitfall 2: Sleep XML Records Are Text Values, Not Numbers
**What goes wrong:** Sleep analysis records in XML have `value="HKCategoryValueSleepAnalysisAsleepREM"` (string), not a numeric value. Code expecting `parseFloat(value)` will produce NaN for all sleep records.
**Why it happens:** Apple uses categorical enum values for sleep stages in the XML export. The JSON export from Health Auto Export aggregates these into numeric hours (much easier).
**How to avoid:** In the XML parser, detect `type === 'HKCategoryTypeIdentifierSleepAnalysis'` and handle the `value` attribute as a stage name string. Map stage strings to bucket names:
```javascript
const SLEEP_STAGE_MAP = {
  'HKCategoryValueSleepAnalysisAsleepDeep': 'deep',
  'HKCategoryValueSleepAnalysisAsleepREM': 'rem',
  'HKCategoryValueSleepAnalysisAsleepCore': 'core',
  'HKCategoryValueSleepAnalysisAwake': 'awake',
  'HKCategoryValueSleepAnalysisInBed': 'inBed',
  'HKCategoryValueSleepAnalysisAsleep': 'asleep' // Legacy, pre-iOS 16
};
```
Calculate stage duration from `enddate - startdate` (minutes), accumulate per day.
**Warning signs:** Sleep dashboard showing zeros or NaN for all values.

### Pitfall 3: Step Count Is High-Frequency in XML (Aggregation Required)
**What goes wrong:** Steps in the XML are recorded every few seconds by the accelerometer — a single day may have thousands of step-count records. Storing each individually and then summing for the dashboard is correct but easy to do wrong (forgetting to sum per day).
**Why it happens:** Apple records steps at sensor cadence, not daily aggregates.
**How to avoid:** During XML import, sum step records per day before writing the day file, or store all records and sum during query. The simplest approach: accumulate `qty` values per day in the XML parser, write one aggregated `step_count` entry per day.
**Warning signs:** Step counts that are 100x higher than reality (forgot to deduplicate overlapping source records), or counts that are tiny (truncated to last record only).

### Pitfall 4: Health Auto Export Metric Names vs Apple HealthKit Type Names
**What goes wrong:** The JSON push from Health Auto Export uses `"name": "step_count"` (snake_case strings), but the XML export uses `type="HKQuantityTypeIdentifierStepCount"` (HealthKit class names). Code written for one ingest path will fail on the other if names are treated as equivalent.
**Why it happens:** Health Auto Export normalizes metric names to human-readable snake_case for its JSON API.
**How to avoid:** Maintain a mapping in the service:
```javascript
const XML_TO_METRIC_NAME = {
  'HKQuantityTypeIdentifierStepCount': 'step_count',
  'HKQuantityTypeIdentifierHeartRate': 'heart_rate',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN': 'heart_rate_variability_sdnn',
  'HKCategoryTypeIdentifierSleepAnalysis': 'sleep_analysis',
  // store all others verbatim or normalized
};
```
**Warning signs:** Dashboard queries returning no data after XML import; metric names with `HKQuantityTypeIdentifier` prefix appearing in day files alongside snake_case names from JSON push.

### Pitfall 5: Timezone Handling in Apple Health Dates
**What goes wrong:** Apple Health timestamps include timezone offsets (e.g., `"2024-01-15 08:30:00 -0800"`). If you parse these naively as UTC or strip the offset, dates near midnight can land on the wrong day.
**Why it happens:** The Health app records timestamps in the device's local timezone.
**How to avoid:** Extract the `YYYY-MM-DD` portion from the original timestamp string before any parsing, not from a parsed Date object. The string prefix `date.split(' ')[0]` (or `.substring(0, 10)`) gives the local date without timezone conversion. Use this as the day-partition key.
**Warning signs:** Some days showing no data while adjacent days have double data; late-night records appearing on the "next" day in UTC.

### Pitfall 6: express.json() Limit for Large JSON Pushes
**What goes wrong:** Health Auto Export can send large JSON payloads if syncing many days at once. The default Express JSON body parser limit is 100kb; the current `index.js` sets it to 50mb. Large batch syncs could still exceed this.
**Why it happens:** Health Auto Export can send weeks or months of data in a single batch.
**How to avoid:** The existing 50mb limit in `index.js` is probably sufficient for incremental pushes (the app syncs frequently). Document that batch syncs should be configured with smaller date ranges in the Health Auto Export app settings. If needed, the `/api/health/ingest` route can set its own limit via express-specific middleware.
**Warning signs:** 413 Payload Too Large errors from the ingest endpoint.

### Pitfall 7: Day File Write Races During XML Import
**What goes wrong:** If SAX events fire faster than async file writes complete, multiple writes to the same day file can overlap and corrupt data.
**Why it happens:** SAX parsing is synchronous but file writes are async; if you fire writes inside the opentag handler, multiple writes to the same day race.
**How to avoid:** Accumulate all day buckets in-memory during SAX parse, then write all day files sequentially (or with capped concurrency) after the stream ends. Never write during the SAX event loop.
**Warning signs:** JSON parse errors when reading day files; truncated files.

---

## Code Examples

Verified patterns from official sources and project codebase:

### How io is accessed in routes (from backup.js)
```javascript
// Source: server/routes/backup.js line 20
const io = req.app.get('io');
const result = await backup.runBackup(settings.backup?.destPath, io);
```

### How app sets io (from index.js)
```javascript
// Source: server/index.js line 171
app.set('io', io);
```

### Day-partitioned file read helper (follows meatspaceHealth.js pattern)
```javascript
// Source: pattern from server/services/meatspaceHealth.js
import { readJSONFile, PATHS } from '../lib/fileUtils.js';
import { join } from 'path';

const HEALTH_DIR = join(PATHS.data, 'health'); // until PATHS.health is added

export async function readDayFile(dateStr) {
  const filePath = join(HEALTH_DIR, `${dateStr}.json`);
  return readJSONFile(filePath, { date: dateStr, metrics: {} });
}
```

### Recharts LineChart with dark theme (matching port-* tokens)
```jsx
// Pattern from client/src/components/meatspace/AlcoholChart.jsx style
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

<ResponsiveContainer width="100%" height={200}>
  <LineChart data={data}>
    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
    <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 11 }} />
    <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} />
    <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#fff' }} />
    <Line type="monotone" dataKey="value" stroke="#3b82f6" dot={false} strokeWidth={2} />
  </LineChart>
</ResponsiveContainer>
```

### MeatSpace tab addition pattern (from MeatSpace.jsx + constants.js)
```javascript
// Add to client/src/components/meatspace/constants.js TABS array
{ id: 'health', label: 'Health', icon: HeartPulse }
// 'health' sorts alphabetically between 'genome' and 'lifestyle' — correct order

// Add to MeatSpace.jsx renderTabContent switch
case 'health':
  return <HealthTab />;
```

### Apple Health XML Record element structure
```xml
<!-- Steps record (numeric value) -->
<Record type="HKQuantityTypeIdentifierStepCount"
        sourceName="Adam's iPhone"
        sourceVersion="17.0"
        unit="count"
        creationDate="2024-01-15 10:05:32 -0800"
        startDate="2024-01-15 10:00:00 -0800"
        endDate="2024-01-15 10:05:00 -0800"
        value="432"/>

<!-- Heart Rate Variability (numeric value, ms) -->
<Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN"
        unit="ms"
        startDate="2024-01-15 06:12:00 -0800"
        endDate="2024-01-15 06:17:00 -0800"
        value="42.3"/>

<!-- Sleep (categorical value, not numeric) -->
<Record type="HKCategoryTypeIdentifierSleepAnalysis"
        sourceName="Adam's Apple Watch"
        startDate="2024-01-15 00:30:00 -0800"
        endDate="2024-01-15 01:45:00 -0800"
        value="HKCategoryValueSleepAnalysisAsleepDeep"/>
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| DOM-based XML parsers (xml2js) | SAX streaming | Established | DOM loads full file into memory — fatal for 500MB+ |
| Single health data file | Day-partitioned files | User decision | Enables efficient date-range queries without loading all data |
| Health Auto Export v1 format | v2 format with `data.metrics[]` wrapper | ~2022 | v1 used flat array without `data` wrapper; always validate for `data.metrics` existence |

**Deprecated/outdated:**
- Health Auto Export v1 JSON format: flat `{ metrics: [] }` without the `data` wrapper. The current format wraps in `data`: `{ data: { metrics: [] } }`. The Zod schema should validate `data.metrics` and return a clear error if payload is v1 format.
- `HKCategoryValueSleepAnalysisAsleep` (legacy, pre-iOS 16): maps to "asleep generally" — newer exports split into `AsleepCore`, `AsleepDeep`, `AsleepREM`. Store both but prefer the specific stages.

---

## Open Questions

1. **Exact metric name strings in Health Auto Export JSON**
   - What we know: `step_count`, `heart_rate`, `sleep_analysis` confirmed from documentation and community usage; `heart_rate_variability_sdnn` is the documented HRV metric name
   - What's unclear: Whether the app sends `heart_rate_variability_sdnn` or `hrv` or another variant in the latest v7+ release
   - Recommendation: Write the Zod schema with `.passthrough()` so unknown metric names are stored without validation failure; query by exact name string; document the expected names in comments

2. **Progress percentage for XML (total record count unknown before streaming)**
   - What we know: SAX streaming doesn't know total records before it starts; we can't show a true percentage without a pre-scan
   - What's unclear: Whether a pre-scan pass is worth the latency
   - Recommendation: Emit live record counts (`processed: N`) rather than percentage; the UI shows "N records processed" rather than "X%" — simpler and still informative

3. **Apple Health export ZIP vs raw XML**
   - What we know: The Apple Health export from iOS is a `.zip` file containing `export.xml` inside
   - What's unclear: Whether users will upload the ZIP or extract the XML themselves
   - Recommendation: Accept raw `.xml` upload only (simpler); document in the UI that users must extract the ZIP first. The Import tab can show this instruction. Defer ZIP extraction support to Phase 4 if needed.

4. **Nutrition overwrite behavior**
   - What we know: Decision is "Apple Health nutrition REPLACES existing daily-log nutrition for overlapping days"
   - What's unclear: Exactly which file gets overwritten — `data/meatspace/daily-log.json` (existing) vs the new `data/health/YYYY-MM-DD.json` (new)
   - Recommendation: The new health day files are the canonical store for Apple Health data (including nutrition from Apple Health). The existing `daily-log.json` is the canonical store for manually-entered TSV data. Do NOT overwrite `daily-log.json` with Apple Health nutrition — instead, when querying nutrition for the dashboard, prefer health day files over daily-log for overlapping dates. This is safer and reversible.

---

## Validation Architecture

> workflow.nyquist_validation not present in config.json — skipping this section per instructions.

---

## Test Infrastructure

**Framework:** Vitest (v4.0.16), confirmed in `server/package.json`
**Test pattern:** Inline pure function copies to avoid complex mocking (see `meatspaceHealth.test.js` and `meatspaceImport.test.js`)
**Run command:** `cd server && npm test`

Tests to write for this phase follow the established project pattern:
- `appleHealthIngest.test.js` — pure functions for dedup, metric parsing, date extraction
- `appleHealthXml.test.js` — pure functions for XML record parsing, sleep stage mapping, step aggregation
- `appleHealthQuery.test.js` — pure functions for date range filtering, aggregation for dashboard

Mock pattern used in project: `vi.mock('fs/promises', ...)` and `vi.mock('../lib/fileUtils.js', ...)`

---

## Sources

### Primary (HIGH confidence)
- `server/routes/backup.js` + `server/services/backup.js` — io access pattern (`req.app.get('io')`, `io.emit`)
- `server/index.js` line 171 — `app.set('io', io)` pattern
- `server/lib/fileUtils.js` — PATHS constants, readJSONFile helper
- `server/services/meatspaceImport.js` — File write pattern, ensureDir usage
- `server/services/meatspaceHealth.js` — Service pattern for health data CRUD
- `client/package.json` — recharts v3.7.0 already installed
- `server/package.json` — sax and multer NOT yet installed; zod, socket.io confirmed
- https://github.com/Lybron/health-auto-export/wiki/API-Export---JSON-Format — JSON schema (HIGH confidence, official wiki)
- https://github.com/isaacs/sax-js — SAX streaming API, createStream, opentag event structure

### Secondary (MEDIUM confidence)
- https://ladvien.com/syncing-apple-health-kit-data-postgres/ — Confirmed JSON payload structure with real implementation example
- https://www.johngoldin.com/blog/apple-health-export/2023-02-sleep-export/ — Sleep XML value strings (HKCategoryValueSleepAnalysis*) confirmed
- https://www.ryanpraski.com/apple-health-data-how-to-export-analyze-visualize-guide/ — XML Record element attributes confirmed
- WebSearch results — SAX non-strict mode for Apple Health XML confirmed; multer diskStorage for large files confirmed

### Tertiary (LOW confidence)
- Exact metric name strings for Health Auto Export v7+ JSON (e.g., `heart_rate_variability_sdnn` vs `hrv`) — not directly verified against current app version; only confirmed from older documentation and community examples

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — sax, multer, recharts, zod, socket.io all verified; sax and multer need installation
- Architecture: HIGH — patterns confirmed from existing project files (backup.js, meatspaceImport.js, meatspaceHealth.js)
- Apple Health data formats: HIGH for XML structure; MEDIUM for exact JSON metric names (app version variance)
- Pitfalls: HIGH — XML non-strict mode, sleep categorical values, and timezone issues verified from multiple community sources
- Recharts patterns: HIGH — library already installed; API verified

**Research date:** 2026-02-26
**Valid until:** 2026-03-28 (recharts and sax are stable; Health Auto Export schema may update with app releases)
