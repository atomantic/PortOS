/**
 * The two capability questions this hook answers on the caller's behalf (#4826).
 *
 * `supports` and `acceptsInput` are bound closures over the selected peer's
 * status snapshot precisely so no form has to hold that snapshot itself. The
 * underlying `peerModelAcceptsInput` takes its status as an OPTIONAL third
 * argument, and omitting it falls silently back to the pre-#4826 reading — so a
 * page that reached for the raw helper would fail OPEN with nothing to catch
 * it. These cases are what make that binding load-bearing rather than stylistic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ peers: [] }));

vi.mock('../services/apiSystem.js', () => ({
  getInstances: vi.fn(async () => ({ peers: state.peers })),
}));

const { useFederatedMediaTarget } = await import('./useFederatedMediaTarget');

const CAPABILITY = {
  kind: 'image',
  engine: 'local',
  engineName: 'Local image',
  modelId: 'peer-flux',
  modelName: 'Example Model',
  ready: true,
  unavailableReason: null,
  runtimeReady: true,
  platformSupported: true,
  cudaRequired: false,
  cudaState: 'available',
  inputAssets: { roles: ['initImage'], required: false, maxCount: 4 },
};

const peer = ({ features, capability = CAPABILITY } = {}) => ({
  id: 'peer-example',
  name: 'Example GPU',
  status: 'online',
  enabled: true,
  mediaProvider: { enabled: true, imageModels: [{ engine: 'local', modelId: 'peer-flux' }] },
  mediaProviderStatus: {
    state: 'ready',
    checkedAt: new Date().toISOString(),
    freshUntil: new Date(Date.now() + 60_000).toISOString(),
    snapshot: {
      ...(features ? { features } : {}),
      queue: { accepting: true, running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4 },
      capabilities: [capability],
    },
  },
});

// Select the only opted-in peer and wait for its model to resolve, so the bound
// closures have something to close over.
const selectPeer = async () => {
  const { result } = renderHook(() => useFederatedMediaTarget('image'));
  await waitFor(() => expect(result.current.peers).toHaveLength(1));
  await act(async () => { result.current.setPeerId('peer-example'); });
  await waitFor(() => expect(result.current.model?.modelId).toBe('peer-flux'));
  return result;
};

describe('useFederatedMediaTarget — bound capability questions', () => {
  beforeEach(() => {
    state.peers = [];
  });

  it('reads a published feature list as the answer for both questions', async () => {
    state.peers = [peer({ features: ['lyrics', 'inputAssets'] })];
    const result = await selectPeer();
    expect(result.current.supports('inputAssets')).toBe(true);
    expect(result.current.acceptsInput('initImage')).toBe(true);
    // Advertised roles still gate per model — the build speaking conditioning
    // does not mean this model takes every slot.
    expect(result.current.acceptsInput('referenceImages')).toBe(false);
  });

  // The case a page could not get wrong once the closure is bound, and would
  // have gotten wrong by simply omitting the optional status argument.
  it('refuses conditioning when the peer published a list that omits it', async () => {
    state.peers = [peer({ features: ['lyrics'] })];
    const result = await selectPeer();
    expect(result.current.supports('inputAssets')).toBe(false);
    // The capability still carries a roles array; the peer's own vocabulary
    // overrules it, so the form must not offer the render.
    expect(result.current.acceptsInput('initImage')).toBe(false);
  });

  // The overlap release: a peer on the previous build publishes no list at all
  // and is read through the block it does send.
  it('falls back to the advertised block when no list was published', async () => {
    state.peers = [peer()];
    const result = await selectPeer();
    expect(result.current.supports('inputAssets')).toBe(true);
    expect(result.current.acceptsInput('initImage')).toBe(true);
  });

  it('answers false with no peer selected rather than throwing', async () => {
    const { result } = renderHook(() => useFederatedMediaTarget('image'));
    await act(async () => {});
    expect(result.current.isRemote).toBe(false);
    expect(result.current.supports('lyrics')).toBe(false);
    expect(result.current.acceptsInput('initImage')).toBe(false);
  });
});
