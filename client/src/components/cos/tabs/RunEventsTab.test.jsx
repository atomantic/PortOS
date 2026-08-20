import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getRunEventStats: vi.fn(),
  getRunEventProjections: vi.fn(),
  getRunEventDiagnostic: vi.fn(),
  getRunReconciliation: vi.fn(),
  repairRunRecords: vi.fn(),
}));

vi.mock('../../../services/api', () => api);

import RunEventsTab, { projectionAnnotations, summarizeEventData, describeFinding } from './RunEventsTab';

const CLEAN_REPORT = {
  checkedAt: '2026-08-18T13:00:00.000Z',
  findings: [],
  summary: { checked: 1, agentOnly: 0, findings: 0, repairable: 0, byFinding: {} },
};

const finding = (overrides = {}) => ({
  runId: 'run-a',
  agentId: 'agent-a',
  taskId: 'task-a',
  lastEventAt: '2026-08-18T11:00:00.000Z',
  finding: 'record-open',
  repairable: true,
  detail: { ledgerStatus: 'failed', ledgerEndedAt: '2026-08-18T11:00:00.000Z', ledgerSuccess: false },
  ...overrides,
});

const STATS = {
  activeEvents: 12,
  archivedEvents: 3,
  maxActiveEvents: 5000,
  maxRetainedEvents: 10000,
  maxEventAgeDays: 30,
  oldestEventAt: '2026-08-01T00:00:00.000Z',
};

const projection = (overrides = {}) => ({
  id: 'run-a',
  runId: 'run-a',
  agentId: 'agent-a',
  taskId: 'task-a',
  status: 'completed',
  startedAt: '2026-08-18T10:00:00.000Z',
  endedAt: '2026-08-18T11:00:00.000Z',
  durationMs: 3600000,
  exitCode: 0,
  success: true,
  orphaned: false,
  interrupted: false,
  paused: false,
  recoveryCount: 0,
  handoffCount: 0,
  reconnectCount: 0,
  pauseCount: 0,
  owner: null,
  outputBytes: null,
  lastOutputAt: null,
  prVerified: null,
  eventCount: 2,
  firstEventAt: '2026-08-18T10:00:00.000Z',
  lastEventAt: '2026-08-18T11:00:00.000Z',
  trace: [],
  ...overrides,
});

const renderTab = (path = '/cos/run-events') => render(
  <MemoryRouter initialEntries={[path]}>
    <RunEventsTab />
  </MemoryRouter>
);

describe('RunEventsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getRunEventStats.mockResolvedValue(STATS);
    api.getRunReconciliation.mockResolvedValue(CLEAN_REPORT);
    api.repairRunRecords.mockResolvedValue({ ...CLEAN_REPORT, repaired: [], skipped: 0 });
    api.getRunEventProjections.mockResolvedValue([projection()]);
    api.getRunEventDiagnostic.mockResolvedValue({
      projection: projection(),
      events: [
        { eventId: 'e1', kind: 'run.spawned', at: '2026-08-18T10:00:00.000Z', data: { providerId: 'demo-cli' } },
        { eventId: 'e2', kind: 'run.finalized', at: '2026-08-18T11:00:00.000Z', data: { success: true, exitCode: 0 } },
      ],
    });
  });

  it('renders the ledger bound so "why is this run missing" has an answer', async () => {
    renderTab();
    expect(await screen.findByText('12 / 5000')).toBeInTheDocument();
    expect(screen.getByText('10000 events · 30d')).toBeInTheDocument();
  });

  it('replays the run named by ?run= without the user clicking anything', async () => {
    renderTab('/cos/run-events?run=run-a');

    expect(await screen.findByText('run.spawned')).toBeInTheDocument();
    expect(screen.getByText('run.finalized')).toBeInTheDocument();
    expect(api.getRunEventDiagnostic).toHaveBeenCalledWith('run-a', { silent: true });
  });

  it('puts the selection in the URL, not in local state', async () => {
    // Same contract as every other selectable view: the open diagnostic has to
    // survive a reload and be pasteable to someone else.
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByText('run-a'));

    expect(api.getRunEventDiagnostic).toHaveBeenCalledWith('run-a', { silent: true });
  });

  it('distinguishes an unreachable server from a genuinely empty ledger', async () => {
    // `[]` means "nothing has happened yet"; a failed fetch means "we do not
    // know". Rendering the reassuring empty state for the second would hide a
    // broken server behind a calm screen.
    api.getRunEventStats.mockRejectedValue(new Error('offline'));
    api.getRunEventProjections.mockRejectedValue(new Error('offline'));
    renderTab();

    expect(await screen.findByText(/Could not read the run event ledger/)).toBeInTheDocument();
  });

  it('shows the empty state when the ledger is genuinely empty', async () => {
    api.getRunEventProjections.mockResolvedValue([]);
    renderTab();

    expect(await screen.findByText(/No lifecycle events recorded yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
  });
});

