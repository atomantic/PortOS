import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';
import { PATHS } from '../lib/paths.js';
import { POOL_CONFIG } from '../lib/db.js';
import { assertDatabaseAdmission, databaseMaintenanceEndpointSchema } from '../lib/databaseMaintenanceJournal.js';
import { databaseMaintenancePreflightSchema } from '../lib/validation.js';
import { ServerError } from '../lib/errorHandler.js';
import { summarizeSystemActivity } from '../lib/systemIdle.js';

const require = createRequire(import.meta.url);
const refuse = (code, message) => new ServerError(message, { status: 409, code });
const unavailable = () => refuse('DATABASE_PREFLIGHT_UNTRUSTED', 'Database configuration or work state could not be verified.');
const stale = () => refuse('DATABASE_PREFLIGHT_STALE', 'Requested direction does not match the current database configuration and running pool.');
const busy = () => refuse('DATABASE_PREFLIGHT_BUSY', 'PortOS has active or queued work. Wait for it to finish before database maintenance.');
const count = z.number().int().nonnegative();
// The dashboard summarizer intentionally accepts partial snapshots. Maintenance
// cannot use a missing slice as proof that there are no writers in that domain.
const activitySchema = z.object({
  jobs: z.array(z.object({ status: z.enum(['running', 'queued']) })),
  extras: z.object({ imageTo3d: z.array(z.unknown()) }),
  agents: z.object({ trusted: z.literal(true), active: count, queued: count }),
  mind: z.object({ trusted: z.literal(true), thinking: z.boolean(), queued: count }),
  llm: z.object({ trusted: z.literal(true), active: count }),
  appOperations: z.array(z.unknown()),
  update: z.object({ inProgress: z.boolean() }),
  backup: z.object({ inProgress: z.boolean() }),
});
const normalizeHost = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase()) ? 'loopback' : host.toLowerCase();

function readConfiguration() {
  // Ecosystem exports are evaluated once by require. Re-evaluate on each read
  // so an operator's saved mode change cannot validate against cached settings.
  // Check readability separately: ecosystem's boot defaults deliberately mask
  // a failed .env read, which cannot be treated as evidence for a cutover.
  const envPath = join(PATHS.installRoot, '.env');
  let content;
  try { content = readFileSync(envPath, 'utf8'); } catch { throw unavailable(); }
  const configPath = join(PATHS.installRoot, 'ecosystem.config.cjs');
  let configuration;
  try {
    delete require.cache[require.resolve(configPath)];
    configuration = require(configPath);
  } catch { throw unavailable(); }
  const { DATABASE_MODE: mode, DATABASE_ENDPOINTS: endpoints } = configuration ?? {};
  const source = databaseMaintenanceEndpointSchema.safeParse(endpoints?.[mode]);
  const target = databaseMaintenanceEndpointSchema.safeParse(endpoints?.[mode === 'native' ? 'docker' : 'native']);
  if (!source.success || !target.success || source.data.mode !== mode || target.data.mode === mode) throw unavailable();
  if (normalizeHost(source.data.host) === normalizeHost(target.data.host) && source.data.port === target.data.port) throw stale();
  return { source: source.data, target: target.data, revision: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
}

function validateDirection(direction, configuration) {
  if (direction.source !== configuration.source.mode || direction.target !== configuration.target.mode
    || ['host', 'port', 'database', 'user'].some(key => configuration.source[key] !== POOL_CONFIG[key])) throw stale();
}

/** Non-mutating advice only; no operation token, reservation, or writer drain. */
export async function preflightDatabaseMaintenance(input) {
  const direction = databaseMaintenancePreflightSchema.parse(input);
  assertDatabaseAdmission();
  const initial = readConfiguration();
  validateDirection(direction, initial);
  // Keep heavy activity/CoS graphs off ordinary database admin imports. Use the
  // lifecycle-only reader, not GPU telemetry or external Ollama probes.
  const [snapshot, activeAgents, mindGuard] = await Promise.all([
    import('./activeProcessing.js'), import('./updatePreflight.js'),
  ]).then(([processing, preflight]) => Promise.all([
    processing.getSystemActivity(), preflight.countActiveCosAgents(), preflight.getPersistentMindImageWorkGuard(),
  ])).catch(() => { throw unavailable(); });
  const activity = activitySchema.safeParse(snapshot);
  if (!activity.success || !Number.isInteger(activeAgents) || activeAgents < 0
    || mindGuard?.trusted !== true || typeof mindGuard.safe !== 'boolean') throw unavailable();
  if (!summarizeSystemActivity(activity.data).idle || activeAgents > 0 || !mindGuard.safe) throw busy();
  // No await between the final fence/configuration checks and the response.
  // This narrows the observation race, but is deliberately NOT acceptance.
  assertDatabaseAdmission();
  const final = readConfiguration();
  validateDirection(direction, final);
  if (JSON.stringify(initial) !== JSON.stringify(final)) throw stale();
  return { source: direction.source, target: direction.target, advisory: true, accepted: false };
}
