// Pure row builders for the Capability Map (one page that shows every
// connected system's status — doubles as a setup checklist and a runtime
// health overview). The route (server/routes/capabilities.js) gathers each
// integration's raw status in parallel and hands the shapes here; this module
// owns the status-tier derivation so it is unit-testable without any I/O.
//
// Status tiers:
//   'ok'           — configured and healthy/reachable (green)
//   'warn'         — configured but degraded (amber)
//   'error'        — configured but broken (red)
//   'unconfigured' — not set up yet (gray) — the setup-checklist signal

export const CAPABILITY_STATUS = Object.freeze({
  OK: 'ok',
  WARN: 'warn',
  ERROR: 'error',
  UNCONFIGURED: 'unconfigured',
});

const { OK, WARN, ERROR, UNCONFIGURED } = CAPABILITY_STATUS;

const row = (id, label, settingsPath, { status, configured, summary, detail }) => ({
  id,
  label,
  settingsPath,
  status,
  configured,
  summary,
  detail: detail ?? null,
});

const plural = (n, one, many) => (n === 1 ? one : (many ?? `${one}s`));

export function providersRow(providers = [], statuses = {}) {
  const enabled = (Array.isArray(providers) ? providers : []).filter((p) => p && p.enabled !== false);
  if (enabled.length === 0) {
    return row('providers', 'AI Providers', '/ai', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'No AI providers configured',
    });
  }
  // getAllProviderStatuses() returns { ...cache, providers: { [id]: status } }.
  // A provider that was never marked unavailable has no entry — treat as available.
  const statusMap = statuses?.providers ?? statuses ?? {};
  let available = 0;
  let unavailable = 0;
  for (const p of enabled) {
    const s = statusMap?.[p.id];
    if (!s || s.available) available += 1;
    else unavailable += 1;
  }
  let status = OK;
  if (available === 0) status = ERROR;
  else if (unavailable > 0) status = WARN;
  const parts = [`${enabled.length} configured`, `${available} available`];
  if (unavailable > 0) parts.push(`${unavailable} unavailable`);
  return row('providers', 'AI Providers', '/ai', {
    status,
    configured: true,
    summary: parts.join(' · '),
    detail: { configured: enabled.length, available, unavailable },
  });
}

export function calendarRow(accounts = []) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (list.length === 0) {
    return row('calendar', 'Calendar', '/calendar/config', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'No calendar accounts connected',
    });
  }
  const enabled = list.filter((a) => a && a.enabled).length;
  return row('calendar', 'Calendar', '/calendar/config', {
    status: enabled > 0 ? OK : WARN,
    configured: true,
    summary: enabled > 0
      ? `${enabled} of ${list.length} ${plural(list.length, 'account')} syncing`
      : `${list.length} ${plural(list.length, 'account')}, none enabled`,
    detail: { total: list.length, enabled },
  });
}

export function brainRow({ memoryCount = 0, embeddingProviderConfigured = false } = {}) {
  const count = Number(memoryCount) || 0;
  if (count === 0 && !embeddingProviderConfigured) {
    return row('brain', 'Brain & Memory', '/brain/config', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'No memories stored yet',
    });
  }
  let status = OK;
  if (!embeddingProviderConfigured) status = count > 0 ? WARN : UNCONFIGURED;
  const summary = `${count} ${plural(count, 'memory', 'memories')} · `
    + (embeddingProviderConfigured ? 'embeddings configured' : 'no embedding provider');
  return row('brain', 'Brain & Memory', '/brain/config', {
    status,
    configured: count > 0 || embeddingProviderConfigured,
    summary,
    detail: { memoryCount: count, embeddingProviderConfigured },
  });
}

export function voiceRow(cfg = {}) {
  const enabled = !!cfg?.enabled;
  if (!enabled) {
    return row('voice', 'Voice', '/settings/voice', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'Voice disabled',
    });
  }
  const tts = cfg?.tts?.engine || 'unknown';
  const stt = cfg?.stt?.engine || 'unknown';
  return row('voice', 'Voice', '/settings/voice', {
    status: OK,
    configured: true,
    summary: `Enabled · TTS ${tts} · STT ${stt}`,
    detail: { tts, stt },
  });
}

