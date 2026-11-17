#!/usr/bin/env node
/**
 * Merge restored test-memo shard lineages into the job's memo directory:
 * `node scripts/merge-test-memo.js <target> [source...]`. A source that was
 * not restored (no cache yet) is simply absent. Used by
 * `.github/actions/test-memo`; see docs/TEST_MEMO.md.
 */

import { existsSync } from 'node:fs';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { mergeMemoStore } from './lib/testMemoStore.js';

export function mergeTestMemoDirs(target, sources) {
  const total = { entries: 0, records: 0, sources: 0 };
  for (const source of sources) {
    if (!existsSync(source)) continue;
    const copied = mergeMemoStore(target, source);
    total.entries += copied.entries;
    total.records += copied.records;
    total.sources += 1;
  }
  return total;
}

if (isDirectlyInvoked(import.meta.url)) {
  const [target, ...sources] = process.argv.slice(2);
  if (!target) {
    console.error('❌ usage: merge-test-memo.js <target> [source...]');
    process.exit(2);
  }
  const total = mergeTestMemoDirs(target, sources);
  console.log(`🧠 Test memo: merged ${total.records} records and ${total.entries} entries from ${total.sources} shard lineages.`);
}
