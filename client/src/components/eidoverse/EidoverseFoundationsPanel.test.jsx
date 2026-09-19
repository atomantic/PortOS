/**
 * The promote panel is the only surface that tells the user which ownership
 * layer a foundation sits in and WHY a promote was refused (#7455). The server
 * answers a refused promote with a 200, so the regression these pin is the one
 * a status-code check cannot: a refusal rendered as success, and a refusal
 * whose reasons are dropped instead of shown.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  listEidoverseFoundations: vi.fn(),
  getEidoverseContributions: vi.fn(),
  recordEidoverseFoundation: vi.fn(),
  packageEidoverseFoundationCandidate: vi.fn(),
  promoteEidoverseFoundation: vi.fn(),
  withdrawEidoverseFoundation: vi.fn(),
}));

import {
  getEidoverseContributions,
  listEidoverseFoundations,
  promoteEidoverseFoundation,
  recordEidoverseFoundation,
  withdrawEidoverseFoundation,
} from '../../services/api';
import EidoverseFoundationsPanel from './EidoverseFoundationsPanel';

const foundation = (overrides = {}) => ({
  id: 'tide-beacon',
  layer: 'vernacular',
  kind: 'controller',
  title: 'Tide Beacon',
  summary: 'A beacon that keeps pulsing between mind wakes.',
  contributionId: 'beacon-relay-demo',
  body: { affordance: { inspect: 'reads the pulse count' } },
  style: { motif: 'weathered brass' },
  assay: null,
  candidate: null,
  promotedAt: null,
  updatedAt: '2026-03-04T05:06:07.000Z',
  ...overrides,
});

/** A local copy of a peer's promoted foundation, as the list endpoint serves it. */
const inheritedFoundation = () => foundation({
  layer: 'baseline',
  provenance: { originInstanceId: 'instance-origin-peer', authorKind: 'mind', createdAt: '2026-03-01T00:00:00.000Z' },
  inheritance: {
    type: 'inherited-from', originInstanceId: 'instance-origin-peer', foundationId: 'tide-beacon',
    fingerprint: 'a'.repeat(64), packagedAt: '2026-03-01T01:00:00.000Z',
    sourceInstanceId: 'instance-relay-peer', inheritedAt: '2026-03-04T05:06:07.000Z',
  },
  lineage: [
    { type: 'inherited', at: '2026-03-04T05:06:07.000Z', originInstanceId: 'instance-origin-peer', sourceInstanceId: 'instance-relay-peer' },
    { type: 'assayed', at: '2026-03-01T00:30:00.000Z', pass: true },
  ],
});

const listing = (foundations, counts) => ({
  foundations,
  counts: counts || { vernacular: foundations.length, baseline: 0, candidates: 0 },
});

// Settle the initial load OUTSIDE the act() a click needs: React does not commit
// while an async act callback is still running, so a findBy* inside one never
// sees the list the effect just fetched.
const renderPanel = async () => {
  const view = render(<MemoryRouter><EidoverseFoundationsPanel /></MemoryRouter>);
  await act(async () => {});
  return view;
};

afterEach(() => { vi.clearAllMocks(); });

