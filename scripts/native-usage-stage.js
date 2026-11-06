#!/usr/bin/env node
/** Offline only: consumes explicit report/selection files, never local settings. */
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildNativeUsageStage, verifyNativeUsageStage } from '../server/lib/nativeUsageStaging.js';
import { nativeUsageCanonicalJson } from '../server/lib/nativeUsageContract.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const USAGE = 'Usage: native-usage-stage.js stage <request.json> <output-directory> <report.json>... | verify <artifact.json>';
const readJson = async path => {
  const bytes = await readFile(path).catch(() => { throw new Error('cannot read staging input'); });
  return Promise.resolve().then(() => JSON.parse(bytes.toString('utf8')))
    .catch(() => { throw new Error('invalid staging JSON'); });
};

/** Publish one complete immutable artifact. Retries never overwrite an old stage. */
async function publishStage(directory, artifact) {
  const fileName = `native-usage-stage-${artifact.contentHash}.json`;
  const target = join(directory, fileName);
  const bytes = nativeUsageCanonicalJson(artifact);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, '.native-usage-'));
  try {
    const candidate = join(temporary, 'stage.json');
    await writeFile(candidate, bytes, { flag: 'wx', mode: 0o600 });
    // A hard link publishes only complete bytes and does not replace an existing
    // target, including when two explicit staging commands finish together.
    await link(candidate, target).catch(async error => {
      if (error.code !== 'EEXIST') throw new Error('cannot publish staging artifact');
      const info = await lstat(target);
      if (!info.isFile() || await readFile(target, 'utf8') !== bytes) throw new Error('existing staging artifact does not match');
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return fileName;
}

export async function runNativeUsageStageCli(argv, { stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  const [command, ...args] = argv;
  if (command === 'stage' && args.length >= 3 && args.length <= 130) {
    const [requestPath, directory, ...reportPaths] = args;
    const request = await readJson(requestPath);
    const reports = await Promise.all(reportPaths.map(readJson));
    const artifact = buildNativeUsageStage({ request, reports });
    const fileName = await publishStage(directory, artifact);
    stdout(nativeUsageCanonicalJson({ status: 'staged', contentHash: artifact.contentHash, fileName, partitionCount: artifact.partitions.length, activationReady: false }));
    return 0;
  }
  if (command === 'verify' && args.length === 1) {
    const artifact = verifyNativeUsageStage(await readJson(args[0]));
    stdout(nativeUsageCanonicalJson({ status: 'verified', contentHash: artifact.contentHash, partitionCount: artifact.partitions.length, activationReady: false }));
    return 0;
  }
  stderr(`${USAGE}\n`);
  return 2;
}

if (isDirectlyInvoked(import.meta.url)) {
  runNativeUsageStageCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    // Filesystem messages may contain private paths. Only our fixed diagnostics
    // and contract refusal codes belong on the operator console.
    console.log(`🚫 ${error.code === 'NATIVE_USAGE_STAGE_REFUSED' ? error.message : 'Native usage staging failed; check input and output files'}`);
    process.exitCode = 1;
  });
}
