import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DigestTab from './DigestTab';

const api = vi.hoisted(() => ({
  getBrainLatestDigest: vi.fn(), getBrainLatestReview: vi.fn(),
  getBrainDigests: vi.fn(), getBrainReviews: vi.fn(),
  runBrainDigest: vi.fn(), runBrainReview: vi.fn()
}));
vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
const digest = { id: 'example-digest', digestText: 'Example saved digest', generatedAt: '2026-01-01' };
const review = { id: 'example-review', reviewText: 'Example saved review', generatedAt: '2026-01-01' };
beforeEach(() => {
  vi.resetAllMocks();
  api.getBrainLatestDigest.mockResolvedValue(null);
  api.getBrainLatestReview.mockResolvedValue(null);
  api.getBrainDigests.mockResolvedValue([]);
  api.getBrainReviews.mockResolvedValue([]);
});
afterEach(cleanup);

it('shows four independent failures and retries only the selected GET without generating', async () => {
  for (const name of ['getBrainLatestDigest', 'getBrainLatestReview', 'getBrainDigests', 'getBrainReviews']) {
    api[name].mockRejectedValue(new Error('Unavailable'));
  }
  render(<DigestTab />);
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(4));
  expect(screen.queryByText(/No daily digest/)).toBeNull();
  expect(screen.queryByText(/No weekly review/)).toBeNull();
  api.getBrainLatestDigest.mockResolvedValue(digest);
  fireEvent.click(screen.getByRole('button', { name: 'Retry daily digest' }));
  expect(await screen.findByText(digest.digestText)).toBeTruthy();
  expect(screen.getAllByRole('alert')).toHaveLength(3);
  expect(api.getBrainLatestDigest).toHaveBeenLastCalledWith({ silent: true });
  expect(api.getBrainDigests).toHaveBeenCalledTimes(1);
  expect(api.getBrainLatestReview).toHaveBeenCalledTimes(1);
  expect(api.getBrainReviews).toHaveBeenCalledTimes(1);
  expect(api.runBrainDigest).not.toHaveBeenCalled();
  expect(api.runBrainReview).not.toHaveBeenCalled();
});

it('preserves successful latest and history regions beside independent failures', async () => {
  api.getBrainLatestDigest.mockResolvedValue(digest);
  api.getBrainLatestReview.mockRejectedValue(new Error('Unavailable'));
  api.getBrainDigests.mockRejectedValue(new Error('Unavailable'));
  api.getBrainReviews.mockResolvedValue([review, { ...review, id: 'older', reviewText: 'Example older review' }]);
  render(<DigestTab />);
  expect(await screen.findByText(digest.digestText)).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: /Previous reviews/ }));
  expect(screen.getByText('Example older review')).toBeTruthy();
  expect(screen.getAllByRole('alert')).toHaveLength(2);
});

it('retains last good content and expanded history when generation refresh reads fail', async () => {
  api.getBrainLatestDigest.mockResolvedValue(digest);
  api.getBrainDigests.mockResolvedValue([digest, { ...digest, id: 'older', digestText: 'Example older digest' }]);
  api.runBrainDigest.mockResolvedValue(digest);
  render(<DigestTab />);
  expect(await screen.findByText(digest.digestText)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Previous digests/ }));
  api.getBrainLatestDigest.mockRejectedValue(new Error('Unavailable'));
  api.getBrainDigests.mockRejectedValue(new Error('Unavailable'));
  fireEvent.click(screen.getAllByRole('button', { name: 'Generate Now' })[0]);
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
  expect(screen.getByText(digest.digestText)).toBeTruthy();
  expect(screen.getByText('Example older digest')).toBeTruthy();
  api.getBrainDigests.mockResolvedValue([]);
  fireEvent.click(screen.getByRole('button', { name: 'Retry digest history' }));
  await waitFor(() => expect(screen.queryByText('Example older digest')).toBeNull());
  expect(api.runBrainDigest).toHaveBeenCalledTimes(1);
});

it('shows first-generation copy only for successful empty latest reads', async () => {
  render(<DigestTab />);
  expect(await screen.findByText('No daily digest yet.')).toBeTruthy();
  expect(await screen.findByText('No weekly review yet.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.getBrainReviews).toHaveBeenCalledWith(10, { silent: true });
});
