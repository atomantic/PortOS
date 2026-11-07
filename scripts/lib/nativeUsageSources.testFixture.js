import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeMessage } from '../../server/lib/protobufWire.js';
import { buildNativeUsageReport } from '../../server/lib/nativeUsageContract.js';
import { buildNativeUsageStage } from '../../server/lib/nativeUsageStaging.js';
import { getNativeTranscriptCoverage } from '../../server/services/nativeTranscriptCoverage.js';
import { getNativeGrokUsageCoverage } from '../../server/services/nativeGrokUsageCoverage.js';
import { getNativeAgyUsageCoverage } from '../../server/services/nativeAgyUsageCoverage.js';
import { GROK_USAGE_FIELDS } from '../../server/lib/nativeGrokUsageRecords.js';

export const roles = ['codexSessions', 'codexArchivedSessions', 'claudeProjects', 'grokSessions', 'agyCliConversations', 'agyLegacyBrain', 'agyAppConversations', 'agyIdeConversations'];
export const limits = { bytes: 10000000, lineBytes: 1000000, entries: 1000, records: 1000, milliseconds: 30000, depth: 16 };
export const json = value => JSON.stringify(value, null, 2) + '\n';
export async function put(root, name, value) {
  const target = join(root, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.isBuffer(value) || typeof value === 'string' ? value : json(value));
}
export async function inventory(root, prefix = '') {
  const files = {}; const directories = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isDirectory()) {
      directories.push(name);
      const nested = await inventory(join(root, item.name), name + '/');
      Object.assign(files, nested.files); directories.push(...nested.directories);
    } else files[name] = await readFile(join(root, item.name));
  }
  return { files, directories: directories.sort() };
}
const claude = (id, output, final = true) => ({ type: 'assistant', timestamp: '2026-03-01T00:00:00Z', requestId: `private-request-${id}`,
  message: { id, model: 'private-model', stop_reason: final ? 'end_turn' : null, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } });
const turn = costUsdTicks => ({ turnNumber: 1, endedAt: '2026-03-01T00:00:00Z', inputTokens: 10, outputTokens: 5,
  cachedReadTokens: 3, cacheCreationTokens: 0, reasoningTokens: 2, totalTokens: 15, modelCalls: 1, turnCount: 1,
  costUsdTicks, primaryModelId: 'private-model', modelUsage: {} });
const snapshot = (sessionId, turns) => ({ sessionId, updatedAt: '2026-03-01T00:00:00Z', turns,
  session: { ...Object.fromEntries(GROK_USAGE_FIELDS.map(field => [field, turns.reduce((sum, row) => sum + row[field], 0)])),
    turnCount: turns.length, costUsdTicks: turns.reduce((sum, row) => sum + row.costUsdTicks, 0) } });