describe('the Eidoverse foundations promote panel', () => {
  it('shows a refused promote as a refusal with its reasons, and leaves the layer where it was', async () => {
    listEidoverseFoundations.mockResolvedValue(listing([foundation()]));
    getEidoverseContributions.mockResolvedValue({ contributions: ['beacon-relay-demo'] });
    // A 200 carrying a refusal — the shape the route deliberately returns so
    // the reasons reach the author instead of a generic failure.
    promoteEidoverseFoundation.mockResolvedValue({
      outcome: 'refused',
      promoted: false,
      reasons: ['the agent-free resilience assay failed: the controller threw on restart-world-host'],
      findings: [],
    });
    await renderPanel();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Promote' })); });

    expect(screen.getByRole('status')).toHaveTextContent('Refused — nothing moved.');
    expect(screen.getByText(/the controller threw on restart-world-host/)).toBeInTheDocument();
    expect(screen.getByTitle(/Nothing leaves until you promote it/)).toHaveTextContent('Local');
  });

  it('marks a promoted foundation as shared baseline and stops offering to promote it again', async () => {
    listEidoverseFoundations
      .mockResolvedValueOnce(listing([foundation()]))
      .mockResolvedValue(listing([foundation({ layer: 'baseline', promotedAt: '2026-03-04T06:00:00.000Z' })], { vernacular: 0, baseline: 1, candidates: 1 }));
    getEidoverseContributions.mockResolvedValue({ contributions: ['beacon-relay-demo'] });
    promoteEidoverseFoundation.mockResolvedValue({ outcome: 'promoted', promoted: true, reasons: [], findings: [] });
    await renderPanel();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Promote' })); });

    await waitFor(() => expect(screen.getByTitle(/Your style layer stayed local/)).toHaveTextContent('Shared baseline'));
    expect(screen.getByRole('button', { name: 'Promote' })).toBeDisabled();
  });

  // #7632 — the panel is where an author actually retracts, so a Withdraw
  // reachable only by curl would leave the feature unusable.
  it('offers Withdraw only once a foundation is promoted, and reports the retraction as a pass', async () => {
    const promoted = foundation({ layer: 'baseline', promotedAt: '2026-03-04T06:00:00.000Z' });
    listEidoverseFoundations
      .mockResolvedValueOnce(listing([promoted], { vernacular: 0, baseline: 1, candidates: 1 }))
      .mockResolvedValue(listing([foundation()]));
    getEidoverseContributions.mockResolvedValue({ contributions: ['beacon-relay-demo'] });
    withdrawEidoverseFoundation.mockResolvedValue({ outcome: 'withdrawn', foundation: foundation(), reasons: [] });
    await renderPanel();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw' })); });

    // A withdrawal answers 200 like every other gate, so without its own
    // headline a success would render as "Refused — nothing moved."
    expect(screen.getByRole('status')).toHaveTextContent(/Withdrawn/);
    expect(withdrawEidoverseFoundation).toHaveBeenCalledWith('tide-beacon', expect.anything());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull());
  });

  it('never offers Withdraw for an inherited copy — this install never published it', async () => {
    listEidoverseFoundations.mockResolvedValue(listing([inheritedFoundation()], { vernacular: 0, baseline: 1, candidates: 0, inherited: 1 }));
    getEidoverseContributions.mockResolvedValue({ contributions: ['beacon-relay-demo'] });
    await renderPanel();

    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('refuses to submit an unparseable body instead of sending it to the promote gate', async () => {
    listEidoverseFoundations.mockResolvedValue(listing([]));
    getEidoverseContributions.mockResolvedValue({ contributions: ['beacon-relay-demo'] });
    await renderPanel();

    fireEvent.change(screen.getByLabelText('Id (lowercase slug)'), { target: { value: 'tide-beacon' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tide Beacon' } });
    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'A beacon.' } });
    fireEvent.change(screen.getByLabelText('Resilience-assay contribution'), { target: { value: 'beacon-relay-demo' } });
    fireEvent.change(screen.getByLabelText('Body — the promotable substance'), { target: { value: '{ not json' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record locally' })); });

    expect(screen.getByRole('alert')).toHaveTextContent('Body is not valid JSON');
    expect(recordEidoverseFoundation).not.toHaveBeenCalled();
  });

  it('says so when this install registers no replayable contribution, rather than offering an empty picker', async () => {
    listEidoverseFoundations.mockResolvedValue(listing([]));
    // An empty ARRAY is "nothing is registered" — a different state from a
    // failed fetch, and the one that makes the promote gate unreachable.
    getEidoverseContributions.mockResolvedValue({ contributions: [] });
    await renderPanel();

    expect(screen.getByText(/registers no replayable contribution/)).toBeInTheDocument();
  });

  it('marks a local copy of a peer foundation as Inherited and hides the promote/run-assay actions a re-share would need (#7461)', async () => {
    const inherited = inheritedFoundation();
    listEidoverseFoundations.mockResolvedValue(listing([inherited], { vernacular: 0, baseline: 1, candidates: 0, inherited: 1 }));
    getEidoverseContributions.mockResolvedValue({ contributions: ['beacon-relay-demo'] });
    await renderPanel();

    expect(screen.getByText('Inherited')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run assay' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/Inherited from instance instance-origin-peer/)).toBeInTheDocument();
  });

  /**
   * #7631: 'Load into the form below' sat OUTSIDE the guard that hides Promote
   * and Run assay, and copied the inherited id verbatim. Saving the form then
   * wrote a LOCAL record under that id with this install's own origin and no
   * edge, which promoted and was served to peers as this install's own work.
   */
  it('turns re-use of an inherited foundation into a derivation instead of a copy under the peer\'s own id (#7631)', async () => {
    listEidoverseFoundations.mockResolvedValue(listing([inheritedFoundation()], { vernacular: 0, baseline: 1, candidates: 0, inherited: 1 }));
    getEidoverseContributions.mockResolvedValue({ contributions: ['beacon-relay-demo'] });
    recordEidoverseFoundation.mockResolvedValue({ success: true });
    await renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Build on this in the form below' }));

    // The inherited id is NOT reused: that id is what made the copy look like
    // a re-author of this install's own foundation.
    const idField = screen.getByLabelText('Id (lowercase slug)');
    expect(idField.value).not.toBe('tide-beacon');
    expect(idField.value).toBe('tide-beacon-derived');
    expect(screen.getByText(/Building on/)).toBeInTheDocument();

    await act(async () => { fireEvent.submit(idField.closest('form')); });

    expect(recordEidoverseFoundation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tide-beacon-derived',
        derivedFrom: { originInstanceId: 'instance-origin-peer', foundationId: 'tide-beacon' },
      }),
      expect.anything(),
    );
  });
});
