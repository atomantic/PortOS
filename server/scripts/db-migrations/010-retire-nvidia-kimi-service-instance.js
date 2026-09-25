/**
 * Remove the orphaned NVIDIA Kimi service instance after its shipped preset
 * was retired by file migration 402. A matching provider in providers.json or
 * any saved route that still exists in that file keeps the instance intact.
 *
 * This is DB-side because `ai_connections` is machine-local Postgres state;
 * the legacy file migration cannot remove it. The installed provider document
 * is the input gate, and the migration deliberately ships no data seed.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPlainObject } from '../../lib/objects.js';
import { PATHS } from '../../lib/paths.js';

const DEFAULT_PROVIDERS_PATH = join(PATHS.data, 'providers.json');
const RETIRED_SERVICE = Object.freeze({
  slug: 'nvidia-kimi',
  definitionId: 'nvidia-nim',
  kind: 'gateway:nvidia-nim',
});

async function readProviders(providersPath) {
  let contents;
  try {
    contents = await readFile(providersPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error('Cannot read data/providers.json for NVIDIA Kimi service retirement');
  }

  let document;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error('Cannot parse data/providers.json for NVIDIA Kimi service retirement');
  }
  if (!isPlainObject(document) || !isPlainObject(document.providers)) {
    throw new Error('data/providers.json has no valid providers object for NVIDIA Kimi service retirement');
  }
  return document.providers;
}

const providerStillUsesService = (providers) => (
  Object.hasOwn(providers, RETIRED_SERVICE.slug)
  || Object.values(providers).some((provider) => provider?.serviceId === RETIRED_SERVICE.slug)
);

/**
 * Retire only an unused instance from the old shipped composition. Other
 * providers may have been explicitly linked onto this service, so routes
 * whose ids still exist in the provider document preserve the whole instance.
 */
export async function up(client, { providersPath = DEFAULT_PROVIDERS_PATH } = {}) {
  const providers = await readProviders(providersPath);
  if (!providers) {
    console.log('🧹 NVIDIA Kimi service retirement: provider file absent, skipped');
    return { removed: 0, skipped: 'provider-file-absent' };
  }
  if (providerStillUsesService(providers)) {
    return { removed: 0, skipped: 'provider-still-configured' };
  }

  const { rows: candidates } = await client.query(
    `SELECT id
       FROM ai_connections
      WHERE slug = $1 AND definition_id = $2 AND kind = $3
      FOR UPDATE`,
    [RETIRED_SERVICE.slug, RETIRED_SERVICE.definitionId, RETIRED_SERVICE.kind],
  );

  let removed = 0;
  for (const { id } of candidates) {
    const { rows: routes } = await client.query(
      `SELECT route.provider_id
         FROM ai_route_bindings AS route
         JOIN ai_harness_bindings AS binding ON binding.id = route.binding_id
        WHERE binding.connection_id = $1
        FOR UPDATE OF route, binding`,
      [id],
    );
    if (routes.some(({ provider_id }) => Object.hasOwn(providers, provider_id))) continue;

    await client.query(
      `DELETE FROM ai_route_bindings AS route
       USING ai_harness_bindings AS binding
       WHERE route.binding_id = binding.id AND binding.connection_id = $1`,
      [id],
    );
    await client.query('DELETE FROM ai_harness_bindings WHERE connection_id = $1', [id]);
    const deleted = await client.query(
      `DELETE FROM ai_connections
        WHERE id = $1 AND slug = $2 AND definition_id = $3 AND kind = $4
        RETURNING id`,
      [id, RETIRED_SERVICE.slug, RETIRED_SERVICE.definitionId, RETIRED_SERVICE.kind],
    );
    removed += deleted.rows.length;
  }

  if (removed > 0) {
    console.log(`🧹 NVIDIA Kimi service retirement: removed ${removed} unused service instance${removed === 1 ? '' : 's'}`);
  }
  return { removed, skipped: null };
}

export default { up };
