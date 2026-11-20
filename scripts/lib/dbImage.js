/**
 * The pgvector image the CI DB service and the live restore test run, read from
 * docker-compose.yml (the one file Dependabot's docker-compose ecosystem bumps)
 * so a digest refresh is a one-file change. CI obtains it by running this module
 * (`node scripts/lib/dbImage.js`); server/test/guards/repo/dbImageDigestPin.test.js fails if the
 * digest is ever copied into a second tracked file.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isDirectlyInvoked } from './directInvocation.js';

const COMPOSE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker-compose.yml');

/**
 * The PostgreSQL major every existing Docker volume was initialized with. A new
 * major cannot open an older data directory, so changing it is not a digest
 * refresh: it needs a dump/restore migration path in the same change
 * (docs/STORAGE.md, "PostgreSQL version updates").
 */
export const PINNED_DB_MAJOR = 17;

const DB_IMAGE_LINE = /^\s*image:\s*(pgvector\/pgvector:\S+)\s*$/m;

export const readPinnedDbImage = (composeText) => {
  const ref = composeText.match(DB_IMAGE_LINE)?.[1];
  if (!ref) throw new Error('docker-compose.yml has no pgvector/pgvector image line');
  return ref;
};

export const PINNED_DB_IMAGE = readPinnedDbImage(readFileSync(COMPOSE_PATH, 'utf8'));

if (isDirectlyInvoked(import.meta.url)) console.log(PINNED_DB_IMAGE);
