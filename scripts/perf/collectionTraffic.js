/** CDP accounting for the synthetic audit. Never retains URLs, headers or bodies. */
export function endpointFor(rawUrl) {
  const { pathname, protocol } = new URL(rawUrl);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) return '/non-http';
  if (pathname.startsWith('/assets/')) return '/assets/:asset';
  if (pathname.startsWith('/data/')) return '/data/:asset';
  if (/^\/api\/video-gen\/history\/[^/]+$/.test(pathname)) return '/api/video-gen/history/:record';
  if (/^\/api\/messages\/[^/]+\/[^/]+$/.test(pathname)) return '/api/messages/:account/:message';
  // Collection endpoints and bootstrap paths contain no record identifiers.
  return pathname.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, ':account')
    .replace(/synthetic-[^/]+/g, ':record');
}

const empty = () => ({ requests: 0, completed: 0, failed: 0, canceled: 0,
  encodedBytes: 0, decodedBytes: 0, unavailable: 0, socketSentFrames: 0,
  socketReceivedFrames: 0, socketSentBytes: 0, socketReceivedBytes: 0 });

export function createTrafficAccumulator() {
  const phases = new Map();
  const requests = new Map();
  const sockets = new Map();
  let phase = 'cold';
  const bucket = (endpoint, target = phase) => {
    if (!phases.has(target)) phases.set(target, new Map());
    const entries = phases.get(target);
    if (!entries.has(endpoint)) entries.set(endpoint, empty());
    return entries.get(endpoint);
  };
  const finish = (id, encoded, failed, canceled) => {
    const request = requests.get(id);
    if (!request) return;
    const row = bucket(request.endpoint);
    // dataReceived encoded lengths are provisional. loadingFinished is the
    // authoritative total (including headers); add only the uncounted remainder.
    row.encodedBytes += Math.max(0, (encoded || 0) - request.encoded);
    row[failed ? 'failed' : 'completed']++;
    if (canceled) row.canceled++;
    requests.delete(id);
  };
  return {
    setPhase(name) { phase = name; },
    event(name, event) {
      const id = event.requestId;
      if (name === 'requestWillBeSent') {
        if (event.redirectResponse) finish(id, event.redirectResponse.encodedDataLength, false, false);
        const endpoint = endpointFor(event.request.url);
        requests.set(id, { endpoint, encoded: 0 });
        bucket(endpoint).requests++;
      } else if (name === 'responseReceived') {
        const request = requests.get(id);
        if (request) {
          const row = bucket(request.endpoint);
          if (event.response.status === 503) row.unavailable++;
          const headers = Math.max(0, event.response.encodedDataLength || 0);
          row.encodedBytes += headers;
          request.encoded += headers;
        }
      } else if (name === 'dataReceived') {
        const request = requests.get(id);
        if (!request) return;
        const encoded = Math.max(0, event.encodedDataLength || 0);
        const row = bucket(request.endpoint);
        row.decodedBytes += Math.max(0, event.dataLength || 0);
        row.encodedBytes += encoded;
        request.encoded += encoded;
      } else if (name === 'loadingFinished') finish(id, event.encodedDataLength, false, false);
      else if (name === 'loadingFailed') finish(id, 0, true, event.canceled);
      else if (name === 'webSocketCreated') sockets.set(id, endpointFor(event.url));
      else if (name === 'webSocketClosed') sockets.delete(id);
      else if (name === 'webSocketFrameSent' || name === 'webSocketFrameReceived') {
        const row = bucket(sockets.get(id) || '/socket.io/');
        const direction = name === 'webSocketFrameSent' ? 'Sent' : 'Received';
        const { opcode, payloadData } = event.response;
        row['socket' + direction + 'Frames']++;
        row['socket' + direction + 'Bytes'] += opcode === 1
          ? Buffer.byteLength(payloadData, 'utf8') : Buffer.from(payloadData, 'base64').length;
      }
    },
    snapshot() {
      return Object.fromEntries([...phases].map(([name, endpoints]) => [name,
        Object.fromEntries([...endpoints].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, { ...value }]))]));
    },
    pending() { return requests.size; },
  };
}

/** Transient payload inspection returns only counts and contract failures. */
export function inspectCollection(endpoint, query, payload, bytes, cardinalities) {
  const failures = [];
  const fail = reason => failures.push({ endpoint, reason, bytes });
  const media = endpoint === '/api/image-gen/gallery';
  const rows = media ? payload?.items : payload?.messages;
  const pageLimit = media ? 60 : 50;
  const total = media ? cardinalities.images + cardinalities.videos - cardinalities.hiddenImages - cardinalities.hiddenVideos : cardinalities.messages;
  if (!Array.isArray(rows)) { fail('unpaged-response'); return { count: 0, failures }; }
  if (query.get('summary') !== 'true') fail('missing-summary-projection');
  if (rows.length > pageLimit || payload.total !== total) fail('page-limit-or-total');
  if (bytes > pageLimit * 2048) fail('list-byte-budget');
  if (media && payload.hiddenTotal !== cardinalities.hiddenImages + cardinalities.hiddenVideos) fail('hidden-total');
  for (const item of rows) {
    const row = media ? item.data : item;
    if (!row || (media && !['image', 'video'].includes(item.kind))) { fail('invalid-row'); break; }
    if (media && (row.hidden || /synthetic-(image|video)-\d*0(?:\.|$)/.test(row.filename || ''))) { fail('hidden-row'); break; }
    if ((media && (row.prompt?.length > 512 || row.negativePrompt?.length > 512))
        || (!media && ('bodyText' in row || 'bodyHtml' in row || row.evaluation?.reasoning))) {
      fail('eager-detail-fields'); break;
    }
  }
  return { count: rows.length, failures };
}

export function trafficFailures(phases) {
  const failures = [];
  for (const [phase, endpoints] of Object.entries(phases)) {
    for (const [endpoint, row] of Object.entries(endpoints)) {
      if (['sibling', 'idle'].includes(phase) && endpoint === '/api/messages/inbox' && row.requests) {
        failures.push({ endpoint, reason: 'sibling-inbox-fetch', count: row.requests, bytes: row.encodedBytes });
      }
      if (phase === 'cold' && ['/api/messages/:account/:message', '/api/video-gen/history/:record', '/api/image-gen/:record/variants'].includes(endpoint) && row.requests) {
        failures.push({ endpoint, reason: 'eager-detail-request', count: row.requests, bytes: row.encodedBytes });
      }
      if (['/api/video-gen/history', '/api/image-gen/history'].includes(endpoint) && row.requests) {
        failures.push({ endpoint, reason: 'full-history-fetch', count: row.requests, bytes: row.encodedBytes });
      }
    }
  }
  return failures;
}
