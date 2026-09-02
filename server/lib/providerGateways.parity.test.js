/**
 * The gateway registry exists in three places by architecture — the vendored
 * `aiToolkit/` may not import out of its own directory, and the browser cannot
 * import server code at all. This suite pins all three together so a new
 * gateway added to one is never silently missing from another (which would show
 * up as a wrapper that spawns fine but can never refresh its models, or a
 * gateway the server supports that no picker ever offers).
 *
 * The two SERVER copies are compared as VALUES — the toolkit module imports
 * cleanly here, so `toEqual` pins every field including `baseURL`.
 *
 * The client copy (`client/src/utils/providers.js`) is compared as TEXT: it is
 * read with `readFileSync` and its rows are parsed out of the source, never
 * imported, so the client's dependency tree stays out of the server CI job.
 * That comparison is deliberately field-scoped — the browser omits `baseURL`
 * and `legacyApiKeyField` (it never dials the gateway, and it never handles the
 * key), so `toEqual` against the server rows cannot be used. The fields it does
 * carry are all user-visible or dispatch-critical: `id` is the OpenCode
 * namespace AND the sibling-key lookup, `label` and `apiKeyEnv` are rendered in
 * the provider form, and `legacyMarker` is how a pre-registry stored record
 * still resolves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PROVIDER_GATEWAYS as SERVER_GATEWAYS } from './providerGateways.js';
import { PROVIDER_GATEWAYS as TOOLKIT_GATEWAYS, gatewayForProvider as toolkitGatewayFor } from './aiToolkit/internal/gateways.js';
import { gatewayForProvider as serverGatewayFor } from './providerGateways.js';
import { extractDeclaration, stripCommentsAndNormalize } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = resolve(__dirname, '../../client/src/utils/providers.js');

// The fields the browser copy carries, and the only ones it can be held to.
const CLIENT_FIELDS = ['id', 'label', 'apiKeyEnv', 'legacyMarker'];

const pickClientFields = (row) => Object.fromEntries(
  CLIENT_FIELDS.filter((field) => row[field] !== undefined).map((field) => [field, row[field]]),
);

// The whole normalized declaration, anchored: `export const PROVIDER_GATEWAYS =
// Object.freeze([ … ]);`. Anchoring is what makes an unrecognized shape fail
// closed — a scan for `{…}` anywhere in the declaration would keep reading the
// old row literals out of a table that had been wrapped in a transform, and
// report a registry that no longer exists as intact.
const TABLE_RE = /^(?:export\s+)?const\s+PROVIDER_GATEWAYS\s*=\s*Object\.freeze\(\s*\[(.*)\]\s*\)\s*;$/;
// One `Object.freeze({ … })` row at the head of the remaining array body, plus
// its trailing separator.
const NEXT_ROW_RE = /^Object\.freeze\(\s*\{([^{}]*)\}\s*\)\s*(?:,\s*)?/;
// One `key: 'value'` property at the head of the remaining row body, plus its
// trailing separator. Escapes are rejected outright — no gateway field has one,
// and decoding them by inspection is how a parser starts guessing.
const NEXT_ROW_FIELD_RE = /^(\w+)\s*:\s*'([^'\\]*)'\s*(?:,\s*)?/;

/**
 * Consume `text` with `nextRe` until nothing is left, collecting what each
 * match yields — or null the moment a leftover doesn't match.
 *
 * Failing closed on the leftover is the whole point: a `{ id: 'x', ...overrides }`
 * row, or a table wrapped in a helper, read by a scan-for-what-I-recognize pass
 * would compare equal to the static shape it stopped being, and the drift this
 * guard exists to catch would pass green.
 */
function consumeAll(text, nextRe, valueOf) {
  const collected = [];
  let rest = text.trim();
  while (rest.length > 0) {
    const match = nextRe.exec(rest);
    if (!match) return null;
    const value = valueOf(match, collected);
    if (value === null) return null;
    collected.push(value);
    rest = rest.slice(match[0].length);
  }
  return collected;
}

