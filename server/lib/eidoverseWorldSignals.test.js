import { describe, expect, it } from 'vitest';
import { buildEidoverseObservation } from './eidoverseObservation.js';
import { buildEidoverseWorldSignals, eidoverseHostId, eidoversePeerId } from './eidoverseWorldSignals.js';

describe('Eidoverse public identity compatibility', () => {
  // Fixed outputs from the pre-extraction collector: changing these identities
  // breaks persisted world metadata and destination links across upgrades.
  it('preserves namespaces, normalization, fallback selection, and the 256-character input cap', () => {
    const fixtures = [
      ['fixture-instance', 'hst_25cf5b1a0b1f', 'peer-bd6bd9c7a57a'],
      ['\t fixture\u0000instance\u007f \n', 'hst_8df6a4a59860', 'peer-7282d94f0db2'],
      ['', 'hst_fe23cde7412c', 'peer-170b31bba778'],
      [undefined, 'hst_fe23cde7412c', 'peer-170b31bba778'],
      [123, 'hst_fe23cde7412c', 'peer-f486350022b1'],
      ['x'.repeat(257), 'hst_4c1dcf8b9a4e', 'peer-5db89d907972'],
    ];
    for (const [instanceId, hostId, peerId] of fixtures) {
      expect(eidoverseHostId(instanceId)).toBe(hostId);
      expect(eidoversePeerId({ instanceId, id: 'legacy-peer' })).toBe(peerId);
    }
    expect(eidoversePeerId({})).toBe('peer-f486350022b1');
  });
});

describe('Agent Foundry task signals', () => {
  // Regression: the Agent Foundry read `attention` whenever ONE task sat in
  // the queue, because `pending` matched the generic status word-matcher,
  // while a `challenged` task — stuck until a human rules on it — matched
  // nothing and read `steady`. The district ORs its sources, so the alarm
  // fired on the resting state of the queue and stayed silent on the one
  // status that actually wanted someone. Asserted through the district that
  // consumes the signal, because the flip a mind acts on is the district's,
  // not the individual task's.
  const agentFoundryStatus = (tasks, agents = [{ id: 'agent-1', status: 'running' }]) => {
    const source = buildEidoverseWorldSignals({
      agents,
      taskState: { tasks },
      destinations: new Set(),
    });
    const { report } = buildEidoverseObservation({ source });
    return report.places.find((place) => place.id === 'agents').status;
  };

  it('treats a queued task as ordinary work and reserves attention for a human decision', () => {
    expect(agentFoundryStatus([{ id: 'task-1', status: 'pending' }])).toBe('active');
    expect(agentFoundryStatus([
      { id: 'task-1', status: 'pending' },
      { id: 'task-2', status: 'in_progress' },
    ])).toBe('active');

    expect(agentFoundryStatus([{ id: 'task-1', status: 'pending', approvalRequired: true }])).toBe('attention');
    expect(agentFoundryStatus([{ id: 'task-1', status: 'challenged' }])).toBe('attention');
    expect(agentFoundryStatus([{ id: 'task-1', status: 'blocked' }])).toBe('attention');
    expect(agentFoundryStatus(
      [{ id: 'task-1', status: 'pending' }],
      [{ id: 'agent-1', status: 'paused' }],
    )).toBe('attention');
  });

  it('maps each task status to its own signal and drops finished work', () => {
    const source = buildEidoverseWorldSignals({
      agents: [],
      taskState: {
        tasks: [
          { id: 'task-pending', status: 'pending' },
          { id: 'task-approval', status: 'pending', approvalRequired: true },
          { id: 'task-progress', status: 'in_progress' },
          { id: 'task-blocked', status: 'blocked' },
          { id: 'task-challenged', status: 'challenged' },
          { id: 'task-hand-edited', status: '[>]' },
          { id: 'task-done', status: 'completed' },
        ],
      },
      destinations: new Set(),
    });
    expect(source.tasks.map((task) => task.status)).toEqual([
      'steady', 'attention', 'active', 'error', 'attention', 'attention',
    ]);
  });

  it('keeps an unreadable task list distinct from an empty one', () => {
    expect(agentFoundryStatus([])).toBe('active');
    expect(agentFoundryStatus([], [])).toBe('quiet');
    expect(agentFoundryStatus(null, null)).toBe('unknown');
  });
});


