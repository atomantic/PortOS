// Quota snapshots do not identify accounts. Grouping by family therefore uses
// the shared-account assumption stated on the page, never a sum of readings.
const hasReading = (card) => card.supported !== false && !card.error
  && Boolean(card.limits?.length || card.metrics?.length || card.activity?.length);

const readingRank = (card) => hasReading(card) ? 3 : card.pending ? 2 : card.error ? 1 : 0;
const readTime = (card) => {
  const value = Date.parse(card.fetchedAt);
  return Number.isFinite(value) ? value : -Infinity;
};

function chooseReading(cards) {
  return cards.reduce((best, card) => {
    const rank = readingRank(card) - readingRank(best);
    return rank > 0 || (rank === 0 && readTime(card) > readTime(best)) ? card : best;
  });
}

// Different CLI snapshots can expose different windows. Keep the newest
// valid observation of each window, with its own age and source intact.
function combineLimits(cards) {
  const windows = new Map();
  for (const card of cards.filter(hasReading)) {
    for (const limit of card.limits || []) {
      const current = windows.get(limit.key);
      if (current && readTime(card) <= readTime(current.card)) continue;
      windows.set(limit.key, { card, limit: {
        ...limit,
        readAt: limit.readAt || card.fetchedAt || null,
        readBy: limit.readBy ?? (card.origin?.self === false ? card.origin.instanceId : null),
        readByName: limit.readByName ?? (card.origin?.self === false ? card.origin.name : null),
      } });
    }
  }
  return [...windows.values()];
}

export function groupQuotaCards(quotas) {
  const families = new Map();
  for (const card of quotas) {
    const key = card.family;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(card);
  }

  return [...families.entries()].map(([groupKey, cards]) => {
    const selected = chooseReading(cards);
    const hasLocal = cards.some((card) => card.origin?.self !== false);
    const localPending = cards.some((card) => card.origin?.self !== false && card.pending);
    const sources = cards.map((card) => ({ ...card.origin, self: card.origin?.self !== false, fetchedAt: card.fetchedAt }));
    const windows = selected.family === 'imagegen' ? [] : combineLimits(cards);
    const plans = cards.filter((card) => typeof card.plan === 'string' && card.plan.trim() && card.plan !== 'unknown');
    const plan = plans.reduce((best, card) => !best || readTime(card) > readTime(best) ? card : best, null)?.plan;
    return {
      ...selected,
      groupKey,
      ...(plan ? { plan } : {}),
      ...(windows.length ? { limits: windows.map(({ card, limit }) => ({ ...limit, showAttribution: card !== selected,
        ...(card !== selected && card.origin?.self !== false ? { readBy: 'self', readByName: 'this instance' } : {}) })) } : {}),
      canRefresh: hasLocal,
      pending: selected.pending || localPending,
      diagnostics: cards.filter((card) => card !== selected && card.error),
      localAdvisories: cards.filter((card) => card !== selected && card.origin?.self !== false && card.note).map((card) => card.note),
      mixedReadings: windows.some(({ card }) => card !== selected),
      fleet: selected.fleet || (sources.length > 1 ? { count: sources.length, instances: sources } : undefined),
      // Image-gen values are machine-local observations, not account quotas.
      // Keep each source visible inside one card; never add the observations.
      ...(selected.family === 'imagegen' ? { observations: cards } : {}),
    };
  });
}

// A family refresh also returns peer snapshots. Accept newer peer slots without
// letting a delayed response roll back a full sync that already arrived.
export function mergeRefreshedFamily(previous, refreshed, family, { fullReadApplied = false, federationUnavailable = false, localUnavailable = false } = {}) {
  const local = refreshed.find((card) => card.family === family && card.origin?.self !== false);
  let localSeen = false;
  const peers = new Map(refreshed.filter((card) => card.family === family && card.origin?.self === false)
    .map((card) => [card.origin.instanceId, card]));
  const result = previous.flatMap((card) => {
    if (card.family !== family) return [card];
    if (card.origin?.self !== false) {
      localSeen = true;
      return localUnavailable ? [card] : local ? [local] : [];
    }
    const incoming = peers.get(card.origin.instanceId);
    if (!incoming) return fullReadApplied || federationUnavailable ? [card] : [];
    peers.delete(card.origin.instanceId);
    const incomingCapture = Date.parse(incoming.origin.capturedAt);
    const currentCapture = Date.parse(card.origin.capturedAt);
    const hasCaptures = Number.isFinite(incomingCapture) && Number.isFinite(currentCapture);
    const incomingVersion = hasCaptures ? incomingCapture : readTime(incoming);
    const currentVersion = hasCaptures ? currentCapture : readTime(card);
    const newer = incomingVersion > currentVersion || (!fullReadApplied && incomingVersion === currentVersion);
    if (!newer && fullReadApplied && incomingVersion === currentVersion) {
      // A slot's reset windows can expire without changing its capture stamp.
      // Intersecting prevents either response from reviving an expired window.
      const incomingWindows = new Map((incoming.limits || []).map((limit) => [limit.key, limit]));
      let changed = false;
      const limits = (card.limits || []).flatMap((limit) => {
        const next = incomingWindows.get(limit.key);
        if (!next) { changed = true; return []; }
        if (next.stale && !limit.stale) { changed = true; return [{ ...limit, stale: true }]; }
        return [limit];
      });
      if (changed) {
        return [{ ...card, limits, ...(!limits.length && incoming.error ? { error: incoming.error } : {}) }];
      }
    }
    return [newer ? incoming : card];
  });
  return [...result, ...(!localSeen && local ? [local] : []), ...(!fullReadApplied ? peers.values() : [])];
}
