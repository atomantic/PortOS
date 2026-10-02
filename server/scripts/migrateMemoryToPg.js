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

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { query, withTransaction, close } from '../lib/db.js';
import { isDirectlyInvoked } from '../../scripts/lib/directInvocation.js';
import { PATHS } from '../lib/fileUtils.js';

async function loadJSON(path) {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
}

function arrayToPgvector(arr) {
  if (!arr) return null;
  return `[${arr.join(',')}]`;
}

export async function migrate({ memoryDir = PATHS.memory, execute = false, clearFirst = false } = {}) {
  const indexFile = join(memoryDir, 'index.json');
  const embeddingsFile = join(memoryDir, 'embeddings.json');
  const memoriesDir = join(memoryDir, 'memories');
  console.log('🧠 Memory Migration: JSON → PostgreSQL');
  console.log(`   Mode: ${execute ? 'EXECUTE' : 'DRY RUN (add --execute to write)'}`);
  console.log('');

  // 1. Check source files exist
  if (!existsSync(indexFile)) {
    console.log('⚠️  No index.json found — nothing to migrate');
    return;
  }

  // 2. Load index and embeddings
  const index = await loadJSON(indexFile);
  console.log(`📋 Index: ${index.memories.length} memory entries`);

  let embeddings = { vectors: {} };
  if (existsSync(embeddingsFile)) {
    embeddings = await loadJSON(embeddingsFile);
    console.log(`🧮 Embeddings: ${Object.keys(embeddings.vectors).length} vectors`);
  }

  // Read every source before opening the replacement transaction. A corrupt
  // later record must never leave an already-cleared database behind.
  const records = [];
  for (const meta of index.memories) {
    const memoryFile = join(memoriesDir, meta.id, 'memory.json');

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

    if (memory.relatedMemories != null && !Array.isArray(memory.relatedMemories)) {
      throw new Error(`Invalid relatedMemories for ${meta.id}`);
    }
    const embedding = embeddings.vectors[meta.id] || null;
    records.push({ memory, embedding });
  }

  await query('SELECT 1 AS ok');
  const schemaCheck = await query(
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'memories') AS has_table"
  );
  if (!schemaCheck.rows[0].has_table) throw new Error('memories table not found. Run init-db.sql first.');
  console.log('✅ PostgreSQL connected and schema verified');

  if (!execute) {
    console.log(`📊 Would import ${records.length} memories${clearFirst ? ' after clearing existing data' : ''}`);
    console.log('ℹ️  This was a dry run. Add --execute to perform the migration.');
    return { inserted: 0, skipped: 0, links: 0 };
  }

  const result = await withTransaction(async client => {
    if (clearFirst) {
      await client.query('DELETE FROM memory_links');
      await client.query('DELETE FROM memories');
    }
    let inserted = 0;
    let skipped = 0;
    let links = 0;
    for (const { memory, embedding } of records) {
      // Preserve legacy replay semantics even when an existing record's source
      // body is incomplete; PostgreSQL checks NOT NULL before ON CONFLICT.
      const existing = await client.query('SELECT 1 FROM memories WHERE id = $1', [memory.id]);
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }
      const insertResult = await client.query(
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
        ) ON CONFLICT (id) DO NOTHING`,
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
      );
      if (insertResult.rowCount > 0) inserted++;
      else skipped++;
    }

    // Every record exists before links are inserted, including forward links.
    // Replay may add links but never overwrites an existing memory's content.
    for (const { memory } of records) {
      for (const relId of memory.relatedMemories || []) {
        const link = await client.query(
          'INSERT INTO memory_links (source_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [memory.id, relId]
        );
        links += link.rowCount;
      }
    }
    const count = await client.query('SELECT COUNT(*) AS count FROM memories');
    return { inserted, skipped, links, total: Number(count.rows[0].count) };
  });

  console.log(`📊 Migration Summary: inserted ${result.inserted}, skipped ${result.skipped}, links ${result.links}, total ${result.total}`);
  return result;
}

if (isDirectlyInvoked(import.meta.url)) {
  const args = process.argv.slice(2);
  migrate({ execute: args.includes('--execute'), clearFirst: args.includes('--clear') })
    .finally(() => close())
    .catch(err => {
      console.error(`💥 Migration failed: ${err.message}`);
      process.exitCode = 1;
    });
}
