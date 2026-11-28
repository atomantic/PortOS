/**
 * Shared PostgreSQL and file backends for last-writer-wins catalog records.
 *
 * Storage: `db-primary` catalog records federate through the owning service's
 * sync protocol. The JSON adapter is the existing dev/test escape hatch.
 */

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  contentHashForRecord, deleteSyncBaseHash, flushBaseHashes, maybeJournalBeforeOverwrite,
  setSyncBaseHash, withBaseHashFlushBatch,
} from './conflictJournal.js';
import { query, withTransaction } from './db.js';
import { ServerError } from './errorHandler.js';
import { atomicWrite, ensureDir, readJSONFile } from './fileUtils.js';
import { toPgJson } from './pgJson.js';
import { mirrorTimestamp } from './pgTimestamp.js';

function recordOperations({ kind, idPrefix, labelColumn, logLabel = kind, emoji, build, applyPatch, merge, clearOnLocalWrite = [] }) {
  const invalid = () => new ServerError(`Invalid ${kind} payload`, { status: 400, code: 'VALIDATION' });
  const notFound = () => new ServerError(
    `${kind[0].toUpperCase()}${kind.slice(1)} not found`,
    { status: 404, code: 'NOT_FOUND' },
  );
  return {
    buildRecord(input) {
      const record = build(input, { id: `${idPrefix}${randomUUID()}`, now: new Date().toISOString() });
      if (!record) throw invalid();
      return record;
    },
    patchRecord(record, patch) {
      if (!record || record.deleted) throw notFound();
      const next = applyPatch(record, patch);
      if (!next) throw invalid();
      for (const field of clearOnLocalWrite) delete next[field];
      return next;
    },
    tombstoneRecord(record) {
      if (!record || record.deleted) throw notFound();
      const now = new Date().toISOString();
      const next = { ...record, deleted: true, deletedAt: now, updatedAt: now };
      for (const field of clearOnLocalWrite) delete next[field];
      return next;
    },
    logCreation(record) {
      console.log(`${emoji} Created ${logLabel}: ${record.id} (${record[labelColumn]})`);
    },
    async applySyncRecord(local, remote, options, save) {
      const { next, inserted, remoteWins, changed } = merge(local, remote, options);
      if (!next || !changed) return false;
      // A local winner may shed receiver-only metadata on direct category sync.
      // Its portable content and common-ancestor hash did not change.
      if (!inserted && !remoteWins) {
        await save(next);
        return false;
      }
      const { source = { via: 'sync', peerId: null } } = options;
      // Whole-record LWW treats an identical winner as agreement. Journal
      // actual overwrites before saving and seed a base hash on first insert.
      if (!inserted) await maybeJournalBeforeOverwrite({ kind, id: next.id, local, remote: next, source });
      await save(next);
      await setSyncBaseHash(kind, next.id, contentHashForRecord(kind, next));
      return true;
    },
    async evictBaseHashes(ids) {
      await withBaseHashFlushBatch(async () => {
        for (const id of ids) await deleteSyncBaseHash(kind, id);
      });
    },
  };
}

export function createLwwRecordDbBackend(config) {
  const {
    table, labelColumn, orderBy = labelColumn, sanitize, sanitizeOnRead = false,
    acceptsTransactionClient = false, lockListInTransaction = false,
  } = config;
  const { buildRecord, patchRecord, tombstoneRecord, logCreation, applySyncRecord, evictBaseHashes } = recordOperations(config);

  // SQL identifiers come from the owning modules' static configuration.
  const selectById = `SELECT data FROM ${table} WHERE id = $1`;
  const upsert = `INSERT INTO ${table} (id, ${labelColumn}, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       ${labelColumn} = EXCLUDED.${labelColumn},
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`;
  const pruneExpired = `DELETE FROM ${table}
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`;
  const liveFilter = (includeDeleted) => includeDeleted ? '' : ' WHERE deleted = FALSE';
  const transactionClient = (options) => acceptsTransactionClient ? options.client : undefined;
  const executor = (client) => client ? client.query.bind(client) : query;

  function fromRow(row) {
    if (!row) return null;
    return sanitizeOnRead ? sanitize(row.data) : row.data;
  }

  async function save(exec, record) {
    const createdAt = mirrorTimestamp(record.createdAt, new Date().toISOString());
    const label = record[labelColumn];
    await exec(upsert, [
      record.id,
      typeof label === 'string' ? label : '',
      toPgJson(record),
      createdAt,
      mirrorTimestamp(record.updatedAt, createdAt),
      record.deleted === true,
      mirrorTimestamp(record.deletedAt, null),
    ]);
  }

  async function selectLocked(client, id) {
    const { rows } = await client.query(`${selectById} FOR UPDATE`, [id]);
    return fromRow(rows[0]);
  }

  function mutate(id, options, apply) {
    const run = async (client) => {
      const current = await selectLocked(client, id);
      const next = apply(current);
      await save(executor(client), next);
      return next;
    };
    const client = transactionClient(options);
    return client ? run(client) : withTransaction(run);
  }

  return {
    async list(options = {}) {
      const { includeDeleted = false } = options;
      const client = transactionClient(options);
      const lock = lockListInTransaction && client ? ' FOR UPDATE' : '';
      const { rows } = await executor(client)(
        `SELECT data FROM ${table}${liveFilter(includeDeleted)} ORDER BY ${orderBy} ASC${lock}`,
      );
      return rows.map(fromRow);
    },
    async listIds({ includeDeleted = false } = {}) {
      const { rows } = await query(`SELECT id FROM ${table}${liveFilter(includeDeleted)}`);
      return rows.map((row) => row.id);
    },
    async get(id, options = {}) {
      const { includeDeleted = false } = options;
      const client = transactionClient(options);
      const { rows } = await executor(client)(`${selectById}${client ? ' FOR UPDATE' : ''}`, [id]);
      const record = fromRow(rows[0]);
      return record && (includeDeleted || !record.deleted) ? record : null;
    },
    async create(input, options = {}) {
      const record = buildRecord(input);
      await save(executor(transactionClient(options)), record);
      logCreation(record);
      return record;
    },
    async update(id, patch, options = {}) {
      return mutate(id, options, (record) => patchRecord(record, patch));
    },
    async remove(id, options = {}) {
      await mutate(id, options, tombstoneRecord);
      return { id };
    },
    async mergeFromSync(records, options = {}) {
      if (!Array.isArray(records)) return { applied: false, count: 0 };
      let count = 0;
      for (const remote of records) {
        const run = async (client) => {
          const local = await selectLocked(client, remote?.id);
          return applySyncRecord(local, remote, options, (next) => save(executor(client), next));
        };
        const client = transactionClient(options);
        const applied = client ? await run(client) : await withTransaction(run);
        if (applied) count += 1;
      }
      await flushBaseHashes();
      return { applied: count > 0, count };
    },
    async pruneTombstoned(olderThanMs) {
      if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
      const cutoff = new Date(olderThanMs).toISOString();
      const { rows } = await query(pruneExpired, [cutoff]);
      await evictBaseHashes(rows.map((row) => row.id));
      return { pruned: rows.length };
    },
  };
}