describe('projectionAnnotations', () => {
  it('lists only the counts that actually happened', () => {
    expect(projectionAnnotations(projection())).toEqual([]);
    expect(projectionAnnotations(projection({ recoveryCount: 3, orphaned: true, prVerified: false })))
      .toEqual(['3 recovery events', 'orphaned', 'PR unverified']);
  });

  it('says nothing about a PR that was verified, or never checked', () => {
    expect(projectionAnnotations(projection({ prVerified: true }))).toEqual([]);
    expect(projectionAnnotations(projection({ prVerified: null }))).toEqual([]);
  });
});

describe('summarizeEventData', () => {
  it('renders scalars inline and names a redacted stub as redacted', () => {
    expect(summarizeEventData({ exitCode: 0, success: true })).toBe('exitCode=0  success=true');
    expect(summarizeEventData({ prompt: { redacted: 'content', chars: 900 } })).toBe('prompt=«content»');
  });

  it('drops nulls rather than printing them as noise', () => {
    expect(summarizeEventData({ branch: null, category: 'pr-missing' })).toBe('category=pr-missing');
  });
});

describe('RunEventsTab — a failed detail fetch is not an empty run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getRunEventStats.mockResolvedValue(STATS);
    api.getRunEventProjections.mockResolvedValue([projection()]);
  });

  it('says the fetch failed rather than "this run has no events"', async () => {
    // One is a statement about the ledger, the other about the network. The
    // reassuring "may have aged out" copy would hide the second behind the first.
    api.getRunEventDiagnostic.mockRejectedValue(new Error('offline'));
    renderTab('/cos/run-events?run=run-a');

    expect(await screen.findByText(/Could not load this run's events/)).toBeInTheDocument();
    expect(screen.queryByText(/may have aged out/)).not.toBeInTheDocument();
  });

  it('still says "no events in the ledger" when the server genuinely has none', async () => {
    api.getRunEventDiagnostic.mockResolvedValue({ projection: null, events: [] });
    renderTab('/cos/run-events?run=run-a');

    expect(await screen.findByText(/may have aged out/)).toBeInTheDocument();
  });
});

