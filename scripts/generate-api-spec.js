/**
 * Generate checked-in API contract artifacts.
 *
 * This is intentionally a build-time script. It imports only the dependency-
 * light registry/spec modules, never boots Express, reads settings, touches
 * the database, or invokes an AI/media provider.
 *
 * Outputs:
 *   docs/api/openapi.json       Full OpenAPI 3.1 registry contract.
 *   docs/api/portos-tools.min.json  Compact provider-neutral tool resource.
 *
 * Runtime docs remain exposure-aware at /api/api-docs/*.json. The checked-in
 * artifacts describe every statically registered operation so code generators
 * and tool adapters have a stable contract to build against.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiSpec, buildToolCallingResource } from '../server/lib/openapiSpec.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const outputDir = join(repoRoot, 'docs', 'api');
const spec = buildOpenApiSpec({}, { includeUnexposed: true, version: packageJson.version });
const resource = buildToolCallingResource(spec);

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`);
await writeFile(join(outputDir, 'portos-tools.min.json'), JSON.stringify(resource));

console.log(`📜 Generated OpenAPI (${Object.keys(spec.paths).length} paths) and tool resource (${resource.tools.length} tools)`);
