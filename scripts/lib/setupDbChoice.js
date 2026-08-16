/**
 * Pure setup-db helpers. setup-db.js is a CLI entrypoint that runs on import,
 * so the menu/port resolvers live here and are imported by both the script and
 * its tests.
 */

/** Tolerate whitespace / junk in a .env port; fall back rather than leaking NaN. */
export function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseNativePort(value) {
  return parsePort(value, 5432);
}

export function parseDockerPort(value) {
  return parsePort(value, 5561);
}

/** Menu choice 2 = native Postgres; anything else (incl. 1 / empty) = docker. */
export function resolveStorageMenuChoice(answer) {
  return String(answer).trim() === '2' ? 'native' : 'exit';
}
