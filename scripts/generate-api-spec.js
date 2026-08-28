/**
 * Generate the checked-in, complete OpenAPI 3.0.3 and minimized tool artifacts.
 *
 * This build-only script imports dependency-light registries. It does not boot
 * Express, read live settings, touch the database, or invoke a provider.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInternalOpenApiSpec, buildToolCallingResource } from '../server/lib/openapiSpec.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const outputDir = join(repoRoot, 'docs', 'api');
const spec = buildInternalOpenApiSpec({}, { version: packageJson.version });
const resource = buildToolCallingResource(spec);

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`);
await writeFile(join(outputDir, 'portos-tools.min.json'), `${JSON.stringify(resource)}\n`);

console.log(`📜 Generated OpenAPI (${Object.keys(spec.paths).length} paths) and tool resource (${resource.tools.length} tools)`);
