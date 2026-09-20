/**
 * Media Models — the catalog row owns BOTH of a model's deletes.
 *
 * The page used to render the catalog (with a read-only lock on built-ins) and
 * the on-disk HF cache as two disconnected lists, so freeing a built-in model's
 * weights meant scrolling past the whole catalog to find the same model again.
 * These tests pin the join: a catalog row whose repo is cached shows its size
 * and deletes its own weights (built-in included), and the cache section below
 * only lists downloads the catalog doesn't cover.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import MediaModels from './MediaModels';
import {
  setMediaModelEnabled,
  requestMediaModelSupport,
  listCachedModels,
  listMediaModelRegistry,
  deleteCachedModel,
  removeCustomMediaModel,
} from '../services/api';

const { textEncoderDownloadId, textEncoderDownloads } = vi.hoisted(() => {
  const prefix = '__text_encoder_option__:';
  return {
    textEncoderDownloadId: (id) => `${prefix}${id}`,
    textEncoderDownloads: {
      getStatus: vi.fn(),
      start: vi.fn(),
      cancel: vi.fn(),
      refresh: vi.fn(async () => {}),
      activeModelId: null,
      downloading: false,
    },
  };
});

vi.mock('../services/api', () => ({
  setMediaModelEnabled: vi.fn(),
  requestMediaModelSupport: vi.fn(),
  listCachedModels: vi.fn(),
  listMediaModelRegistry: vi.fn(),
  deleteCachedModel: vi.fn(),
  deleteLora: vi.fn(),
  addMediaModelFromHf: vi.fn(),
  patchCustomMediaModel: vi.fn(),
  removeCustomMediaModel: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../hooks/useModelDownloadStatus', () => ({
  useModelDownloadStatus: vi.fn(() => textEncoderDownloads),
  textEncoderDownloadId,
}));

const BUILT_IN = {
  id: 'example-video',
  name: 'Example Video Model',
  repo: 'example-org/example-video',
  kind: 'video',
  runtime: 'mlx',
  builtIn: true,
};
const CUSTOM = {
  id: 'hf-mine',
  name: 'My Model',
  repo: 'example-org/mine',
  kind: 'image',
  runner: 'mflux',
  builtIn: false,
};
const CACHED_BUILT_IN = {
  id: 'models--example-org--example-video',
  repo: 'example-org/example-video',
  label: 'Example Video Model (Video)',
  size: 12e9,
  sizeHuman: '12 GB',
};
const ORPHAN = {
  id: 'models--example-org--text-encoder',
  repo: 'example-org/text-encoder',
  label: 'Text Encoder',
  size: 9e9,
  sizeHuman: '9 GB',
};
const H3_TEXT_ENCODER = {
  id: 'heretic-bf16',
  label: 'Ultra-Heretic',
  description: 'Alternative MiniMax H3 prompt conditioner',
  repo: 'example-org/ultra-heretic',
  sizeBytes: 48e9,
  builtIn: false,
  modelIds: ['example-video'],
};
const STOCK_H3_TEXT_ENCODER = {
  id: 'stock',
  label: 'Stock — MiniMax H3',
  builtIn: true,
  modelIds: ['example-video'],
};
const CACHED_H3_TEXT_ENCODER = {
  id: 'models--example-org--ultra-heretic',
  repo: 'example-org/ultra-heretic',
  label: 'Ultra-Heretic (Text Encoder)',
  size: 48e9,
  sizeHuman: '48 GB',
};

const CACHE_RESPONSE = {
  models: [CACHED_BUILT_IN, CACHED_H3_TEXT_ENCODER, ORPHAN],
  loras: [],
  hubDir: '/example/hub',
  diskUsage: {},
};

describe('MediaModels catalog/cache join', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCachedModels.mockResolvedValue(CACHE_RESPONSE);
    listMediaModelRegistry.mockResolvedValue({
      video: [BUILT_IN], image: [CUSTOM], textEncoders: [STOCK_H3_TEXT_ENCODER, H3_TEXT_ENCODER],
    });
    deleteCachedModel.mockResolvedValue({});
    removeCustomMediaModel.mockResolvedValue({});
    textEncoderDownloads.getStatus.mockImplementation((id) => (
      id === textEncoderDownloadId(H3_TEXT_ENCODER.id)
        ? { id: H3_TEXT_ENCODER.id, cached: true, sizeBytes: H3_TEXT_ENCODER.sizeBytes }
        : null
    ));
  });

  it('shows the cached size on the catalog row and "not downloaded" when it is absent', async () => {
    render(<MediaModels />);
    await screen.findByText('Example Video Model');
    expect(screen.getByText('12 GB')).toBeInTheDocument();
    expect(screen.getByText(/weights not downloaded/)).toBeInTheDocument();
  });

  it('deletes a BUILT-IN model\'s weights from its own row, behind a confirm', async () => {
    render(<MediaModels />);
    const modelName = await screen.findByText('Example Video Model');
    const modelCard = modelName.closest('.bg-port-bg');
    fireEvent.click(within(modelCard).getByRole('button', { name: /Delete weights/ }));
    expect(deleteCachedModel).not.toHaveBeenCalled();

    const confirmPair = screen.getByRole('group', {
      name: 'Confirm deleting cached weights for Example Video Model',
    });
    fireEvent.click(within(confirmPair).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteCachedModel).toHaveBeenCalledWith(
      CACHED_BUILT_IN.id,
      { silent: true },
    ));
    // The row drops back to "not downloaded" without a refetch.
    await waitFor(() => expect(listCachedModels).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('12 GB')).not.toBeInTheDocument();
  });

  it('lists only cache dirs with no catalog entry under "Other cached weights"', async () => {
    render(<MediaModels />);
    await screen.findByText('Text Encoder');
    expect(screen.getByText(/Other cached weights \(1\)/)).toBeInTheDocument();
    // The built-in's cache dir is represented by its catalog row, not repeated.
    expect(screen.queryByText('Example Video Model (Video)')).not.toBeInTheDocument();
    // A managed H3 prompt conditioner is likewise represented by its own row.
    expect(screen.queryByText('Ultra-Heretic (Text Encoder)')).not.toBeInTheDocument();
  });

  it('manages H3 text encoders separately and deletes their cached weights behind a confirm', async () => {
    render(<MediaModels />);
    const encoderName = await screen.findByText('Ultra-Heretic');
    expect(screen.getByText(/Video text encoders \(2\)/)).toBeInTheDocument();

    const encoderCard = encoderName.closest('.bg-port-bg');
    fireEvent.click(within(encoderCard).getByRole('button', { name: /Delete weights/ }));
    const confirmPair = screen.getByRole('group', {
      name: 'Confirm deleting cached weights for Ultra-Heretic',
    });
    fireEvent.click(within(confirmPair).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteCachedModel).toHaveBeenCalledWith(
      CACHED_H3_TEXT_ENCODER.id,
      { silent: true },
    ));
    expect(textEncoderDownloads.refresh).toHaveBeenCalledTimes(1);
  });

  it('starts an explicit download for an uncached H3 text encoder', async () => {
    textEncoderDownloads.getStatus.mockImplementation((id) => (
      id === textEncoderDownloadId(H3_TEXT_ENCODER.id)
        ? { id: H3_TEXT_ENCODER.id, cached: false, sizeBytes: 0 }
        : null
    ));
    listCachedModels.mockResolvedValue({ ...CACHE_RESPONSE, models: [CACHED_BUILT_IN, ORPHAN] });
    render(<MediaModels />);
    const encoderName = await screen.findByText('Ultra-Heretic');
    const encoderCard = encoderName.closest('.bg-port-bg');
    fireEvent.click(within(encoderCard).getByRole('button', { name: /Download \(/ }));
    expect(textEncoderDownloads.start).toHaveBeenCalledWith(textEncoderDownloadId(H3_TEXT_ENCODER.id));
  });

  it('arms a separate confirm for removing a custom catalog entry', async () => {
    render(<MediaModels />);
    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/ }));
    expect(removeCustomMediaModel).not.toHaveBeenCalled();
    expect(screen.getByText('Remove from catalog?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeCustomMediaModel).toHaveBeenCalledWith(
      CUSTOM.id,
      { silent: true },
    ));
    expect(screen.getByText(/Video text encoders \(2\)/)).toBeInTheDocument();
  });
});

it('disables a catalog entry and queues a new model support request', async () => {
  setMediaModelEnabled.mockResolvedValue({ enabled: false });
  requestMediaModelSupport.mockResolvedValue({ id: 'task-support' });
  render(<MediaModels />);
  const disable = await screen.findAllByRole('button', { name: /^Disable / });
  fireEvent.click(disable[0]);
  await screen.findByRole('button', { name: /^Enable / });
  fireEvent.change(screen.getByLabelText('Model or method, source links, and desired capabilities'), { target: { value: 'Example image model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Investigate and open PR' }));
  await screen.findByText(/Request queued: task-support/);
  expect(requestMediaModelSupport).toHaveBeenCalledWith({ kind: 'image', request: 'Example image model' }, { silent: true });
});
