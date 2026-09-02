import { request } from './apiCore.js';

// Brain - Second Brain Feature
export const getBrainSummary = (options) => request('/brain/summary', options);
export const getBrainSettings = (options) => request('/brain/settings', options);
export const updateBrainSettings = (settings, options = {}) => request('/brain/settings', {
  method: 'PUT',
  body: JSON.stringify(settings),
  ...options
});

// Brain - Capture & Inbox
// `repoIntake` ({ malwareScan, learn, targetAppId, studyContext, providerId,
// model, effort }) is the capture box's post-clone agent opt-in; the server
// ignores it unless the text is a bare repository URL. Provider pins apply to
// the optional repo study only. `note` is saved on a bare-URL link.
export const captureBrainThought = (text, providerOverride, modelOverride, { creative, repoIntake, note } = {}, options = {}) => request('/brain/capture', {
  method: 'POST',
  body: JSON.stringify({ text, providerOverride, modelOverride, creative, repoIntake, note }),
  ...options
});
export const getBrainInbox = (options = {}) => {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  // Forward request-level options (e.g. { silent: true }) so background pollers can opt out
  // of the default error toast. `silent` is the only request-level flag the helper reads;
  // the rest of `options` is query params handled above.
  return request(`/brain/inbox?${params}`, { silent: options.silent });
};
export const resolveBrainReview = (inboxLogId, destination, editedExtracted, options = {}) => request('/brain/review/resolve', {
  method: 'POST',
  body: JSON.stringify({ inboxLogId, destination, editedExtracted }),
  ...options
});
export const fixBrainClassification = (inboxLogId, newDestination, updatedFields, note, options = {}) => request('/brain/fix', {
  method: 'POST',
  body: JSON.stringify({ inboxLogId, newDestination, updatedFields, note }),
  ...options
});
export const retryBrainClassification = (id, providerOverride, modelOverride, options = {}) => request(`/brain/inbox/${id}/retry`, {
  method: 'POST',
  body: JSON.stringify({ providerOverride, modelOverride }),
  ...options
});
export const updateBrainInboxEntry = (id, capturedText, options = {}) => request(`/brain/inbox/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ capturedText }),
  ...options
});
export const deleteBrainInboxEntry = (id, options = {}) => request(`/brain/inbox/${id}`, { method: 'DELETE', ...options });
export const markBrainInboxDone = (id, options = {}) => request(`/brain/inbox/${id}/done`, { method: 'POST', ...options });
// Stamp a batch of creative notes as consumed once their catalog ingest commits.
export const markBrainInboxSentToCatalog = (ids, options) => request('/brain/inbox/sent-to-catalog', {
  method: 'POST',
  body: JSON.stringify({ ids }),
  ...options
});

// Brain - People
export const getBrainPeople = () => request('/brain/people');
export const getBrainPerson = (id) => request(`/brain/people/${id}`);
export const createBrainPerson = (data, options = {}) => request('/brain/people', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainPerson = (id, data, options = {}) => request(`/brain/people/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainPerson = (id, options = {}) => request(`/brain/people/${id}`, { method: 'DELETE', ...options });

// Brain - Projects
export const getBrainProjects = (filters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  return request(`/brain/projects?${params}`);
};
export const getBrainProject = (id) => request(`/brain/projects/${id}`);
export const createBrainProject = (data, options = {}) => request('/brain/projects', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainProject = (id, data, options = {}) => request(`/brain/projects/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainProject = (id, options = {}) => request(`/brain/projects/${id}`, { method: 'DELETE', ...options });

// Brain - Ideas
export const getBrainIdeas = (filters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  return request(`/brain/ideas?${params}`);
};
export const getBrainIdea = (id) => request(`/brain/ideas/${id}`);
export const createBrainIdea = (data, options = {}) => request('/brain/ideas', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainIdea = (id, data, options = {}) => request(`/brain/ideas/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainIdea = (id, options = {}) => request(`/brain/ideas/${id}`, { method: 'DELETE', ...options });

// Brain - machine-local IdeaLoom lists. These deliberately use a separate
// endpoint and record shape from native Brain ideas: list ordering and sync
// metadata must never be flattened into the federated idea model.
export const getIdeaLoomSettings = (options = {}) => request('/brain/ideas/idealoom/settings', options);
export const updateIdeaLoomSettings = (data, options = {}) => request('/brain/ideas/idealoom/settings', {
  method: 'PUT', body: JSON.stringify(data), ...options
});
export const getIdeaLoomLists = (options = {}) => request('/brain/ideas/idealoom/lists', options);
export const createIdeaLoomList = (data, options = {}) => request('/brain/ideas/idealoom/lists', {
  method: 'POST', body: JSON.stringify(data), ...options
});
export const updateIdeaLoomList = (id, data, options = {}) => request(`/brain/ideas/idealoom/lists/${id}`, {
  method: 'PUT', body: JSON.stringify(data), ...options
});
export const deleteIdeaLoomList = (id, options = {}) => request(`/brain/ideas/idealoom/lists/${id}`, {
  method: 'DELETE', ...options
});
export const importIdeaLoomFromObsidian = (options = {}) => request('/brain/ideas/idealoom/import', {
  method: 'POST', body: JSON.stringify({}), ...options
});
// `recreateMissing` is the explicit recovery request for a vault note the user
// deleted. Automatic sync never sets it, so recreating a note is always a
// deliberate click rather than a side effect of saving a list.
export const syncIdeaLoomToObsidian = (listId, options = {}) => {
  const { recreateMissing, ...requestOptions } = options;
  return request('/brain/ideas/idealoom/sync', {
    method: 'POST',
    body: JSON.stringify({ ...(listId ? { listId } : {}), ...(recreateMissing ? { recreateMissing: true } : {}) }),
    ...requestOptions
  });
};

// Brain - Admin
export const getBrainAdmin = (filters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  return request(`/brain/admin?${params}`);
};
export const getBrainAdminItem = (id) => request(`/brain/admin/${id}`);
export const createBrainAdminItem = (data, options = {}) => request('/brain/admin', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainAdminItem = (id, data, options = {}) => request(`/brain/admin/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainAdminItem = (id, options = {}) => request(`/brain/admin/${id}`, { method: 'DELETE', ...options });

// Brain - Memories
export const getBrainMemories = () => request('/brain/memories');
export const getBrainMemory = (id) => request(`/brain/memories/${id}`);
export const createBrainMemory = (data, options = {}) => request('/brain/memories', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainMemory = (id, data, options = {}) => request(`/brain/memories/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainMemory = (id, options = {}) => request(`/brain/memories/${id}`, { method: 'DELETE', ...options });
export const previewChatgptImport = (data) => request('/brain/import/chatgpt/preview', {
  method: 'POST',
  body: JSON.stringify({ data })
});
export const runChatgptImport = (data, options = {}) => request('/brain/import/chatgpt', {
  method: 'POST',
  body: JSON.stringify({ data, ...options })
});
// Stream the whole export ZIP up via multipart — no JSON-body size cap, and the
// server extracts conversations + image/voice/file assets. `tags` is a comma-
// separated string; `skipEmpty` a boolean. request() detects the FormData body
// and lets the browser set the multipart boundary itself.
export const uploadChatgptZip = (file, { tags = '', skipEmpty = true, ...options } = {}) => {
  const formData = new FormData();
  formData.append('file', file);
  if (tags) formData.append('tags', tags);
  formData.append('skipEmpty', skipEmpty ? 'true' : 'false');
  return request('/brain/import/chatgpt/zip', { method: 'POST', body: formData, ...options });
};
export const getChatgptArchive = (name) =>
  request(`/brain/import/chatgpt/archive/${encodeURIComponent(name)}`);

// Brain - Digests & Reviews
export const getBrainLatestDigest = () => request('/brain/digest/latest');
export const getBrainDigests = (limit = 10) => request(`/brain/digests?limit=${limit}`);
export const runBrainDigest = (providerOverride, modelOverride, options = {}) => request('/brain/digest/run', {
  method: 'POST',
  body: JSON.stringify({ providerOverride, modelOverride }),
  ...options
});
export const getBrainLatestReview = () => request('/brain/review/latest');
export const getBrainReviews = (limit = 10) => request(`/brain/reviews?limit=${limit}`);
export const runBrainReview = (providerOverride, modelOverride, options = {}) => request('/brain/review/run', {
  method: 'POST',
  body: JSON.stringify({ providerOverride, modelOverride }),
  ...options
});

// Brain - Links
export const getBrainLinks = (options = {}) => {
  const params = new URLSearchParams();
  if (options.linkType) params.set('linkType', options.linkType);
  if (options.isRepo !== undefined) params.set('isRepo', options.isRepo);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  return request(`/brain/links?${params}`);
};
export const getBrainLink = (id, options = {}) => request(`/brain/links/${id}`, options);
export const createBrainLink = (data, options = {}) => request('/brain/links', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainLink = (id, data, options = {}) => request(`/brain/links/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
// Batch reorder: apply a whole drag gesture's { id, bucketId, bucketOrder }
// changes in one atomic server write (avoids N concurrent PUTs racing the
// shared links store).
export const reorderBrainLinks = (updates, options = {}) => request('/brain/links/reorder', {
  method: 'POST',
  body: JSON.stringify({ updates }),
  ...options
});
export const deleteBrainLink = (id, options = {}) => request(`/brain/links/${id}`, { method: 'DELETE', ...options });
export const cloneBrainLink = (id, options = {}) => request(`/brain/links/${id}/clone`, { method: 'POST', ...options });
export const pullBrainLink = (id, options = {}) => request(`/brain/links/${id}/pull`, { method: 'POST', ...options });
export const openBrainLinkFolder = (id, options = {}) => request(`/brain/links/${id}/open-folder`, { method: 'POST', ...options });
export const scanBrainLink = (id, options = {}) => request(`/brain/links/${id}/scan`, { method: 'POST', ...options });
// Refresh the clone (unless `pull: false`) and queue a fresh repo-study run with
// the brief in `studyContext` — the on-demand twin of the capture-time
// "study for app ideas" checkbox.
export const studyBrainLink = (id, data = {}, options = {}) => request(`/brain/links/${id}/study`, {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const brainScanReportPath = (id) => `/brain/links/${encodeURIComponent(id)}/scan-report`;
export const getBrainScanReport = (id, options = {}) => request(`/brain/links/${encodeURIComponent(id)}/scan-report`, {
  responseType: 'text',
  ...options
});

// Scan report links created before the in-app viewer used the raw API endpoint.
// Keep old Review and CoS records inside PortOS too, rather than opening a .md
// response in the standalone Home Screen browser context.
export const normalizeBrainScanReportPath = (reportUrl) => {
  const match = typeof reportUrl === 'string'
    ? reportUrl.match(/^\/api\/brain\/links\/([^/]+)\/scan-report$/)
    : null;
  return match ? brainScanReportPath(match[1]) : reportUrl;
};

// Brain - Buckets (bookmark groups for links)
export const getBrainBuckets = (options = {}) => request('/brain/buckets', options);
export const createBrainBucket = (data, options = {}) => request('/brain/buckets', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainBucket = (id, data, options = {}) => request(`/brain/buckets/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainBucket = (id, options = {}) => request(`/brain/buckets/${id}`, { method: 'DELETE', ...options });
export const reorderBrainBuckets = (ids, options = {}) => request('/brain/buckets/reorder', {
  method: 'POST',
  body: JSON.stringify({ ids }),
  ...options
});

// Brain - Goals (identity system, read-only view for the graph detail panel)
export const getBrainGoal = (id) =>
  request('/digital-twin/identity/goals').then(data =>
    (data?.goals ?? []).find(g => g.id === id) ?? null
  );

// Brain - Journal entries (Daily Log)
export const getBrainJournalEntry = (date) =>
  request(`/brain/daily-log/${encodeURIComponent(date)}`).then(r => r?.entry ?? null);

// Brain - Graph. Bounded by design: no `focus` returns an overview of the
// most-connected nodes; a `focus` returns that node's neighborhood. The full
// graph is never returned (it crashes the browser at scale).
export const getBrainGraph = ({ focus, limit } = {}, options = {}) => {
  const params = new URLSearchParams();
  if (focus) params.set('focus', focus);
  if (limit) params.set('limit', limit);
  const qs = params.toString();
  return request(`/brain/graph${qs ? `?${qs}` : ''}`, options);
};
// Lightweight {id,label,brainType} list of every node, for the search box.
export const getBrainGraphSearchIndex = () => request('/brain/graph/search-index');
// Count of active records missing an embedding (powers "Embed missing").
export const getEmbeddingsStatus = () => request('/brain/embeddings/status');

// Brain - Bridge Sync (brain data to CoS memory system).
// refresh:true re-embeds already-mapped records to heal memory entries that
// went stale before the per-record sync signal existed (issue #1080).
// onlyMissing:true is the cheap targeted backfill — embeds only records lacking
// an embedding, skipping everything healthy.
// `options` (e.g. { silent: true }) passes through to the request helper so a
// caller with its own error toast doesn't get a duplicate from the helper.
export const syncBrainData = ({ refresh = false, onlyMissing = false } = {}, options = {}) =>
  request('/brain/bridge-sync', { method: 'POST', body: JSON.stringify({ refresh, onlyMissing }), ...options });

// Brain - On This Day (dashboard widget: past-year journals/memories/ideas)
export const getBrainOnThisDay = (options = {}) => request('/brain/on-this-day', options);

// Brain - Daily Log
export const listDailyLogs = (options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  return request(`/brain/daily-log?${params}`);
};
export const getDailyLog = (date = 'today') => request(`/brain/daily-log/${encodeURIComponent(date)}`);
export const appendDailyLog = (date, text, source = 'text', options = {}) => request(
  `/brain/daily-log/${encodeURIComponent(date)}/append`,
  { method: 'POST', body: JSON.stringify({ text, source }), ...options }
);
export const updateDailyLog = (date, content, options = {}) => {
  // `ifMatchUpdatedAt` is an optimistic concurrency token (the entry's
  // updatedAt the client last observed). It rides in the JSON body; the rest
  // of `options` (silent, headers, …) are request() fetch options. Only a
  // non-empty string is forwarded — anything else is treated as "no token"
  // so the server force-writes (same as omitting the field).
  const { ifMatchUpdatedAt, ...requestOptions } = options;
  const body = { content };
  if (typeof ifMatchUpdatedAt === 'string' && ifMatchUpdatedAt.length > 0) {
    body.ifMatchUpdatedAt = ifMatchUpdatedAt;
  }
  return request(
    `/brain/daily-log/${encodeURIComponent(date)}`,
    { method: 'PUT', body: JSON.stringify(body), ...requestOptions }
  );
};
export const deleteDailyLog = (date, options = {}) => request(
  `/brain/daily-log/${encodeURIComponent(date)}`,
  { method: 'DELETE', ...options }
);
export const getDailyLogSettings = () => request('/brain/daily-log/settings');
export const updateDailyLogSettings = (settings) => request('/brain/daily-log/settings', {
  method: 'PUT',
  body: JSON.stringify(settings)
});
export const syncDailyLogsToObsidian = (options = {}) => request('/brain/daily-log/sync-obsidian', { method: 'POST', ...options });

// Brain - Daily Log - Activity Digest (auto-drafts, #2155)
export const getActivityDigestSettings = () => request('/brain/daily-log/digest-settings');
export const updateActivityDigestSettings = (settings) => request('/brain/daily-log/digest-settings', {
  method: 'PUT',
  body: JSON.stringify(settings)
});
export const draftActivityDigest = (date = 'today', options = {}) => request(
  `/brain/daily-log/${encodeURIComponent(date)}/draft`,
  { method: 'POST', ...options }
);

// Brain - YouTube ingest (transcript / video / audio → brain + Obsidian)
export const startYoutubeIngest = (body, options = {}) => request('/brain/youtube/ingest', {
  method: 'POST',
  body: JSON.stringify(body),
  ...options
});
export const cancelYoutubeIngest = (jobId, options = {}) => request(
  `/brain/youtube/ingest/${encodeURIComponent(jobId)}/cancel`,
  { method: 'POST', ...options }
);
export const getYoutubeIngests = (options = {}) => request('/brain/youtube/ingests', options);
export const deleteYoutubeIngest = (videoId, options = {}) => request(
  `/brain/youtube/ingests/${encodeURIComponent(videoId)}`,
  { method: 'DELETE', ...options }
);
export const getYoutubeIngestSettings = (options = {}) => request('/brain/youtube/settings', options);
export const updateYoutubeIngestSettings = (settings, options = {}) => request('/brain/youtube/settings', {
  method: 'PUT',
  body: JSON.stringify(settings),
  ...options
});
export const youtubeIngestEventsUrl = (jobId) =>
  `/api/brain/youtube/ingest/${encodeURIComponent(jobId)}/events`;

// --- Brain federation parity audit (#4519) ---
// `getBrainParityReports` reads the last stored per-peer result (no peer I/O);
// `runBrainParityCheck` performs the audit — pass a local peer id for one peer,
// omit it to sweep every federating peer. `silent: true` is available for
// callers that own their error UI.
export const getBrainParityReports = (options = {}) => request('/brain/reconcile/parity', options);
export const runBrainParityCheck = (peerId, options = {}) => request('/brain/reconcile/parity', {
  method: 'POST',
  body: JSON.stringify(peerId ? { peerId } : {}),
  ...options
});
