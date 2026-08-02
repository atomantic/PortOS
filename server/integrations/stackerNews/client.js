import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';

const ENDPOINT = 'https://stacker.news/api/graphql';
const TIMEOUT_MS = 12_000;
const MAX_READ_ATTEMPTS = 2;

const text = (value, label, max = 2_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value.trim();
};
const optionalText = (value, max = 40_000) => typeof value === 'string' ? value.slice(0, max) : '';
const positiveInt = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;

// Closed, typed registry. Neither callers nor model output can supply a query,
// endpoint, header, or arbitrary variable. Mutations are deliberately not
// retried because Stacker News does not expose a caller idempotency token.
const OPERATIONS = Object.freeze({
  me: {
    kind: 'read',
    query: 'query PortosStackerMe { me { id name } }',
    variables: () => ({}),
  },
  sub: {
    kind: 'read',
    query: 'query PortosStackerSub($name: String!) { sub(name: $name) { name userId baseCost postsSatsFilter replyCost postTypes status nsfw } }',
    variables: ({ name }) => ({ name: text(name, 'territory name', 120) }),
  },
  items: {
    kind: 'read',
    query: 'query PortosStackerItems($sub: String!, $cursor: String, $limit: Int) { items(sub: $sub, sort: "recent", cursor: $cursor, limit: $limit) { cursor items { id createdAt updatedAt title text url parentId user { name } subName } } }',
    variables: ({ sub, cursor = null, limit = 30 }) => ({
      sub: text(sub, 'territory name', 120),
      cursor: cursor == null ? null : text(cursor, 'cursor', 400),
      limit: positiveInt(limit, 30, 100),
    }),
  },
  createDiscussion: {
    kind: 'write',
    query: 'mutation PortosCreateDiscussion($subNames: [String!]!, $title: String!, $text: String) { upsertDiscussion(subNames: $subNames, title: $title, text: $text) { id payInType payInState item { id } } }',
    variables: ({ sub, title, body = '' }) => ({
      subNames: [text(sub, 'territory name', 120)],
      title: text(title, 'post title', 200),
      text: optionalText(body),
    }),
  },
  createComment: {
    kind: 'write',
    query: 'mutation PortosCreateComment($parentId: ID!, $text: String!) { upsertComment(parentId: $parentId, text: $text) { id payInType payInState item { id } } }',
    variables: ({ parentId, body }) => ({
      parentId: text(String(parentId || ''), 'parent item ID', 200),
      text: text(body, 'comment text', 40_000),
    }),
  },
});

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function executeStackerNewsOperation(name, input = {}, apiKey) {
  const operation = OPERATIONS[name];
  if (!operation) throw new Error(`Unsupported Stacker News operation: ${name}`);
  if (!apiKey) throw new Error('Stacker News API key is not configured');
  const variables = operation.variables(input);
  const attempts = operation.kind === 'read' ? MAX_READ_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchWithTimeout(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ query: operation.query, variables }),
    }, TIMEOUT_MS);
    const payload = await response.json().catch(() => ({}));
    if (response.ok && !payload.errors?.length) return payload.data;
    if (attempt < attempts && RETRYABLE_STATUS.has(response.status)) continue;
    throw new Error(payload.errors?.[0]?.message || `Stacker News request failed (${response.status})`);
  }
  throw new Error('Stacker News request failed');
}

export const stackerNewsOperations = Object.freeze(Object.keys(OPERATIONS));
export const stackerNewsCapabilities = Object.freeze({
  // `browserReads` is the DEFAULT read transport (see browserReader.js): SN
  // grants API keys only on request, so the key is an optional accelerator that
  // only reviewed writes require.
  browserReads: Object.freeze(['me', 'sub', 'items']),
  api: Object.freeze({ reads: ['me', 'sub', 'items'], reviewedWrites: ['createDiscussion', 'createComment'] }),
  browserHandoff: Object.freeze(['item', 'territory_settings', 'zap', 'downzap', 'boost']),
  unavailable: Object.freeze(['wallet_settlement', 'arbitrary_graphql', 'arbitrary_browser_script']),
});
