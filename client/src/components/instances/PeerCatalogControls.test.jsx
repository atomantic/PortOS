import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PeerCatalogControls from './PeerCatalogControls';
import { getPeerCatalogReview, getPeerCatalogReviews, savePeerCatalogReview } from '../../services/api';
vi.mock('../../services/api', () => ({
  getPeerCatalogReview: vi.fn(), getPeerCatalogReviews: vi.fn(), savePeerCatalogReview: vi.fn(),
}));
const hostInstanceId = '11111111-1111-4111-8111-111111111111';
const candidates = [{ backend: 'lmstudio', catalogKey: 'example-model', name: 'Example model' },
  { backend: 'lmstudio', catalogKey: 'second-model', name: 'Second model' }];
const observation = { backend: 'lmstudio', catalogKey: 'example-model', name: 'Example model',
  sourceRepo: 'example/model-GGUF', runtime: 'observed-runtime-fingerprint', destinationDigest: 'destination-fingerprint' };
const fields = {
  'Pinned source commit': 'a'.repeat(40), 'GGUF file name': 'example-q4.gguf',
  'Artifact SHA-256': 'b'.repeat(64), 'Exact download size (bytes)': '1024',
  'Reviewed license': 'MIT', 'Required runtime memory (bytes)': '2048',
};
beforeEach(() => {
  vi.clearAllMocks();
  getPeerCatalogReviews.mockResolvedValue({ candidates, reviews: [] });
  getPeerCatalogReview.mockResolvedValue(observation);
});
async function choose(onPrepare = vi.fn()) {
  render(<PeerCatalogControls hostInstanceId={hostInstanceId} disabled={false} onPrepare={onPrepare} />);
  expect(getPeerCatalogReviews).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Choose a catalog model' }));
  fireEvent.change(await screen.findByLabelText('Catalog model (LM Studio)'), { target: { value: 'example-model' } });
  return onPrepare;
}

describe('operator catalog review', () => {
  it('records explicit source and runtime review against the exact receiver observation without executing', async () => {
    savePeerCatalogReview.mockImplementation(async value => value);
    const onPrepare = await choose();
    fireEvent.click(screen.getByRole('button', { name: 'Review catalog source on this host' }));
    await screen.findByText(observation.runtime);
    expect(screen.getByRole('link', { name: observation.sourceRepo }).getAttribute('href')).toBe('https://huggingface.co/example/model-GGUF');
    const save = screen.getByRole('button', { name: 'Save local catalog review' });
    expect(save.disabled).toBe(true);
    for (const [label, value] of Object.entries(fields)) {
      expect(screen.getByLabelText(label).value).toBe('');
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByLabelText(/I reviewed this pinned source/));
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed compatibility/));
    fireEvent.click(save);
    await screen.findByText(/Local review saved: example-q4.gguf/);
    expect(savePeerCatalogReview).toHaveBeenCalledWith({
      backend: 'lmstudio', catalogKey: 'example-model', sourceRevision: fields['Pinned source commit'],
      fileName: 'example-q4.gguf', artifactDigest: fields['Artifact SHA-256'], downloadBytes: 1024,
      license: 'MIT', runtimeMemoryBytes: 2048, runtime: observation.runtime,
      sourceLicenseReviewed: true, runtimeCompatibilityReviewed: true,
    }, { silent: true });
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it('prepares only the catalog intent for the peer, without borrowing a local review or accepting its license', async () => {
    const onPrepare = await choose();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare catalog installation on remote peer' }));
    expect(onPrepare).toHaveBeenCalledWith({ action: 'catalog.install', backend: 'lmstudio', catalogKey: 'example-model' });
    expect(getPeerCatalogReview).not.toHaveBeenCalled();
    expect(savePeerCatalogReview).not.toHaveBeenCalled();
  });

  it('drops a stale runtime observation and requires a new review when the selected model changes', async () => {
    let resolveOld;
    getPeerCatalogReview.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ ...observation, catalogKey: 'second-model', runtime: 'second-runtime' });
    await choose();
    fireEvent.click(screen.getByRole('button', { name: 'Review catalog source on this host' }));
    await waitFor(() => expect(getPeerCatalogReview).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Catalog model (LM Studio)'), { target: { value: 'second-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review catalog source on this host' }));
    await screen.findByText('second-runtime');
    await act(async () => resolveOld(observation));
    expect(screen.queryByText(observation.runtime)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save local catalog review' }).disabled).toBe(true);
    expect(savePeerCatalogReview).not.toHaveBeenCalled();
  });
});
