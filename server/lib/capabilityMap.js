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

import { localRuntimeForProvider } from './localProviderRuntime.js';

export const CAPABILITY_STATUS = Object.freeze({
  OK: 'ok',
  WARN: 'warn',
  ERROR: 'error',
  UNCONFIGURED: 'unconfigured',
});

const { OK, WARN, ERROR, UNCONFIGURED } = CAPABILITY_STATUS;

const row = (id, label, settingsPath, {
  status,
  configured,
  summary,
  detail,
  setupRequired = false,
  setupComplete = status === OK,
}) => ({
  id,
  label,
  settingsPath,
  status,
  configured,
  summary,
  detail: detail ?? null,
  setupRequired,
  setupComplete,
});

const plural = (n, one, many) => (n === 1 ? one : (many ?? `${one}s`));

export function providersRow(
  providers = [],
  statuses = {},
  prerequisiteReadiness = undefined,
  localReadiness = undefined,
) {
  const enabled = (Array.isArray(providers) ? providers : []).filter((p) => p && p.enabled !== false);
  if (enabled.length === 0) {
    return row('providers', 'AI Providers', '/ai', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'No AI providers configured',
      setupRequired: true,
      setupComplete: false,
    });
  }
  // getAllProviderStatuses() returns { ...cache, providers: { [id]: status } }.
  // A provider that was never marked unavailable has no entry — treat as available.
  const statusMap = statuses?.providers ?? statuses ?? {};
  const prerequisiteReadinessRequested = prerequisiteReadiness !== undefined;
  const hasPrerequisiteReadiness = prerequisiteReadiness
    && typeof prerequisiteReadiness === 'object'
    && !Array.isArray(prerequisiteReadiness);
  const localReadinessRequested = localReadiness !== undefined;
  const hasLocalReadiness = localReadiness
    && typeof localReadiness === 'object'
    && !Array.isArray(localReadiness);
  let available = 0;
  let unavailable = 0;
  let blocked = 0;
  let unknown = 0;
  let standby = 0;
  let setupReady = 0;
  for (const p of enabled) {
    const prerequisite = hasPrerequisiteReadiness ? prerequisiteReadiness[p.id] : null;
    if (prerequisite?.status === 'blocked') {
      blocked += 1;
      continue;
    }
    if (prerequisite?.status === 'unknown') {
      unknown += 1;
      continue;
    }
    if (prerequisiteReadinessRequested && prerequisite?.status !== 'ready') {
      unknown += 1;
      continue;
    }
    if (localReadinessRequested && localRuntimeForProvider(p)) {
      const local = hasLocalReadiness ? localReadiness[p.id] : null;
      if (local?.ready !== true && local?.standby === true) {
        standby += 1;
        continue;
      }
      if (local?.ready === false) {
        const checks = Array.isArray(local.checks) ? local.checks : [];
        if (checks.length > 0 && checks.every((check) => check?.ok !== false)) unknown += 1;
        else blocked += 1;
        continue;
      }
      if (local?.ready !== true) {
        unknown += 1;
        continue;
      }
    }
    if (prerequisiteReadinessRequested) setupReady += 1;
    const s = statusMap?.[p.id];
    if (!s || s.available) available += 1;
    else unavailable += 1;
  }
  let status = OK;
  if (available === 0) status = unknown > 0 || standby > 0 ? WARN : ERROR;
  else if (unavailable > 0 || blocked > 0 || unknown > 0) status = WARN;
  const parts = [`${enabled.length} enabled`, `${available} ready`];
  if (unavailable > 0) parts.push(`${unavailable} unavailable`);
  if (blocked > 0) parts.push(`${blocked} need setup`);
  if (unknown > 0) parts.push(`${unknown} still checking`);
  if (standby > 0) parts.push(`${standby} standby`);
  return row('providers', 'AI Providers', '/ai', {
    status,
    configured: true,
    summary: parts.join(' · '),
    detail: prerequisiteReadinessRequested
      ? { configured: enabled.length, available, unavailable, blocked, unknown, standby, setupReady }
      : { configured: enabled.length, available, unavailable },
    setupRequired: true,
    setupComplete: prerequisiteReadinessRequested ? setupReady > 0 : available > 0,
  });
}

// Calendar and Messages share the same account-list shape: each account has an
// `enabled` flag and a persisted `lastSyncStatus`. An enabled account whose last
// sync ended in 'error' or 'partial' degrades the row to WARN so the page can't
// claim "Ready" while a sync is actively failing.
function accountListRow(id, label, settingsPath, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (list.length === 0) {
    return row(id, label, settingsPath, {
      status: UNCONFIGURED,
      configured: false,
      summary: `No ${label} accounts connected`,
    });
  }
  const enabledAccounts = list.filter((a) => a && a.enabled);
  const enabled = enabledAccounts.length;
  const failing = enabledAccounts.filter(
    (a) => a.lastSyncStatus === 'error' || a.lastSyncStatus === 'partial',
  ).length;
  let status = OK;
  let summary;
  if (enabled === 0) {
    status = WARN;
    summary = `${list.length} ${plural(list.length, 'account')}, none enabled`;
  } else if (failing > 0) {
    status = WARN;
    summary = `${enabled} of ${list.length} syncing · ${failing} failing`;
  } else {
    summary = `${enabled} of ${list.length} ${plural(list.length, 'account')} syncing`;
  }
  return row(id, label, settingsPath, {
    status,
    configured: true,
    summary,
    detail: { total: list.length, enabled, failing },
  });
}

