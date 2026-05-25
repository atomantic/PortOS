import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_STATUS,
  providersRow,
  calendarRow,
  brainRow,
  voiceRow,
  networkRow,
  genomeRow,
  telegramRow,
  messagesRow,
  appsRow,
  buildCapabilityRows,
  summarizeCapabilities,
} from './capabilityMap.js';

const { OK, WARN, ERROR, UNCONFIGURED } = CAPABILITY_STATUS;

describe('providersRow', () => {
  it('is unconfigured with no enabled providers', () => {
    expect(providersRow([]).status).toBe(UNCONFIGURED);
    expect(providersRow([{ id: 'a', enabled: false }]).status).toBe(UNCONFIGURED);
  });

  it('treats never-marked providers as available', () => {
    const r = providersRow([{ id: 'a' }, { id: 'b' }], { providers: {} });
    expect(r.status).toBe(OK);
    expect(r.detail).toEqual({ configured: 2, available: 2, unavailable: 0 });
  });

  it('warns when some providers are unavailable but at least one is up', () => {
    const r = providersRow(
      [{ id: 'a' }, { id: 'b' }],
      { providers: { b: { available: false, reason: 'rate-limit' } } },
    );
    expect(r.status).toBe(WARN);
    expect(r.detail).toMatchObject({ available: 1, unavailable: 1 });
  });

  it('errors when no provider is available', () => {
    const r = providersRow([{ id: 'a' }], { providers: { a: { available: false } } });
    expect(r.status).toBe(ERROR);
  });

  it('accepts a bare status map (no providers wrapper)', () => {
    const r = providersRow([{ id: 'a' }], { a: { available: false } });
    expect(r.status).toBe(ERROR);
  });
});

describe('calendarRow / messagesRow', () => {
  it('unconfigured with no accounts', () => {
    expect(calendarRow([]).status).toBe(UNCONFIGURED);
    expect(messagesRow([]).status).toBe(UNCONFIGURED);
  });

  it('ok when at least one account is enabled', () => {
    expect(calendarRow([{ enabled: true }, { enabled: false }]).status).toBe(OK);
    expect(messagesRow([{ enabled: true }]).status).toBe(OK);
  });

  it('warns when accounts exist but none enabled', () => {
    expect(calendarRow([{ enabled: false }]).status).toBe(WARN);
  });

  it('warns when an enabled account last sync failed', () => {
    const r = calendarRow([{ enabled: true, lastSyncStatus: 'error' }, { enabled: true, lastSyncStatus: 'success' }]);
    expect(r.status).toBe(WARN);
    expect(r.detail.failing).toBe(1);
    expect(r.summary).toContain('1 failing');
    // 'partial' also counts as failing
    expect(messagesRow([{ enabled: true, lastSyncStatus: 'partial' }]).status).toBe(WARN);
    // a never-synced (null) account is not a failure
    expect(calendarRow([{ enabled: true, lastSyncStatus: null }]).status).toBe(OK);
  });
});

describe('brainRow', () => {
  it('unconfigured with no memories and no embedding provider', () => {
    expect(brainRow({ memoryCount: 0, embeddingProviderConfigured: false }).status).toBe(UNCONFIGURED);
  });

  it('ok with memories and a configured embedding provider', () => {
    expect(brainRow({ memoryCount: 5, embeddingProviderConfigured: true }).status).toBe(OK);
  });

  it('warns with memories but no embedding provider', () => {
    expect(brainRow({ memoryCount: 5, embeddingProviderConfigured: false }).status).toBe(WARN);
  });

  it('pluralizes the memory count', () => {
    expect(brainRow({ memoryCount: 1, embeddingProviderConfigured: true }).summary).toContain('1 memory');
    expect(brainRow({ memoryCount: 2, embeddingProviderConfigured: true }).summary).toContain('2 memories');
  });
});

describe('voiceRow', () => {
  it('unconfigured when disabled', () => {
    expect(voiceRow({ enabled: false }).status).toBe(UNCONFIGURED);
    expect(voiceRow({}).status).toBe(UNCONFIGURED);
  });

  it('ok when enabled, reporting engines', () => {
    const r = voiceRow({ enabled: true, tts: { engine: 'kokoro' }, stt: { engine: 'whisper' } });
    expect(r.status).toBe(OK);
    expect(r.summary).toContain('kokoro');
    expect(r.summary).toContain('whisper');
  });
});