async function database(path) {
  const usageSchema = Object.fromEntries([
    ['model', 1, 'varint'], ['inputTokens', 2, 'varint'], ['outputTokens', 3, 'varint'], ['cacheWriteTokens', 4, 'varint'],
    ['cacheReadTokens', 5, 'varint'], ['apiProvider', 6, 'varint'], ['messageId', 7, 'string'],
    ['thinkingOutputTokens', 9, 'varint'], ['responseOutputTokens', 10, 'varint'], ['responseId', 11, 'string'],
  ].map(([name, no, type]) => [name, { no, type }]));
  const timestamp = { seconds: { no: 1, type: 'varint' } };
  const schema = { created: { no: 1, type: 'message', schema: timestamp }, completed: { no: 8, type: 'message', schema: timestamp },
    usage: { no: 9, type: 'message', schema: usageSchema } };
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0,
      has_subtrajectory NUMERIC NOT NULL DEFAULT false, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB,
      render_info BLOB, step_payload BLOB, step_format INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0); PRAGMA user_version=1;`);
    db.prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id) VALUES (?, ?)').run('private-trajectory', 'private-native');
    for (const [index, type] of [15, 23].entries()) {
      const blob = encodeMessage(schema, { created: { seconds: 1772323200 }, completed: { seconds: 1772323201 }, usage: {
        model: 342, apiProvider: 24, inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 100,
        thinkingOutputTokens: 3, responseOutputTokens: 2, messageId: `private-message-${index}`, responseId: `private-response-${index}` } });
      db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_format) VALUES (?, ?, ?, ?, ?)').run(index, type, 3, blob, 0);
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(index, blob, blob.length);
    }
  } finally { db.close(); }
}
export async function populate(root, { legacyOnly = false } = {}) {
  for (const role of roles) await mkdir(join(root, role, 'private-empty/nested'), { recursive: true });
  await put(root, 'codexSessions/private-rollout.jsonl', '{"tokens":999999,"private":"raw-account-unverified"}\n');
  await put(root, 'codexArchivedSessions/private-archive.bin', Buffer.from([0, 255, 17]));
  await put(root, 'claudeProjects/private-project/session.jsonl', [claude('stream', 2, false), claude('stream', 9), claude('conflict', 5)].map(JSON.stringify).join('\n') + '\n');
  await put(root, 'claudeProjects/private-project/copy.jsonl', json(claude('conflict', 7)).replaceAll('\n', '') + '\n');
  await put(root, 'grokSessions/private-project/one/usage.json', snapshot('private-session', [turn(123)]));
  await put(root, 'grokSessions/private-project/copy/usage.json', snapshot('private-session', [turn(456)]));
  await put(root, 'grokSessions/private-project/empty/usage.json', snapshot('private-empty-session', []));
  await put(root, 'grokSessions/private-project/one/updates.jsonl', '{"private":"raw transcript","totalTokens":999999}\n');
  await put(root, 'agyLegacyBrain/private-session/.system_generated/logs/transcript.jsonl', '{"type":"PLANNER_RESPONSE","input_tokens":999999}\n');
  await put(root, 'agyAppConversations/private-app.pb', Buffer.from([0, 128, 255, 42]));
  await put(root, 'agyIdeConversations/private-ide.pb', Buffer.alloc(0));
  await put(root, 'agyIdeConversations/private-future.opaque', Buffer.from([1, 3, 255]));
  if (!legacyOnly) await database(join(root, 'agyCliConversations/private-native.db'));
}
export async function capture(root) {
  return buildNativeUsageReport({ instanceId: 'source-host', capturedAt: '2026-03-02T00:00:00.000Z', scanLimits: limits,
    codexEvidence: { runtimeVersion: '0.166.0', accountBefore: { status: 'read', account: { authMethod: 'chatgpt', planType: 'plus' } },
      accountAfter: { status: 'read', account: { authMethod: 'chatgpt', planType: 'plus' } },
      usage: { summary: { lifetimeTokens: 100 }, dailyUsageBuckets: [{ startDate: '2026-03-01', tokens: 40 }] } },
    transcripts: {
      claude: await getNativeTranscriptCoverage('claude', { projectsRoot: join(root, 'claudeProjects'), limits, includeRecords: true }),
      grok: await getNativeGrokUsageCoverage({ sessionsRoot: join(root, 'grokSessions'), limits }),
      agy: await getNativeAgyUsageCoverage({ cliConversationsRoot: join(root, 'agyCliConversations'), legacyBrainRoot: join(root, 'agyLegacyBrain'),
        appConversationsRoot: join(root, 'agyAppConversations'), ideConversationsRoot: join(root, 'agyIdeConversations'), limits }),
    } });
}
export async function prepare(dir, options = {}) {
  const source = join(dir, 'detached');
  await mkdir(source);
  if (!options.absent) await populate(source, options);
  if (options.legacyOnly) await rm(join(source, 'agyCliConversations'), { recursive: true });
  const report = await capture(source);
  const stage = buildNativeUsageStage({ reports: [report], request: { version: 1, participants: [report.participantKey],
    selections: [{ family: 'codex', accountLabel: 'account-a', members: [report.participantKey], authoritativeParticipant: report.participantKey }] } });
  const request = { version: 1, participantKey: report.participantKey, reportHash: report.contentHash,
    roles: Object.fromEntries(roles.map(role => [role, options.absent ? 'absent-from-detached-input' : 'provided'])) };
  if (options.legacyOnly) request.roles.agyCliConversations = 'absent-from-detached-input';
  const stagePath = join(dir, 'stage.json'); const requestPath = join(dir, 'request.json');
  await writeFile(stagePath, json(stage)); await writeFile(requestPath, json(request));
  return { source, report, stage, request, stagePath, requestPath, bundle: join(dir, 'bundle'), restored: join(dir, 'restored') };
}