describe('RunEventsTab — reconciliation panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getRunEventStats.mockResolvedValue(STATS);
    api.getRunEventProjections.mockResolvedValue([projection()]);
    api.getRunEventDiagnostic.mockResolvedValue({ projection: projection(), events: [] });
    api.getRunReconciliation.mockResolvedValue(CLEAN_REPORT);
    api.repairRunRecords.mockResolvedValue({ ...CLEAN_REPORT, repaired: [], skipped: 0 });
  });

  it('says the record and the stream agree when nothing drifted', async () => {
    renderTab();
    expect(await screen.findByText('Every run record agrees with the stream that produced it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /from ledger/ })).not.toBeInTheDocument();
  });

  it('distinguishes "could not check" from "nothing to fix"', async () => {
    api.getRunReconciliation.mockRejectedValue(new Error('offline'));
    renderTab();
    expect(await screen.findByText(/Could not compare the ledger against the run records/)).toBeInTheDocument();
  });

  it('lists a drift finding and offers to repair only the repairable one', async () => {
    api.getRunReconciliation.mockResolvedValue({
      ...CLEAN_REPORT,
      findings: [finding(), finding({ runId: 'run-b', finding: 'ledger-open', repairable: false, detail: { ledgerStatus: 'running', recordEndedAt: '2026-08-18T11:00:00.000Z' } })],
      summary: { ...CLEAN_REPORT.summary, checked: 2, findings: 2, repairable: 1 },
    });
    renderTab();
    expect(await screen.findByText(/Record still open · repairable/)).toBeInTheDocument();
    expect(screen.getByText('Ledger missed the close')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close 1 from ledger/ })).toBeInTheDocument();
  });

  it('confirms before closing any record, and reloads the ledger afterwards', async () => {
    api.getRunReconciliation.mockResolvedValue({
      ...CLEAN_REPORT,
      findings: [finding()],
      summary: { ...CLEAN_REPORT.summary, findings: 1, repairable: 1 },
    });
    api.repairRunRecords.mockResolvedValue({
      ...CLEAN_REPORT,
      repaired: [{ runId: 'run-a', from: 'failed', success: false, endTime: '2026-08-18T11:00:00.000Z' }],
      skipped: 0,
    });
    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: /Close 1 from ledger/ }));
    expect(api.repairRunRecords).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Close records' }));
    expect(api.repairRunRecords).toHaveBeenCalledWith({ limit: 100 });
    expect(await screen.findByText('Closed 1 run record from the ledger.')).toBeInTheDocument();
    // The repair appended an event, so the projections and stats it changed are re-read.
    expect(api.getRunEventProjections).toHaveBeenCalledTimes(2);
  });

  it('does not report a skipped repair as nothing left to do', async () => {
    api.getRunReconciliation.mockResolvedValue({
      ...CLEAN_REPORT,
      findings: [finding()],
      summary: { ...CLEAN_REPORT.summary, findings: 1, repairable: 1 },
    });
    // The record is still open — saying "nothing left to close" would claim the
    // drift is gone while it is still listed on screen.
    api.repairRunRecords.mockResolvedValue({ ...CLEAN_REPORT, repaired: [], skipped: 1 });
    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: /Close 1 from ledger/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Close records' }));
    expect(await screen.findByText(/Left 1 run record alone/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing left to close/)).not.toBeInTheDocument();
  });

  it('hides the panel entirely for an empty ledger', async () => {
    api.getRunEventProjections.mockResolvedValue([]);
    api.getRunReconciliation.mockResolvedValue({ ...CLEAN_REPORT, summary: { ...CLEAN_REPORT.summary, checked: 0 } });
    renderTab();
    expect(await screen.findByText(/No lifecycle events recorded yet/)).toBeInTheDocument();
    expect(screen.queryByText('Ledger vs. run records')).not.toBeInTheDocument();
  });
});

describe('describeFinding', () => {
  it('names both sides of a verdict disagreement', () => {
    expect(describeFinding({ finding: 'verdict-mismatch', detail: { ledgerSuccess: true, recordSuccess: false } }))
      .toBe('ledger success vs record failure');
  });

  it('says which side is behind for a missing close', () => {
    expect(describeFinding({ finding: 'ledger-open', detail: { ledgerStatus: 'running' } }))
      .toBe('ledger running, record closed');
  });

  it('falls back to the ledger status for the remaining findings', () => {
    expect(describeFinding({ finding: 'record-open', detail: { ledgerStatus: 'failed' } })).toBe('ledger failed');
    expect(describeFinding({ finding: 'record-missing', detail: {} })).toBe('ledger unknown');
  });
});
