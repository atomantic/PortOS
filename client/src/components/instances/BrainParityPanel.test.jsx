import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  runBrainParityCheck: vi.fn(),
}));

import { runBrainParityCheck } from '../../services/api';
import BrainParityPanel from './BrainParityPanel';

const PEER = { id: 'peer-local-1', instanceId: 'inst-peer-1', name: 'Example Peer' };

const summary = (overrides = {}) => ({
  total: 0,
  'in-parity': 0,
  'local-only': 0,
  'peer-only': 0,
  diverged: 0,
  ...overrides,
});

const report = (overrides = {}) => ({
  peerId: 'peer-local-1',
  peerInstanceId: 'inst-peer-1',
  checkedAt: new Date().toISOString(),
  available: true,
  checksums: { local: 'a', peer: 'a', match: true },
  summary: summary(),
  byType: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BrainParityPanel', () => {
  it('reads "not checked" with no stored report', () => {
    render(<BrainParityPanel peer={PEER} report={null} />);
    expect(screen.getByText('not checked')).toBeInTheDocument();
  });

  it('summarizes a clean stored report as in parity', () => {
    render(<BrainParityPanel peer={PEER} report={report({ summary: summary({ total: 12, 'in-parity': 12 }) })} />);
    expect(screen.getByText('in parity')).toBeInTheDocument();
  });

  it('counts every out-of-parity class in the header', () => {
    render(
      <BrainParityPanel
        peer={PEER}
        report={report({ summary: summary({ total: 10, 'in-parity': 6, 'local-only': 2, 'peer-only': 1, diverged: 1 }) })}
      />,
    );
    expect(screen.getByText('4 out of parity')).toBeInTheDocument();
  });

  it('flags a checksum mismatch even when every record id and clock lines up', async () => {
    const user = userEvent.setup();
    render(
      <BrainParityPanel
        peer={PEER}
        report={report({
          summary: summary({ total: 5, 'in-parity': 5 }),
          checksums: { local: 'a', peer: 'b', match: false },
        })}
      />,
    );

    expect(screen.getByText('content mismatch')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Brain parity/ }));
    expect(screen.getByText(/whole-brain checksums differ/)).toBeInTheDocument();
  });

  it('lists the diverged record ids per entity type once expanded', async () => {
    const user = userEvent.setup();
    render(
      <BrainParityPanel
        peer={PEER}
        report={report({
          summary: summary({ total: 3, 'in-parity': 1, 'local-only': 1, 'peer-only': 1 }),
          byType: [{
            type: 'people',
            counts: summary({ total: 3, 'in-parity': 1, 'local-only': 1, 'peer-only': 1 }),
            records: [{ id: 'rec-only-here', status: 'local-only' }, { id: 'rec-only-there', status: 'peer-only' }],
          }],
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Brain parity/ }));

    expect(screen.getByText('people')).toBeInTheDocument();
    expect(screen.getByText(/rec-only-here, rec-only-there/)).toBeInTheDocument();
  });

  it('does not claim parity when the peer returned no checksum', async () => {
    // Ids and clocks matched, but bodies were never compared — reporting green
    // here would claim a verification that did not happen.
    const user = userEvent.setup();
    render(
      <BrainParityPanel
        peer={PEER}
        report={report({
          summary: summary({ total: 5, 'in-parity': 5 }),
          checksums: { local: 'a', peer: null, match: null },
        })}
      />,
    );

    expect(screen.getByText('unverified')).toBeInTheDocument();
    expect(screen.queryByText('in parity')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Brain parity/ }));
    expect(screen.getByText(/no brain checksum/)).toBeInTheDocument();
    expect(screen.queryByText('every record matches')).not.toBeInTheDocument();
  });

  it('says a content mismatch will NOT self-heal — equal clocks defeat last-writer-wins', async () => {
    const user = userEvent.setup();
    render(
      <BrainParityPanel
        peer={PEER}
        report={report({
          summary: summary({ total: 5, 'in-parity': 5 }),
          checksums: { local: 'a', peer: 'b', match: false },
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Brain parity/ }));
    expect(screen.getByText(/last-writer-wins skips the peer/)).toBeInTheDocument();
    expect(screen.getByText(/Edit the record on the side you want to win/)).toBeInTheDocument();
  });

  it('drops a fresh report when the peer identity behind the card changes', async () => {
    const user = userEvent.setup();
    runBrainParityCheck.mockResolvedValue({
      reports: [report({ summary: summary({ total: 4, 'in-parity': 3, 'peer-only': 1 }) })],
    });

    const { rerender } = render(<BrainParityPanel peer={PEER} report={null} />);
    await user.click(screen.getByRole('button', { name: /Check/ }));
    await waitFor(() => expect(screen.getByText('1 out of parity')).toBeInTheDocument());

    // The install behind this address was replaced: same local peer id, new
    // instanceId. The old install's verdict must not carry over.
    rerender(<BrainParityPanel peer={{ ...PEER, instanceId: 'inst-peer-2' }} report={null} />);

    await waitFor(() => expect(screen.getByText('not checked')).toBeInTheDocument());
  });

  it('explains an unreachable peer instead of reporting divergence', async () => {
    const user = userEvent.setup();
    render(<BrainParityPanel peer={PEER} report={{ available: false, reason: 'peer-unreachable' }} />);

    expect(screen.getByText('unreachable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Brain parity/ }));
    expect(screen.getByText(/did not answer/)).toBeInTheDocument();
  });

  it('runs the check on demand and shows the fresh result', async () => {
    const user = userEvent.setup();
    runBrainParityCheck.mockResolvedValue({
      reports: [report({ summary: summary({ total: 4, 'in-parity': 3, 'peer-only': 1 }) })],
    });

    render(<BrainParityPanel peer={PEER} report={null} />);
    await user.click(screen.getByRole('button', { name: /Check/ }));

    expect(runBrainParityCheck).toHaveBeenCalledWith('peer-local-1', { silent: true });
    await waitFor(() => expect(screen.getByText('1 out of parity')).toBeInTheDocument());
    // Auto-expands so the result is readable without a second click.
    expect(screen.getByText('4 records compared')).toBeInTheDocument();
  });

  it('surfaces an inline error when the check fails, without toasting', async () => {
    const user = userEvent.setup();
    runBrainParityCheck.mockRejectedValue(new Error('boom'));

    render(<BrainParityPanel peer={PEER} report={null} />);
    await user.click(screen.getByRole('button', { name: /Brain parity/ }));
    await user.click(screen.getByRole('button', { name: /Check/ }));

    await waitFor(() => expect(screen.getByText(/Parity check failed/)).toBeInTheDocument());
  });

  it('does not run the audit just because the panel rendered', () => {
    render(<BrainParityPanel peer={PEER} report={null} />);
    expect(runBrainParityCheck).not.toHaveBeenCalled();
  });
});