export function calendarRow(accounts = []) {
  return accountListRow('calendar', 'Calendar', '/calendar/config', accounts);
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
  if (net?.setup && typeof net.setup === 'object') {
    const complete = net.setup.complete === true;
    const started = net?.tailscale?.available === true || net?.cert?.provisioned === true;
    return row('network', 'Tailscale & HTTPS', '/instances', {
      status: complete ? OK : started ? WARN : UNCONFIGURED,
      configured: started,
      summary: net.setup.summary || 'Tailscale HTTPS setup is incomplete',
      detail: {
        https: !!net?.httpsEnabled,
        tailscaleHost: net.setup.dnsName || net?.cert?.tailscaleHost || null,
        nextStepId: net.setup.nextStep?.id || null,
      },
      setupRequired: true,
      setupComplete: complete,
    });
  }
  const https = !!net?.httpsEnabled;
  const tailscaleHost = net?.cert?.tailscaleHost || null;
  const tailscale = !!tailscaleHost;
  if (!https && !tailscale) {
    return row('network', 'Tailscale & HTTPS', '/instances', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'HTTP only · Tailscale not detected',
      setupRequired: true,
      setupComplete: false,
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
    setupRequired: true,
    setupComplete: https && tailscale,
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
  return accountListRow('messages', 'Messages', '/messages/config', accounts);
}

export function appsRow(summary = {}) {
  // getAppStatusSummary().total counts only PM2-runnable apps; native/Xcode
  // projects are reported separately under `unmanaged` (no runtime state).
  const total = Number(summary?.total) || 0;
  const unmanaged = Number(summary?.unmanaged) || 0;
  if (total === 0 && unmanaged === 0) {
    return row('apps', 'Apps & Processes', '/apps', {
      status: UNCONFIGURED,
      configured: false,
      summary: 'No apps registered',
    });
  }
  if (total === 0) {
    // Only native apps registered — they exist but have no PM2 lifecycle to health-check.
    return row('apps', 'Apps & Processes', '/apps', {
      status: OK,
      configured: true,
      summary: `${unmanaged} native ${plural(unmanaged, 'app')} · no runtime status`,
      detail: { total: 0, online: 0, stopped: 0, notStarted: 0, unmanaged },
    });
  }
  const online = Number(summary?.online) || 0;
  const stopped = Number(summary?.stopped) || 0;
  // notStarted = registered but never launched / no matching PM2 process — a
  // setup gap this page exists to surface, so it degrades the row too. unmanaged
  // (Xcode/native projects with no runtime state) is intentionally NOT counted.
  const notStarted = Number(summary?.notStarted) || 0;
  // unknown = PM2 home read failed — runtime status unavailable, NOT a confident
  // "not running." Surfaced separately so a transient PM2 blip reads as
  // "status unavailable" rather than inflating the not-started/stopped count.
  const unknown = Number(summary?.unknown) || 0;
  return row('apps', 'Apps & Processes', '/apps', {
    status: stopped > 0 || notStarted > 0 || unknown > 0 ? WARN : OK,
    configured: true,
    summary: `${total} ${plural(total, 'app')} · ${online} online`
      + (stopped > 0 ? ` · ${stopped} stopped` : '')
      + (notStarted > 0 ? ` · ${notStarted} not started` : '')
      + (unknown > 0 ? ` · ${unknown} status unavailable` : ''),
    detail: { total, online, stopped, notStarted, unknown, degraded: unknown > 0, unmanaged },
  });
}

/**
 * Build the ordered list of capability rows from already-fetched raw data.
 * Every field is optional — a missing/failed source degrades to `unconfigured`
 * rather than throwing, so one broken integration never blanks the whole page.
 */
export function buildCapabilityRows(data = {}) {
  return [
    networkRow(data.network),
    providersRow(
      data.providers,
      data.providerStatuses,
      data.providerPrerequisiteReadiness,
      data.providerLocalReadiness,
    ),
    calendarRow(data.calendarAccounts),
    brainRow({ memoryCount: data.memoryCount, embeddingProviderConfigured: data.embeddingProviderConfigured }),
    voiceRow(data.voiceConfig),
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
  const list = Array.isArray(rows) ? rows : [];
  const counts = { ok: 0, warn: 0, error: 0, unconfigured: 0 };
  for (const r of list) {
    if (counts[r?.status] !== undefined) counts[r.status] += 1;
  }
  // Derive `overall` purely from the tallied counts (worst-wins). Empty input
  // AND a non-empty list whose rows all carry missing/unknown statuses both fall
  // through to UNCONFIGURED — never default to OK when nothing is recognized.
  let overall;
  if (counts.error > 0) overall = ERROR;
  else if (counts.warn > 0) overall = WARN;
  else if (counts.unconfigured > 0) overall = UNCONFIGURED;
  else if (counts.ok > 0) overall = OK;
  else overall = UNCONFIGURED;
  return { ...counts, total: list.length, overall };
}

/** Roll up only the two first-run contracts (network + one usable AI provider). */
export function summarizeSetupCapabilities(rows = []) {
  const setupRows = (Array.isArray(rows) ? rows : []).filter((entry) => entry?.setupRequired === true);
  const ready = setupRows.filter((entry) => entry.setupComplete === true).length;
  return {
    total: setupRows.length,
    ready,
    remaining: setupRows.length - ready,
    complete: setupRows.length > 0 && ready === setupRows.length,
  };
}
