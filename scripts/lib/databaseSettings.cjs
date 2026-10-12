/** Dependency-free database configuration shared by pre-install setup, PM2 and db.sh. */
function parsePort(value, fallback) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return fallback;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function firstPort(...values) {
  return values.map(value => parsePort(value)).find(port => port !== undefined);
}

function resolveDatabaseSettings({ env = process.env, saved = {} } = {}) {
  const value = (key, fallback) => env[key] || saved[key] || fallback;
  // PGPORT in a managed process names its active pool. The inherited native
  // identity must win when that process reloads configuration or provisions native.
  const selectedNativePort = firstPort(env.PORTOS_NATIVE_PGPORT, env.PGPORT, saved.PGPORT);
  const nativePort = selectedNativePort ?? 5432;
  const dockerPort = firstPort(env.PGPORT_DOCKER, saved.PGPORT_DOCKER) ?? 5561;
  const mode = value('PGMODE', 'docker');
  return {
    mode, user: value('PGUSER', 'portos'), database: value('PGDATABASE', 'portos'),
    password: value('PGPASSWORD', 'portos'), host: value('PGHOST', 'localhost'),
    selectedHost: value('PGHOST', ''), selectedNativePort,
    nativePort, dockerPort, port: mode === 'native' ? nativePort : dockerPort,
  };
}

module.exports = { parsePort, resolveDatabaseSettings };
