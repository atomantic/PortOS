import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../services/apiCore.js', async importOriginal => ({ ...await importOriginal(), request }));
import MediaBatchImport from './MediaBatchImport';

const image = new File(['png'], 'portrait.png', { type: 'image/png' });
const video = new File(['mp4'], 'clip.mp4', { type: 'video/mp4' });
const pick = files => fireEvent.change(screen.getByLabelText('Upload / import'), { target: { files } });
const savedImage = { filename: 'upload-image.png', path: '/data/images/upload-image.png', metadata: { prompt: 'A paper boat', seed: 42 } };
const savedVideo = { id: 'upload-video', filename: 'upload-video.mp4', source: 'upload', prompt: 'Clouds' };
beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async path => {
    if (path === '/image-gen/upload') return savedImage;
    if (path === '/video-gen/upload') return savedVideo;
    return { collection: { id: 'collection-a', items: [] } };
  });
});

describe('shared gallery batch import', () => {
  it('posts a mixed batch through the Prompt gallery endpoints and reports unsupported and failed files independently', async () => {
    const imported = vi.fn();
    request.mockRejectedValueOnce(Object.assign(new Error('Image decoder rejected the bytes'), { code: 'UNSUPPORTED_IMAGE' }));
    render(<MediaBatchImport onImported={imported} />);
    pick([image, video, new File(['x'], 'unsafe.svg'), image]);
    await waitFor(() => expect(imported).toHaveBeenCalledTimes(2));
    expect(screen.getByText('2 of 4 imported')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Import queue' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Imports needing attention' })).getByText(/Unsupported type/)).toBeInTheDocument();
    expect(screen.getByText(/Image decoder rejected the bytes/)).toBeInTheDocument();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/image-gen/upload', '/video-gen/upload', '/image-gen/upload']);
    for (const [, options] of request.mock.calls) {
      expect(options.body).toBeInstanceOf(FormData);
      expect(options.silent).toBe(true);
    }
    expect(imported.mock.calls[1][0]).toMatchObject({ kind: 'image', ref: savedImage.filename, data: { prompt: 'A paper boat', seed: 42 } });
  });

  it('retries only assignment after an import succeeds, using the idempotent collection bulk endpoint', async () => {
    let failAssignment = true;
    request.mockImplementation(async path => {
      if (path === '/image-gen/upload') return savedImage;
      if (failAssignment) throw new Error('Collection temporarily unavailable');
      return { collection: { id: 'collection-a', items: [{ kind: 'image', ref: savedImage.filename }] } };
    });
    const imported = vi.fn();
    render(<MediaBatchImport collectionId="collection-a" onImported={imported} />);
    pick([image]);
    await screen.findByText(/Imported to History; collection assignment failed/);
    failAssignment = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed / cancelled' }));
    await screen.findByText('1 of 1 imported');
    expect(screen.queryByRole('region', { name: 'Imports needing attention' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Import queue' })).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path === '/image-gen/upload')).toHaveLength(1);
    const assignments = request.mock.calls.filter(([path]) => path === '/media/collections/collection-a/items/bulk');
    expect(assignments).toHaveLength(2);
    expect(JSON.parse(assignments[1][1].body)).toEqual({ add: [{ kind: 'image', ref: savedImage.filename }] });
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it('finishes the active file on cancellation and resumes only remaining files', async () => {
    let finish;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<MediaBatchImport />);
    pick([image, video]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel remaining' }));
    await act(async () => finish(savedImage));
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 of 2 imported')).toHaveClass('sr-only');
    expect(screen.queryByRole('list', { name: 'Import queue' })).not.toBeInTheDocument();
    expect(screen.queryByText('portrait.png')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Imports needing attention' })).getByText('clip.mp4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed / cancelled' }));
    await screen.findByText('2 of 2 imported');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('stops queued work and drops callbacks when its collection is left during an upload', async () => {
    let finish;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const imported = vi.fn();
    const view = render(<MediaBatchImport collectionId="old-collection" onImported={imported} />);
    pick([image, video]);
    view.unmount();
    await act(async () => finish(savedImage));
    expect(imported).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/image-gen/upload', '/media/collections/old-collection/items/bulk']);
  });
});

it('uses the current view callback when filters change during upload', async () => {
  let finish;
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const oldView = vi.fn();
  const newView = vi.fn();
  const view = render(<MediaBatchImport onImported={oldView} />);
  pick([image]);
  view.rerender(<MediaBatchImport onImported={newView} />);
  await act(async () => finish(savedImage));
  expect(oldView).not.toHaveBeenCalled();
  expect(newView).toHaveBeenCalledTimes(1);
});

it.each([undefined, 'collection-a'])('clears completed rows while later files remain queued or in progress (collection: %s)', async collectionId => {
  let finishImage;
  let finishVideo;
  let finishAssignment;
  request.mockImplementation(path => {
    if (path === '/image-gen/upload') return new Promise(resolve => { finishImage = resolve; });
    if (path === '/video-gen/upload') return new Promise(resolve => { finishVideo = resolve; });
    if (!finishAssignment) return new Promise(resolve => { finishAssignment = resolve; });
    return Promise.resolve({ collection: { id: collectionId, items: [] } });
  });
  render(<MediaBatchImport collectionId={collectionId} />);
  pick([image, video]);
  expect(within(screen.getByRole('list', { name: 'Import queue' })).getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText(/: queued/)).toBeInTheDocument();
  await act(async () => finishImage(savedImage));
  if (collectionId) {
    expect(screen.getByText(/: assigning/)).toBeInTheDocument();
    expect(screen.getByText('portrait.png')).toBeInTheDocument();
    await act(async () => finishAssignment({ collection: { id: collectionId, items: [] } }));
  }
  expect(screen.queryByText('portrait.png')).not.toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Import queue' })).getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveTextContent('1 of 2 imported');
  await act(async () => finishVideo(savedVideo));
  expect(screen.queryByRole('list', { name: 'Import queue' })).not.toBeInTheDocument();
  expect(screen.queryByText('clip.mp4')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveClass('sr-only');
  expect(screen.getByRole('status')).toHaveTextContent('2 of 2 imported');
});

it('keeps failed imports retryable when another batch is selected without retrying them implicitly', async () => {
  request.mockRejectedValueOnce(Object.assign(new Error('Image decoder rejected the bytes'), { code: 'UNSUPPORTED_IMAGE' }));
  render(<MediaBatchImport />);
  pick([image]);
  await screen.findByText(/Image decoder rejected the bytes/);
  pick([video]);
  await screen.findByText('1 of 2 imported');
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('region', { name: 'Imports needing attention' })).toHaveTextContent('portrait.png');
  expect(screen.queryByText('clip.mp4')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed / cancelled' }));
  await screen.findByText('2 of 2 imported');
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/image-gen/upload', '/video-gen/upload', '/image-gen/upload']);
  expect(screen.queryByRole('region', { name: 'Imports needing attention' })).not.toBeInTheDocument();
});

it('keeps inspection warnings separate from the completed upload queue', async () => {
  request.mockResolvedValueOnce({ ...savedVideo, importWarnings: ['Embedded metadata could not be inspected.'] });
  render(<MediaBatchImport />);
  pick([video]);
  await screen.findByText('1 of 1 imported');
  expect(screen.queryByRole('list', { name: 'Import queue' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Import warnings' })).toHaveTextContent('clip.mp4: Embedded metadata could not be inspected.');
  expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
});


it('keeps uncertain upload outcomes out of retry while allowing definitive failures to recover', async () => {
  request.mockRejectedValueOnce(new Error('Response lost'));
  request.mockRejectedValueOnce(Object.assign(new Error('Unsupported video bytes'), { code: 'UNSUPPORTED_VIDEO' }));
  render(<MediaBatchImport />);
  pick([image, video]);
  await screen.findByText(/Unsupported video bytes/);
  expect(screen.getByRole('region', { name: 'Uploads to check in History' })).toHaveTextContent('Retry will not upload this file again');
  expect(screen.getByRole('link', { name: 'Check Media History' })).toHaveAttribute('href', '/media/history');
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed / cancelled' }));
  await screen.findByText('1 of 2 imported');
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/image-gen/upload', '/video-gen/upload', '/video-gen/upload']);
  expect(screen.getByRole('region', { name: 'Uploads to check in History' })).toHaveTextContent('portrait.png');
});