/** One registry row as a plain object, or null when it is not a static table. */
function parseGatewayRow(body) {
  const fields = consumeAll(body, NEXT_ROW_FIELD_RE, ([, key, value], seen) =>
    (seen.some(([existing]) => existing === key) ? null : [key, value]));
  return fields && Object.fromEntries(fields);
}

/**
 * A registry declaration's rows, or null when it — or any row in it — is no
 * longer a flat run of static literals. Anything more structural would mean
 * importing the module, which is the thing this file exists to avoid.
 */
function parseGatewayTable(declaration) {
  const table = TABLE_RE.exec(stripCommentsAndNormalize(declaration));
  return table && consumeAll(table[1], NEXT_ROW_RE, ([, body]) => parseGatewayRow(body));
}

/** `parseGatewayTable` over the browser copy's `PROVIDER_GATEWAYS`. */
function parseClientGatewayRows() {
  const declaration = extractDeclaration(readFileSync(CLIENT_PATH, 'utf8'), 'PROVIDER_GATEWAYS');
  return declaration == null ? null : parseGatewayTable(declaration);
}

describe('providerGateways ↔ aiToolkit/internal/gateways parity', () => {
  it('declares the same rows, in the same order', () => {
    expect(TOOLKIT_GATEWAYS).toEqual(SERVER_GATEWAYS);
  });

  it('resolves the same provider records', () => {
    const records = [
      { gatewayBacked: 'openrouter' },
      { gatewayBacked: 'orcarouter' },
      { orcarouterBacked: true },
      { ollamaBacked: true },
      { gatewayBacked: 'not-a-gateway' },
      null,
    ];
    for (const record of records) {
      expect(toolkitGatewayFor(record)).toEqual(serverGatewayFor(record));
    }
  });
});

describe('providerGateways ↔ client/src/utils/providers.js parity', () => {
  const clientRows = parseClientGatewayRows();

  it('the client declares a parseable PROVIDER_GATEWAYS table', () => {
    expect(
      clientRows,
      'client/src/utils/providers.js#PROVIDER_GATEWAYS is missing, or a row is no longer a flat table of static `key: \'value\'` properties — this guard cannot read it, so re-shape the row or teach the parser',
    ).not.toBeNull();
    expect(clientRows.length).toBeGreaterThan(0);
  });

  // The parser must refuse what it cannot see through, not skip it: a row that
  // pulls fields in at runtime would otherwise compare equal to the static row
  // it stopped being.
  it('refuses a row carrying anything but static single-quoted properties', () => {
    expect(parseGatewayRow("id: 'openrouter', label: 'OpenRouter'")).toEqual({ id: 'openrouter', label: 'OpenRouter' });
    expect(parseGatewayRow("id: 'openrouter', ...overrides")).toBeNull();
    expect(parseGatewayRow("id: 'openrouter', label: LABELS.openrouter")).toBeNull();
    expect(parseGatewayRow("id: 'openrouter', id: 'orcarouter'")).toBeNull();
  });

  // …and the table reader must refuse a declaration whose rows it can still
  // see but whose exported value they no longer are.
  it('refuses a table that is not a plain frozen array of frozen rows', () => {
    const rows = "Object.freeze({ id: 'openrouter', label: 'OpenRouter' })";
    expect(parseGatewayTable(`export const PROVIDER_GATEWAYS = Object.freeze([${rows}]);`))
      .toEqual([{ id: 'openrouter', label: 'OpenRouter' }]);
    expect(parseGatewayTable(`export const PROVIDER_GATEWAYS = Object.freeze([${rows}].map(withBaseURL));`)).toBeNull();
    expect(parseGatewayTable(`export const PROVIDER_GATEWAYS = Object.freeze([${rows}, ...EXTRA]);`)).toBeNull();
  });

  it('declares the same rows, in the same order (browser-visible fields)', () => {
    expect(
      clientRows,
      'the gateway registry diverged — server/lib/providerGateways.js is authoritative; port the row verbatim (minus baseURL / legacyApiKeyField, which the browser omits)',
    ).toEqual(SERVER_GATEWAYS.map(pickClientFields));
  });
});
