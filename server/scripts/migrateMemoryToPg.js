#!/usr/bin/env node

/**
 * Memory Migration Script: JSON Files → PostgreSQL + pgvector
 *
 * Reads all memories from data/cos/memory/ (index.json, embeddings.json,
 * and individual memory.json files) and inserts them into PostgreSQL.
 *
 * Usage:
 *   node server/scripts/migrateMemoryToPg.js                    # Dry run
 *   node server/scripts/migrateMemoryToPg.js --execute           # Execute migration
 *   node server/scripts/migrateMemoryToPg.js --execute --clear   # Clear DB first, then migrate
 *
 * Requirements:
 *   - PostgreSQL with pgvector must be running (docker compose up -d)
 *   - Schema must be initialized (happens automatically via init-db.sql)
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query, close } from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const MEMORY_DIR = join(DATA_DIR, 'cos/memory');
const INDEX_FILE = join(MEMORY_DIR, 'index.json');
const EMBEDDINGS_FILE = join(MEMORY_DIR, 'embeddings.json');
const MEMORIES_DIR = join(MEMORY_DIR, 'memories');

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const clearFirst = args.includes('--clear');

async function loadJSON(path) {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
}

function arrayToPgvector(arr) {
  if (!arr) return null;
  return `[${arr.join(',')}]`;
}

async function migrate() {
  console.log('🧠 Memory Migration: JSON → PostgreSQL');
  console.log(`   Mode: ${execute ? 'EXECUTE' : 'DRY RUN (add --execute to write)'}`);
  console.log('');

  // 1. Check source files exist
  if (!existsSync(INDEX_FILE)) {
    console.log('⚠️  No index.json found — nothing to migrate');
    return;
  }

  // 2. Load index and embeddings
  const index = await loadJSON(INDEX_FILE);
  console.log(`📋 Index: ${index.memories.length} memory entries`);

  let embeddings = { vectors: {} };
  if (existsSync(EMBEDDINGS_FILE)) {
    embeddings = await loadJSON(EMBEDDINGS_FILE);
    console.log(`🧮 Embeddings: ${Object.keys(embeddings.vectors).length} vectors`);
  }

  // 3. Load each full memory from disk
  const memoryDirs = existsSync(MEMORIES_DIR)
    ? await readdir(MEMORIES_DIR).catch(() => [])
    : [];
  console.log(`📁 Memory files: ${memoryDirs.length} directories`);
  console.log('');

  // 4. Check DB connection
  const dbCheck = await query('SELECT 1 AS ok').catch(err => {
    console.error(`❌ Cannot connect to PostgreSQL: ${err.message}`);
    console.error('   Is the database running? Try: docker compose up -d');
    process.exit(1);
  });
  console.log('✅ PostgreSQL connected');

  // Check schema
  const schemaCheck = await query(
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'memories') AS has_table"
  );
  if (!schemaCheck.rows[0].has_table) {
    console.error('❌ memories table not found. Run init-db.sql first.');
    process.exit(1);
  }
  console.log('✅ Schema verified');

  // 5. Clear if requested
  if (execute && clearFirst) {
    await query('DELETE FROM memory_links');
    await query('DELETE FROM memories');
    console.log('🗑️  Cleared existing data');
  }

  // 6. Check existing count
  const existing = await query('SELECT COUNT(*) AS count FROM memories');
  console.log(`📊 Existing DB records: ${existing.rows[0].count}`);
  console.log('');

  // 7. Migrate each memory
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const meta of index.memories) {
    const memoryFile = join(MEMORIES_DIR, meta.id, 'memory.json');

    let memory;
    if (existsSync(memoryFile)) {
      memory = await loadJSON(memoryFile);
    } else {
      // Use index metadata as fallback (no full content)
      memory = {
        id: meta.id,
        type: meta.type,
        content: meta.summary || '',
        summary: meta.summary || '',
        category: meta.category || 'other',
        tags: meta.tags || [],
        relatedMemories: [],
        sourceTaskId: null,
        sourceAgentId: null,
        sourceAppId: meta.sourceAppId || null,
        confidence: 0.8,
        importance: meta.importance || 0.5,
        accessCount: 0,
        lastAccessed: null,
        createdAt: meta.createdAt || new Date().toISOString(),
        updatedAt: meta.createdAt || new Date().toISOString(),
        expiresAt: null,
        status: meta.status || 'active'
      };
    }

    const embedding = embeddings.vectors[meta.id] || null;

    if (!execute) {
      console.log(`  [DRY] ${meta.id} — ${memory.type}: ${(memory.summary || '').substring(0, 60)}...`);
      inserted++;
      continue;
    }

    // Check if already exists
    const existCheck = await query('SELECT 1 FROM memories WHERE id = $1', [memory.id]);
    if (existCheck.rows.length > 0) {
      skipped++;
      continue;
    }

    const insertResult = await query(
      `INSERT INTO memories (
        id, type, content, summary, category, tags,
        embedding, embedding_model, confidence, importance,
        access_count, last_accessed,
        source_task_id, source_agent_id, source_app_id,
        expires_at, status, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12,
        $13, $14, $15,
        $16, $17, $18, $19
      )`,
      [
        memory.id, memory.type, memory.content, memory.summary,
        memory.category || 'other', memory.tags || [],
        embedding ? arrayToPgvector(embedding) : null,
        memory.embeddingModel || (embedding ? 'text-embedding-nomic-embed-text-v2-moe' : null),
        memory.confidence ?? 0.8, memory.importance ?? 0.5,
        memory.accessCount || 0, memory.lastAccessed || null,
        memory.sourceTaskId || null, memory.sourceAgentId || null, memory.sourceAppId || null,
        memory.expiresAt || null, memory.status || 'active',
        memory.createdAt || new Date().toISOString(), memory.updatedAt || new Date().toISOString()
      ]
    ).catch(err => {
      console.error(`  ❌ ${meta.id}: ${err.message}`);
      errors++;
      return null;
    });

    if (insertResult) {
      inserted++;

      // Migrate related memory links
      if (memory.relatedMemories?.length > 0) {
        for (const relId of memory.relatedMemories) {
          await query(
            'INSERT INTO memory_links (source_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [memory.id, relId]
          ).catch(() => {}); // Skip if target doesn't exist yet
        }
      }
    }
  }

  // 8. Second pass: retry links (some targets may not have existed on first pass)
  if (execute) {
    let linksFixed = 0;
    for (const meta of index.memories) {
      const memoryFile = join(MEMORIES_DIR, meta.id, 'memory.json');
      if (!existsSync(memoryFile)) continue;

      const memory = await loadJSON(memoryFile);
      if (!memory.relatedMemories?.length) continue;

      for (const relId of memory.relatedMemories) {
        const result = await query(
          'INSERT INTO memory_links (source_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [memory.id, relId]
        ).catch(() => null);
        if (result?.rowCount > 0) linksFixed++;
      }
    }
    if (linksFixed > 0) console.log(`🔗 Fixed ${linksFixed} memory links on second pass`);
  }

  // 9. Report
  console.log('');
  console.log('📊 Migration Summary:');
  console.log(`   Inserted: ${inserted}`);
  console.log(`   Skipped (already exists): ${skipped}`);
  console.log(`   Errors: ${errors}`);

  if (execute) {
    const finalCount = await query('SELECT COUNT(*) AS count FROM memories');
    console.log(`   Total in DB: ${finalCount.rows[0].count}`);
  }

  if (!execute) {
    console.log('');
    console.log('ℹ️  This was a dry run. Add --execute to perform the migration.');
  }
}

migrate()
  .catch(err => {
    console.error(`💥 Migration failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(() => close());
