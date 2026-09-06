/**
 * The harness registry lives in two places by architecture: the browser cannot
 * import server code, so `client/src/utils/providerHarnesses.js` carries its own
 * id→label table. This suite pins the two together, so a harness added to the
 * server registry can never render as a bare id in the connection management UI
 * — and a harness REMOVED from the server can never linger as a label the
 * browser still offers.
 *
 * The client copy is read with `readFileSync` and parsed out of the source,
 * never imported, so the client's dependency tree stays out of the server CI
 * job (`server/vitest.config.js` globs this directory).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PROVIDER_HARNESSES } from './providerHarnesses.js';
import { stripCommentsAndNormalize } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = resolve(__dirname, '../../client/src/utils/providerHarnesses.js');

// The whole normalized declaration, ANCHORED: a scan for `key: 'value'` pairs
// anywhere in the file would keep reading row literals out of a table that had
// been wrapped in a transform and report a registry that no longer exists as
// intact. Anchoring makes an unrecognized shape fail closed instead.
const TABLE_RE = /^(?:export\s+)?const\s+PROVIDER_HARNESS_LABELS\s*=\s*Object\.freeze\(\s*\{(.*)\}\s*\)\s*;$/;
// One `id: 'Label'` entry at the head of the remaining body, plus its separator.
// Escapes are rejected outright — no harness label has one, and decoding them by
// inspection is how a parser starts guessing.
const NEXT_ENTRY_RE = /^(\w+)\s*:\s*'([^'\\]*)'\s*(?:,\s*)?/;

/** The client's mirrored table as a plain object, or null when it isn't a static one. */
function parseClientLabels(source) {
  const declaration = stripCommentsAndNormalize(source)
    .split(';')
    .map((statement) => `${statement.trim()};`)
    .find((statement) => TABLE_RE.test(statement));
  if (!declaration) return null;

  const labels = {};
  let rest = TABLE_RE.exec(declaration)[1].trim();
  while (rest.length > 0) {
    const match = NEXT_ENTRY_RE.exec(rest);
    if (!match) return null;
    labels[match[1]] = match[2];
    rest = rest.slice(match[0].length);
  }
  return labels;
}

describe('provider harness registry parity', () => {
  const clientLabels = parseClientLabels(readFileSync(CLIENT_PATH, 'utf8'));

  it('parses the browser mirror as a static table', () => {
    expect(clientLabels).not.toBeNull();
  });

  it('mirrors every server harness id and label, and adds none', () => {
    expect(clientLabels).toEqual(
      Object.fromEntries(PROVIDER_HARNESSES.map((harness) => [harness.id, harness.label])),
    );
  });

  // A guard that cannot fail is not a guard. These pin the parser itself:
  // real drift has to be DETECTED, and an unparseable table has to fail closed
  // rather than silently compare an empty registry against an empty one.
  it('detects a drifted label', () => {
    const drifted = parseClientLabels(
      readFileSync(CLIENT_PATH, 'utf8').replace("claude: 'Claude Code'", "claude: 'Claude'"),
    );
    expect(drifted).not.toEqual(
      Object.fromEntries(PROVIDER_HARNESSES.map((harness) => [harness.id, harness.label])),
    );
  });

  it('fails closed on a table it cannot read statically', () => {
    expect(parseClientLabels(
      "export const PROVIDER_HARNESS_LABELS = Object.freeze({ ...someOtherTable });",
    )).toBeNull();
  });
});
