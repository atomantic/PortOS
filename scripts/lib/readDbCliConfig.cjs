/** Resolve the database settings consumed by db.sh without running a database command. */
const { join } = require('node:path');
const { parseEnvFile } = require('./envFile.cjs');
const { resolveDatabaseSettings, parsePort } = require('./databaseSettings.cjs');

function readDbCliConfig(root, action, env = process.env) {
  const saved = parseEnvFile(join(root, '.env'));
  const resolved = resolveDatabaseSettings({ saved, env });
  const nativeSetup = action === 'setup-native';
  // Ordinary CLI commands retain an explicit exported endpoint override, even in
  // Docker mode (offline maintenance uses this to address a selected cluster).
  const selectedPort = nativeSetup ? resolved.selectedNativePort : parsePort(env.PGPORT);
  return {
    PGMODE: resolved.mode, PGUSER: resolved.user,
    PGDATABASE: resolved.database, PGPASSWORD: resolved.password,
    PGHOST: resolved.host, SELECTED_PGHOST: resolved.selectedHost,
    PGPORT: String(selectedPort ?? (nativeSetup ? resolved.nativePort : resolved.port)),
    SELECTED_PGPORT: selectedPort === undefined ? '' : String(selectedPort),
    PGPORT_DOCKER: String(resolved.dockerPort),
  };
}

module.exports = readDbCliConfig;

if (require.main === module) {
  const settings = readDbCliConfig(process.argv[2], process.argv[3]);
  process.stdout.write(Object.entries({ ...settings, complete: '1' }).flat().join('\0') + '\0');
}