describe('networkRow', () => {
  it('unconfigured on plain HTTP with no tailscale', () => {
    expect(networkRow({ httpsEnabled: false, cert: {} }).status).toBe(UNCONFIGURED);
  });

  it('ok with HTTPS and a tailscale host', () => {
    expect(networkRow({ httpsEnabled: true, cert: { tailscaleHost: 'host.ts.net' } }).status).toBe(OK);
  });

  it('warns when only one of the two is present', () => {
    expect(networkRow({ httpsEnabled: true, cert: {} }).status).toBe(WARN);
    expect(networkRow({ httpsEnabled: false, cert: { tailscaleHost: 'h' } }).status).toBe(WARN);
  });
});

describe('genomeRow', () => {
  it('unconfigured when not uploaded', () => {
    expect(genomeRow({ uploaded: false }).status).toBe(UNCONFIGURED);
  });

  it('ok when uploaded, surfacing flagged markers', () => {
    const r = genomeRow({ uploaded: true, markerCount: 12, statusCounts: { concern: 2, major_concern: 1 } });
    expect(r.status).toBe(OK);
    expect(r.summary).toContain('3 flagged');
  });
});

describe('telegramRow', () => {
  it('unconfigured without token + chatId', () => {
    expect(telegramRow({ hasToken: true, hasChatId: false }).status).toBe(UNCONFIGURED);
  });

  it('ok when configured and connected', () => {
    expect(telegramRow({ hasToken: true, hasChatId: true, connected: true }).status).toBe(OK);
  });

  it('warns when configured but not connected', () => {
    expect(telegramRow({ hasToken: true, hasChatId: true, connected: false }).status).toBe(WARN);
  });
});

describe('appsRow', () => {
  it('unconfigured with no apps', () => {
    expect(appsRow({ total: 0 }).status).toBe(UNCONFIGURED);
  });

  it('ok when all online, warns when some stopped', () => {
    expect(appsRow({ total: 3, online: 3, stopped: 0 }).status).toBe(OK);
    expect(appsRow({ total: 3, online: 2, stopped: 1 }).status).toBe(WARN);
  });

  it('warns when apps are registered but never started', () => {
    const r = appsRow({ total: 3, online: 0, stopped: 0, notStarted: 3 });
    expect(r.status).toBe(WARN);
    expect(r.summary).toContain('3 not started');
    expect(r.detail.notStarted).toBe(3);
  });

  it('reports native-only (unmanaged) apps as present, not "No apps"', () => {
    // getAppStatusSummary().total excludes unmanaged native/Xcode apps.
    const r = appsRow({ total: 0, online: 0, unmanaged: 2 });
    expect(r.status).toBe(OK);
    expect(r.configured).toBe(true);
    expect(r.summary).toContain('2 native');
  });

  it('unconfigured only when there are no apps at all', () => {
    expect(appsRow({ total: 0, unmanaged: 0 }).status).toBe(UNCONFIGURED);
  });
});

describe('buildCapabilityRows', () => {
  it('returns one row per integration even with empty input', () => {
    const rows = buildCapabilityRows({});
    expect(rows).toHaveLength(9);
    // Every row degrades to unconfigured rather than throwing.
    expect(rows.every((r) => r.status === UNCONFIGURED)).toBe(true);
    expect(rows.every((r) => typeof r.settingsPath === 'string' && r.settingsPath.startsWith('/'))).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(9);
  });
});

describe('summarizeCapabilities', () => {
  it('counts each tier and rolls up worst-wins', () => {
    const rows = [
      { status: OK }, { status: OK }, { status: WARN }, { status: UNCONFIGURED },
    ];
    const s = summarizeCapabilities(rows);
    expect(s).toMatchObject({ ok: 2, warn: 1, error: 0, unconfigured: 1, total: 4, overall: WARN });
  });

  it('reports error overall when any row errors', () => {
    expect(summarizeCapabilities([{ status: OK }, { status: ERROR }]).overall).toBe(ERROR);
  });

  it('reports ok overall only when every row is ok', () => {
    expect(summarizeCapabilities([{ status: OK }, { status: OK }]).overall).toBe(OK);
  });

  it('reports unconfigured overall when only ok + unconfigured rows', () => {
    expect(summarizeCapabilities([{ status: OK }, { status: UNCONFIGURED }]).overall).toBe(UNCONFIGURED);
  });

  it('reports unconfigured (not ok) for empty or garbage input', () => {
    expect(summarizeCapabilities([]).overall).toBe(UNCONFIGURED);
    expect(summarizeCapabilities(null).overall).toBe(UNCONFIGURED);
    expect(summarizeCapabilities(null).total).toBe(0);
  });

  it('does not default to ok when a non-empty list has only unknown statuses', () => {
    const s = summarizeCapabilities([{ status: 'bogus' }, {}]);
    expect(s).toMatchObject({ ok: 0, warn: 0, error: 0, unconfigured: 0, total: 2, overall: UNCONFIGURED });
  });
});
