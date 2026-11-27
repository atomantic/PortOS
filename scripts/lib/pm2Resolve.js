/** Resolves the server-owned PM2 CLI and API for top-level scripts, before or after install. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
const PM2_DIR_PATH = 'server/node_modules/pm2';
export const PM2_BIN_PATH = `${PM2_DIR_PATH}/bin/pm2`;
export const PM2_BIN = fileURLToPath(new URL(`../../${PM2_BIN_PATH}`, import.meta.url));
export const PM2_DIR = fileURLToPath(new URL(`../../${PM2_DIR_PATH}`, import.meta.url));

export async function importPm2() {
  return serverRequire('./node_modules/pm2');
}
