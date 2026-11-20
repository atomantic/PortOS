/**
 * The picker and `useFederatedMediaTarget` are tested together: the component is
 * deliberately stateless, so testing it against a hand-built `target` object
 * would only assert that the fixture renders — the interesting behaviour is the
 * hook's verdict reaching the caption, the dropdown suffix, and the submission
 * fields at the same time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getInstances = vi.fn();
vi.mock('../../services/apiSystem.js', () => ({
  getInstances: (...args) => getInstances(...args),
}));

const { useFederatedMediaTarget } = await import('../../hooks/useFederatedMediaTarget.js');
const { default: RemoteMediaTargetPicker } = await import('./RemoteMediaTargetPicker.jsx');

const CAPABILITY = {
  kind: 'image',
  engine: 'local',
  engineName: 'Local diffusers',
  modelId: 'flux2-klein',
  modelName: 'FLUX.2 Klein',
  ready: true,
  unavailableReason: null,
  runtimeReady: true,
  platformSupported: true,
  cudaRequired: false,
  cudaState: 'available',
};

const peer = ({
  allowlist = [{ engine: 'local', modelId: 'flux2-klein' }],
  capabilities = [CAPABILITY],
  freshForMs = 60_000,
  state = 'ready',
  queue = { accepting: true, running: 0, queued: 0, totalActive: 1, maxQueuedJobs: 4 },
  ...overrides
} = {}) => ({
  id: 'peer-example',
  name: 'Example GPU',
  status: 'online',
  enabled: true,
  mediaProvider: { enabled: true, imageModels: allowlist },
  mediaProviderStatus: {
    state,
    checkedAt: new Date().toISOString(),
    freshUntil: new Date(Date.now() + freshForMs).toISOString(),
    snapshot: { queue, capabilities },
  },
  ...overrides,
});

// A host that surfaces what the hook resolved, so a test can assert the exact
// body a generate route would receive without driving a whole page.
function Harness({ localBlockedReason = null, onTarget }) {
  const target = useFederatedMediaTarget('image');
  onTarget?.(target);
  return (
    <div>
      <RemoteMediaTargetPicker target={target} kind="image" localBlockedReason={localBlockedReason} />
      <span data-testid="submission">{JSON.stringify(target.submissionFields)}</span>
      <span data-testid="can-submit">{String(target.canSubmit)}</span>
    </div>
  );
}

const selectPeer = async (id = 'peer-example') => {
  fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: id } });
};

describe('RemoteMediaTargetPicker', () => {
  beforeEach(() => {
    getInstances.mockReset();
    vi.restoreAllMocks();
  });

  it('renders nothing until a peer is opted in as a media provider', async () => {
    getInstances.mockResolvedValue({
      peers: [{ id: 'peer-example', name: 'Example GPU', status: 'online', mediaProvider: { enabled: false } }],
    });
    render(<Harness />);
    await waitFor(() => expect(getInstances).toHaveBeenCalled());
    expect(screen.queryByRole('combobox', { name: /generation target/i })).not.toBeInTheDocument();
  });

  // The allowlist and the advertised capabilities are two independent lists and
  // the server admits only their intersection. Offering the union here would
  // list a model `assertFederatedMediaProviderSelection` refuses.
  it('offers only models present in BOTH the local allowlist and the peer’s capabilities', async () => {
    getInstances.mockResolvedValue({
      peers: [peer({
        allowlist: [{ engine: 'local', modelId: 'flux2-klein' }],
        capabilities: [
          CAPABILITY,
          { ...CAPABILITY, modelId: 'not-allowlisted', modelName: 'Some Other Model' },
        ],
      })],
    });
    render(<Harness />);
    await selectPeer();

    expect(screen.getByRole('option', { name: /FLUX\.2 Klein/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Some Other Model/ })).not.toBeInTheDocument();
  });

  // Two empty-list causes with two different fixes: nothing allowlisted locally
  // is a config gap on this machine, while an allowlist the peer answers with
  // nothing means the model went away on its side.
  it('separates “nothing allowlisted here” from “the peer is not advertising it”', async () => {
    getInstances.mockResolvedValue({ peers: [peer({ allowlist: [] })] });
    const { unmount } = render(<Harness />);
    await selectPeer();
    expect(screen.getByText(/no allowlisted image model/i)).toBeInTheDocument();
    unmount();

    getInstances.mockResolvedValue({ peers: [peer({ capabilities: [] })] });
    render(<Harness />);
    await selectPeer();
    expect(screen.getByText(/not advertising any allowlisted image model/i)).toBeInTheDocument();
  });

  // A snapshot probed as `ready` keeps saying `ready` after its window closes.
  // Trusting the stored state would leave Generate live against a peer the
  // server is about to refuse.
  it('blocks a peer whose capacity window has expired, in the caption and the dropdown', async () => {
    getInstances.mockResolvedValue({ peers: [peer({ freshForMs: -60_000 })] });
    render(<Harness />);
    await selectPeer();

    expect(screen.getByText(/capacity snapshot expired/i)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Example GPU \(stale\)/ })).toBeInTheDocument();
    expect(screen.getByTestId('can-submit')).toHaveTextContent('false');
  });

  // The provider allowlist is keyed on the (engine, modelId) PAIR — a payload
  // carrying the model id alone is refused, so the engine has to travel with it.
  it('reports the peer, its engine and its model id as one submission unit', async () => {
    getInstances.mockResolvedValue({ peers: [peer()] });
    render(<Harness />);
    await selectPeer();

    expect(screen.getByTestId('can-submit')).toHaveTextContent('true');
    expect(JSON.parse(screen.getByTestId('submission').textContent)).toEqual({
      mediaProviderPeerId: 'peer-example',
      mediaProviderEngine: 'local',
      modelId: 'flux2-klein',
    });
    expect(screen.getByText(/1\/4 shared slots active/)).toBeInTheDocument();
  });

  // The host's veto and the peer's readiness answer different questions, and a
  // form can be blocked by both — showing only one hides half the remedy.
  it('shows the host’s own veto alongside the peer readiness line', async () => {
    getInstances.mockResolvedValue({ peers: [peer()] });
    render(<Harness localBlockedReason="clear the init image to render on this peer" />);
    await selectPeer();

    expect(screen.getByText(/1\/4 shared slots active/)).toBeInTheDocument();
    expect(screen.getByText(/clear the init image/i)).toBeInTheDocument();
  });

  // A capacity window expires on the clock, not on a re-render, so the reading
  // behind an enabled button can already be wrong by the time it is clicked.
  it('re-derives at verify() time rather than trusting the last render', async () => {
    getInstances.mockResolvedValue({ peers: [peer()] });
    let target = null;
    render(<Harness onTarget={(value) => { target = value; }} />);
    await selectPeer();
    expect(target.verify()).toEqual({ ok: true });

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 120_000);
    expect(target.verify()).toEqual({ ok: false, message: expect.stringMatching(/capacity snapshot expired/i) });
  });

  // A peer switched off inside its freshness window still carries `state:
  // 'ready'`. The server rejects it with MEDIA_PROVIDER_PEER_DISABLED, so the
  // form must not advertise it as available.
  it('refuses a switched-off peer holding a fresh snapshot', async () => {
    getInstances.mockResolvedValue({ peers: [peer({ enabled: false })] });
    render(<Harness />);
    await selectPeer();

    expect(screen.getByTestId('can-submit')).toHaveTextContent('false');
    expect(screen.getByText(/peer connection is switched off/i)).toBeInTheDocument();
  });
});
