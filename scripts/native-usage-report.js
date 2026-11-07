#!/usr/bin/env node
/**
 * Read-only native usage evidence for the staged recovery in #15031.
 *
 *   node scripts/native-usage-report.js capture > participant.json
 *   node scripts/native-usage-report.js matrix a.json b.json > matrix.json
 *   node scripts/native-usage-report.js matrix --summary a.json b.json
 *
 * `capture` runs on each participant: it scans retained native files and makes the
 * fixed Codex account reads. `matrix` runs on one machine over the captured files and
 * this install's `usageNativeAccountSelections` setting. Neither calls a model, writes
 * the ledger, contacts a peer, or changes authentication or sync.
 */

import { readFile } from 'node:fs/promises';
import {
  buildNativeUsageMatrix,
  formatNativeUsageMatrixSummary,
  nativeUsageCanonicalJson,
} from '../server/lib/nativeUsageContract.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const USAGE = 'Usage: native-usage-report.js capture | matrix [--summary] <report.json>...';

const readReport = async (path) => {
  const text = await readFile(path, 'utf8').catch((err) => { throw new Error(`cannot read a report (${err.code ?? 'error'})`); });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('a report is not valid JSON');
  }
};

// The app-server child belongs to this one-shot process and would otherwise keep it alive.
const captureAndStop = async () => {
  const { captureNativeUsageReport } = await import('../server/services/nativeUsageReport.js');
  const { stopCodexAppServer } = await import('../server/services/codexAppServer.js');
  try {
    return await captureNativeUsageReport();
  } finally {
    await stopCodexAppServer();
  }
};

/** Exit code for `argv`. Dependencies are injected so a test needs no server state. */
export async function runNativeUsageReportCli(argv, {
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  capture = captureAndStop,
  readSelections = async () => (await import('../server/services/nativeUsageReport.js')).getNativeUsageAccountSelections(),
} = {}) {
  const [command, ...rest] = argv;
  // Services log progress with console.log. Stdout is the byte-identical artifact.
  const consoleLog = console.log;
  console.log = (...args) => stderr(`${args.join(' ')}\n`);
  try {
    if (command === 'capture' && !rest.length) {
      stdout(nativeUsageCanonicalJson(await capture()));
      return 0;
    }
    const paths = rest.filter((arg) => arg !== '--summary');
    if (command !== 'matrix' || !paths.length || paths.some((path) => path.startsWith('--'))) {
      stderr(`${USAGE}\n`);
      return 2;
    }
    const reports = await Promise.all(paths.map(readReport));
    const matrix = buildNativeUsageMatrix({ reports, selections: await readSelections() });
    stdout(rest.includes('--summary') ? `${formatNativeUsageMatrixSummary(matrix)}\n` : nativeUsageCanonicalJson(matrix));
    return 0;
  } finally {
    console.log = consoleLog;
  }
}

if (isDirectlyInvoked(import.meta.url)) {
  runNativeUsageReportCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`❌ Native usage report failed: ${err.message}`); process.exitCode = 1; },
  );
}
