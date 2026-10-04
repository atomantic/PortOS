import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RenderPoolPicker from './RenderPoolPicker.jsx';
const state = vi.hoisted(() => ({ peers: [] }));
vi.mock('../../hooks/useFederatedMediaTarget.js', () => ({ useFederatedMediaTarget: () => state }));
vi.mock('../../lib/federatedMediaReadiness.js', () => ({
  federatedMediaModelsForPeer: (peer) => peer.models,
  peerMediaProviderSnapshot: (peer) => peer.snapshot,
  summarizePeerMediaQueue: () => ['0 running', '1 queued'],
}));
beforeEach(() => { cleanup(); state.peers = []; });
describe('project shot render pool', () => {
  it('saves explicit peer/model selection then placement and locks while saving', () => {
    state.peers = [{ id: 'peer', name: 'Example peer', models: [{ engine: 'local', modelId: 'model', modelName: 'Example model', hardwareEligible: true, ready: true }], snapshot: { queue: { maintenanceHeld: false } } }];
    const change = vi.fn();
    const view = render(<RenderPoolPicker settings={{}} change={change} />);
    expect(screen.getByRole('option', { name: 'Selected peers' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Example peer model'), { target: { value: 'model' } });
    expect(change).toHaveBeenLastCalledWith({ renderPool: { mode: 'local', peers: [{ peerId: 'peer', modelId: 'model' }] } });
    const settings = { renderPool: { mode: 'local', peers: [{ peerId: 'peer', modelId: 'model' }] } };
    view.rerender(<RenderPoolPicker settings={settings} change={change} />);
    fireEvent.change(screen.getByLabelText('Run shots on'), { target: { value: 'both' } });
    expect(change).toHaveBeenLastCalledWith({ renderPool: { ...settings.renderPool, mode: 'both' } });
    view.rerender(<RenderPoolPicker settings={settings} change={change} disabled />);
    expect(screen.getByRole('group').disabled).toBe(true);
    expect(screen.getByText(/Final composition export stays on this Mac/)).toBeTruthy();
  });
  it('shows missing selections without silently replacing their model', () => {
    render(<RenderPoolPicker settings={{ renderPool: { mode: 'peers', peers: [{ peerId: 'missing', modelId: 'old-model' }] } }} change={vi.fn()} />);
    expect(screen.getByRole('combobox').value).toBe('peers');
    expect(screen.getByRole('button', { name: /Remove unavailable selection/ })).toBeTruthy();
    expect(screen.getByText(/Production runs, lip-sync/)).toBeTruthy();
  });
});