describe('local attention reasons through builder-to-observation', () => {
  const snapshots = (overallStatus = 'not_started') => ({
    apps: [
      { overallStatus: 'online', managed: true, name: 'Example Secret App' },
      { overallStatus, managed: true, path: '/invented/private/path' },
      { overallStatus: 'n/a', managed: false },
    ],
    featuresState: { features: Array.from({ length: 19 }, (_, i) => ({ id: `feature-${i}` })) },
    diskPercent: 99, review: { alert: 1 }, cosStatus: { running: true, paused: false },
    backupState: { status: 'complete' }, agents: [], taskState: { tasks: [{ status: 'pending' }] },
    destinations: new Set(),
  });
  const project = (input) => buildEidoverseWorldSignals(input, { includeAttentionReasons: true });
  const place = (source, id) => buildEidoverseObservation({ source }).report.places.find((row) => row.id === id);

  it.each(['not_started', 'stopped', 'unknown'])('explains %s while preserving district totals and status', (status) => {
    const input = snapshots(status);
    const source = project(input);
    expect(place(source, 'nexus')).toMatchObject({ signalCount: 21, status: 'attention', unreadableSources: [],
      attentionSignals: [
        { source: 'health', severity: 'error', signalCount: 1, reasons: expect.arrayContaining([
          { code: 'runtime_data_disk_critical', affectedCount: null }, { code: 'review_alerts', affectedCount: 1 },
        ]) },
        { source: 'operations', severity: 'attention', signalCount: 1, reasons: [{ code: 'review_alerts', affectedCount: 1 }] },
      ], attentionTruncated: false,
    });
    expect(place(source, 'apps')).toMatchObject({ signalCount: 3, status: 'attention', unreadableSources: [],
      attentionSignals: [{ source: 'apps', severity: 'attention', signalCount: 1,
        reasons: [{ code: `app_${status}`, affectedCount: 1 }] }],
    });
    expect(place(source, 'agents').attentionSignals).toEqual([]);
    // Ordinary collection still feeds the renderer with its exact old shape.
    const normal = buildEidoverseWorldSignals(input);
    expect(JSON.stringify(normal)).not.toContain('attentionReasons');
    expect(normal.health.status).toBe(source.health.status);
    expect(normal.apps.map((row) => row.status)).toEqual(source.apps.map((row) => row.status));
    if (status === 'not_started') expect(source.health.attentionReasons.map((reason) => reason.code)).not.toContain('app_not_started');
  });

  it('keeps represented app counts distinct from signal rows and uses coarse future-status fallback', () => {
    const source = project({ apps: [
      ...Array.from({ length: 7 }, () => ({ overallStatus: 'not_started' })),
      { overallStatus: 'stopped' }, { overallStatus: 'failed' },
    ] });
    expect(place(source, 'apps').attentionSignals).toEqual([
      { source: 'apps', severity: 'error', signalCount: 1, reasons: [{ code: 'source_error', affectedCount: 1 }] },
      { source: 'apps', severity: 'attention', signalCount: 1, reasons: [
        { code: 'app_not_started', affectedCount: 7 }, { code: 'app_stopped', affectedCount: 1 },
      ] },
    ]);
  });

  it('ties pressure, backup and paused reasons to the existing health/operations thresholds and recovers', () => {
    const input = { diskPercent: 85, memory: { used: 95, total: 100 },
      backupState: { status: 'failed', error: 'invented-secret-error' }, cosStatus: { paused: true } };
    const first = project(input);
    expect(place(first, 'nexus').attentionSignals).toEqual([
      { source: 'health', severity: 'error', signalCount: 1, reasons: [
        { code: 'backup_failure', affectedCount: null }, { code: 'cos_paused', affectedCount: null },
        { code: 'memory_critical', affectedCount: null }, { code: 'runtime_data_disk_pressure', affectedCount: null },
      ] },
      { source: 'operations', severity: 'error', signalCount: 1, reasons: [
        { code: 'backup_failure', affectedCount: null }, { code: 'cos_paused', affectedCount: null },
      ] },
    ]);
    expect(place(project({ diskPercent: 95, memory: { used: 85, total: 100 } }), 'nexus').attentionSignals[0].reasons).toEqual([
      { code: 'memory_pressure', affectedCount: null }, { code: 'runtime_data_disk_critical', affectedCount: null },
    ]);
    const healthy = project({ diskPercent: 84, memory: { used: 84, total: 100 }, backupState: { status: 'complete' }, cosStatus: { paused: false } });
    expect(place(healthy, 'nexus').attentionSignals).toEqual([]);
    expect(place(healthy, 'nexus').status).toBe('active');
  });
});