export function networkRow(net = {}) {
  const https = !!net?.httpsEnabled;
  const tailscaleHost = net?.cert?.tailscaleHost || null;
  const tailscale = !!tailscaleHost;
  if (!https && !tailscale) {
    return row('network', 'Tailscale & HTTPS', '/instances', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'HTTP only · Tailscale not detected',
    });
  }
  return row('network', 'Tailscale & HTTPS', '/instances', {
    status: https && tailscale ? OK : WARN,
    configured: true,
    summary: [
      https ? 'HTTPS on' : 'HTTP only',
      tailscale ? `Tailscale: ${tailscaleHost}` : 'Tailscale not detected',
    ].join(' · '),
    detail: { https, tailscaleHost },
  });
}

export function genomeRow(genome = {}) {
  if (!genome?.uploaded) {
    return row('genome', 'Genome & Health', '/meatspace/genome', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'No genome uploaded',
    });
  }
  const markers = Number(genome?.markerCount) || 0;
  const counts = genome?.statusCounts || {};
  const flagged = (Number(counts.concern) || 0) + (Number(counts.major_concern) || 0);
  return row('genome', 'Genome & Health', '/meatspace/genome', {
    status: OK,
    configured: true,
    summary: `Genome loaded · ${markers} ${plural(markers, 'marker')}`
      + (flagged > 0 ? ` · ${flagged} flagged` : ''),
    detail: { markerCount: markers, flagged },
  });
}

export function telegramRow({ hasToken = false, hasChatId = false, connected = false, method = 'manual' } = {}) {
  const configured = !!hasToken && !!hasChatId;
  if (!configured) {
    return row('telegram', 'Telegram', '/settings/telegram', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'Not configured',
    });
  }
  return row('telegram', 'Telegram', '/settings/telegram', {
    status: connected ? OK : WARN,
    configured: true,
    summary: `${method} · ${connected ? 'connected' : 'configured (not connected)'}`,
    detail: { method, connected },
  });
}

export function messagesRow(accounts = []) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (list.length === 0) {
    return row('messages', 'Messages', '/messages/config', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'No message accounts connected',
    });
  }
  const enabled = list.filter((a) => a && a.enabled).length;
  return row('messages', 'Messages', '/messages/config', {
    status: enabled > 0 ? OK : WARN,
    configured: true,
    summary: enabled > 0
      ? `${enabled} of ${list.length} ${plural(list.length, 'account')} syncing`
      : `${list.length} ${plural(list.length, 'account')}, none enabled`,
    detail: { total: list.length, enabled },
  });
}

export function appsRow(summary = {}) {
  const total = Number(summary?.total) || 0;
  if (total === 0) {
    return row('apps', 'Apps & Processes', '/apps', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'No apps registered',
    });
  }
  const online = Number(summary?.online) || 0;
  const stopped = Number(summary?.stopped) || 0;
  return row('apps', 'Apps & Processes', '/apps', {
    status: stopped > 0 ? WARN : OK,
    configured: true,
    summary: `${total} ${plural(total, 'app')} · ${online} online`
      + (stopped > 0 ? ` · ${stopped} stopped` : ''),
    detail: { total, online, stopped },
  });
}

/**
 * Build the ordered list of capability rows from already-fetched raw data.
 * Every field is optional — a missing/failed source degrades to `unconfigured`
 * rather than throwing, so one broken integration never blanks the whole page.
 */
export function buildCapabilityRows(data = {}) {
  return [
    providersRow(data.providers, data.providerStatuses),
    calendarRow(data.calendarAccounts),
    brainRow({ memoryCount: data.memoryCount, embeddingProviderConfigured: data.embeddingProviderConfigured }),
    voiceRow(data.voiceConfig),
    networkRow(data.network),
    genomeRow(data.genome),
    telegramRow(data.telegram),
    messagesRow(data.messageAccounts),
    appsRow(data.appSummary),
  ];
}

/**
 * Roll the rows up into a single posture for a header badge.
 * `overall` is worst-wins across error → warn → unconfigured → ok.
 */
export function summarizeCapabilities(rows = []) {
  const counts = { ok: 0, warn: 0, error: 0, unconfigured: 0 };
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (counts[r?.status] !== undefined) counts[r.status] += 1;
  }
  let overall = OK;
  if (counts.error > 0) overall = ERROR;
  else if (counts.warn > 0) overall = WARN;
  else if (counts.unconfigured > 0) overall = UNCONFIGURED;
  return { ...counts, total: rows.length, overall };
}
