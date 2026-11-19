/**
 * Chief of Staff config keys that no longer have a reader: `RETIRED_CONFIG_KEYS`.
 *
 * Older config.json files may still carry them. cosState drops them on read (so the next save
 * purges them) and the strict config update schema accepts and discards them for cached clients.
 */
export const RETIRED_CONFIG_KEYS = Object.freeze([
  'rehabilitationGracePeriodDays',
  'autoFixThresholds',
  'goalsFile',
  'maxProcessMemoryMb',
  'mcpServers',
]);
