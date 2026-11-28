/** Tighten existing personal stores in place, including legacy atomic-write remnants. */
import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const stores = {
  files: /^(imessage|signal)-sync-state\.json$/,
  dirs: {
    messages: { files: /^(accounts|drafts)\.json$/, dirs: { cache: { files: /\.json$/ } } },
    calendar: { files: /^accounts\.json$/, dirs: { cache: { files: /\.json$/ } } },
    health: { files: /^\d{4}-\d{2}-\d{2}\.json$/ },
    meatspace: { files: /^(blood-tests|config|daily-log|epigenetic-tests|eyes|health-metrics|workouts)\.json$/ },
    insights: { files: /^(narrative|themes)\.json$/ },
    'ask-conversations': { files: /\.json$/ },
    'digital-twin': { files: /\.md$/i, dirs: { autobiography: { files: /^(config|stories)\.json$/ } } },
  },
};

const atomicSuffix = /\.\d+\.\d+\.[0-9a-f-]{36}\.tmp$/i;
async function metadata(path) {
  return lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function restrict(path, info, allowedMode) {
  // Preserve existing owner restrictions and remove special, group and other bits.
  const next = info.mode & allowedMode;
  if ((info.mode & 0o7777) !== next) await chmod(path, next);
}

async function repair(directory, store, uid) {
  const info = await metadata(directory);
  // lstat keeps this walk inside real, operator-owned store directories.
  if (!info?.isDirectory() || info.uid !== uid) return;
  await restrict(directory, info, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !store.files.test(entry.name.replace(atomicSuffix, ''))) continue;
    const path = join(directory, entry.name);
    const file = await metadata(path);
    if (file?.isFile() && file.uid === uid && file.nlink === 1) await restrict(path, file, 0o600);
  }
  for (const [name, substore] of Object.entries(store.dirs ?? {})) {
    await repair(join(directory, name), substore, uid);
  }
}

export async function repairPrivateStores({ rootDir, platform = process.platform, uid = process.getuid?.() }, storeTree) {
  if (platform === 'win32' || uid === undefined) return;
  await repair(join(rootDir, 'data'), storeTree, uid);
}

export default {
  up: context => repairPrivateStores(context, stores),
};
