#!/usr/bin/env node

/**
 * Brain → CoS Memory Migration Script
 *
 * Reads all brain entity stores (people, projects, ideas, admin, memories/journal)
 * and JSONL files (digests, reviews), then creates corresponding entries in the
 * CoS memory system with embeddings.
 *
 * Usage:
 *   node server/scripts/migrateBrainToMemories.js              # Dry run (default)
 *   node server/scripts/migrateBrainToMemories.js --execute     # Write to memory system
 *
 * Records that already have a bridge mapping are skipped.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { syncAllBrainData } from '../services/brainMemoryBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const execute = args.includes('--execute');

async function main() {
  console.log('🧠🔗 Brain → Memory Migration');
  console.log(`   Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
  console.log('');

  const stats = await syncAllBrainData({ dryRun: !execute });

  console.log('');
  console.log('📊 Results:');
  console.log(`   Synced:  ${stats.synced}`);
  console.log(`   Skipped: ${stats.skipped} (already mapped or archived)`);
  console.log(`   Errors:  ${stats.errors}`);

  if (!execute && stats.synced > 0) {
    console.log('');
    console.log('💡 Run with --execute to write to the memory system:');
    console.log('   node server/scripts/migrateBrainToMemories.js --execute');
  }
}

main().then(() => {
  // Give async operations time to flush, then exit
  setTimeout(() => process.exit(0), 1000);
}).catch(err => {
  console.error(`❌ Migration failed: ${err.message}`);
  process.exit(1);
});