export function createLwwRecordFileBackend(config) {
  const {
    filePath, labelColumn, orderBy = labelColumn, sanitize,
    readAll = (load) => load(),
    writeAll = (records, save) => save(records),
  } = config;
  const { buildRecord, patchRecord, tombstoneRecord, logCreation, applySyncRecord, evictBaseHashes } = recordOperations(config);

  const loadAll = () => readAll(async () => {
    // A failed read must never lead to replacing durable records with an empty fallback.
    const raw = await readJSONFile(filePath, [], { strict: true });
    return (Array.isArray(raw) ? raw : []).map(sanitize).filter(Boolean);
  });

  const saveAll = (records) => writeAll(records, async (next) => {
    await ensureDir(dirname(filePath));
    await atomicWrite(filePath, next);
  });

  async function listVisible(includeDeleted) {
    const all = await loadAll();
    return includeDeleted ? all : all.filter((record) => !record.deleted);
  }

  async function mutate(id, apply) {
    const all = await loadAll();
    const index = all.findIndex((record) => record.id === id);
    const next = apply(all[index]);
    all[index] = next;
    await saveAll(all);
    return next;
  }

  return {
    async list({ includeDeleted = false } = {}) {
      const records = await listVisible(includeDeleted);
      return records.sort((a, b) => (a[orderBy] || '').localeCompare(b[orderBy] || ''));
    },
    async listIds({ includeDeleted = false } = {}) {
      const records = await listVisible(includeDeleted);
      return records.map((record) => record.id);
    },
    async get(id, { includeDeleted = false } = {}) {
      const all = await loadAll();
      const found = all.find((record) => record.id === id);
      return found && (includeDeleted || !found.deleted) ? found : null;
    },
    async create(input) {
      const record = buildRecord(input);
      const all = await loadAll();
      all.push(record);
      await saveAll(all);
      logCreation(record);
      return record;
    },
    async update(id, patch) {
      return mutate(id, (record) => patchRecord(record, patch));
    },
    async remove(id) {
      await mutate(id, tombstoneRecord);
      return { id };
    },
    async mergeFromSync(records, options = {}) {
      if (!Array.isArray(records)) return { applied: false, count: 0 };
      const all = await loadAll();
      const byId = new Map(all.map((record) => [record.id, record]));
      let dirty = false;
      let count = 0;
      for (const remote of records) {
        const local = byId.get(remote?.id) || null;
        const applied = await applySyncRecord(local, remote, options, (next) => {
          byId.set(next.id, next);
          dirty = true;
        });
        if (applied) count += 1;
      }
      if (dirty) await saveAll([...byId.values()]);
      await flushBaseHashes();
      return { applied: count > 0, count };
    },
    async pruneTombstoned(olderThanMs) {
      if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
      const all = await loadAll();
      const survivors = [];
      const pruned = [];
      for (const record of all) {
        const ms = record.deleted ? Date.parse(record.deletedAt || '') : NaN;
        if (Number.isFinite(ms) && ms < olderThanMs) pruned.push(record.id);
        else survivors.push(record);
      }
      if (pruned.length === 0) return { pruned: 0 };
      await saveAll(survivors);
      await evictBaseHashes(pruned);
      return { pruned: pruned.length };
    },
  };
}
