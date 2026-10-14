/** Compatibility API for setup callers; configuration is owned by the CJS resolver. */
import databaseSettings from './databaseSettings.cjs';

export const parsePort = databaseSettings.parsePort;
export const parseNativePort = value => parsePort(value, 5432);
export const parseDockerPort = value => parsePort(value, 5561);
