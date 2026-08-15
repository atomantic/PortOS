import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

// One fake socket shared by the test and the component: `on` records the
// component's handlers so a test can drive `detect:*` / `standardize:*` frames.
const handlers = {};
const emit = vi.fn();
const fakeSocket = {
  on: vi.fn((event, fn) => { handlers[event] = fn; }),
  emit,
  disconnect: vi.fn(),
};

vi.mock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }));

vi.mock('../services/api', () => ({
  getActiveProvider: vi.fn(() => Promise.resolve({ id: 'provider-1', name: 'Example Provider' })),
  getDirectories: vi.fn(() => Promise.resolve({ currentPath: '/srv/example-app', directories: [] })),
  createApp: vi.fn(() => Promise.resolve({ id: 'app-1' })),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), custom: vi.fn() }
}));

import CreateApp from './CreateApp';

/**
 * Render the wizard and drive detection to completion for the given app type.
 * The default is a REAL type streamingDetect emits — the standardize card is
 * gated on a positive list now, so a made-up placeholder would be refused.
 */
const detectApp = async (result = { type: 'single-node-server', name: 'Example App' }) => {
  render(<MemoryRouter><CreateApp /></MemoryRouter>);
  // Let the mount effects (provider + default directory) settle.
  await act(async () => {});
  await act(async () => {
    handlers['detect:complete']({ success: true, result });
  });
};

const standardizeEmits = () => emit.mock.calls.filter(([event]) => event === 'standardize:start');

describe('CreateApp — PM2 standardization is opt-in', () => {
  beforeEach(() => {
    emit.mockClear();
    for (const key of Object.keys(handlers)) delete handlers[key];
  });

  it('does not write an ecosystem config on its own when detection completes', async () => {
    await detectApp();

    // The wizard used to fire this automatically, dropping an
    // ecosystem.config.cjs into any imported repo — PM2-managed or not.
    expect(standardizeEmits()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Standardize PM2 config' })).toBeEnabled();
  });

  it('standardizes only once the user asks for it', async () => {
    const user = userEvent.setup();
    await detectApp();

    await user.click(screen.getByRole('button', { name: 'Standardize PM2 config' }));

    expect(standardizeEmits()).toEqual([
      ['standardize:start', { repoPath: '/srv/example-app', providerId: 'provider-1' }]
    ]);
  });

  it('offers no standardization for app types PortOS never runs under PM2', async () => {
    await detectApp({ type: 'ios-native', name: 'Example iOS App' });

    expect(screen.queryByRole('button', { name: 'Standardize PM2 config' })).toBeNull();
    expect(standardizeEmits()).toHaveLength(0);
  });

  it('offers no standardization for non-Node runtimes', async () => {
    // The standardizer's prompt opens "You are analyzing a Node.js application";
    // on a Python/Go/Docker/static repo it doesn't fail, it confidently writes a
    // Node ecosystem config. The card must not render at all.
    for (const type of ['python', 'go', 'docker', 'static']) {
      // Each iteration renders its own wizard — tear the previous one down so a
      // stale card from an earlier type can't satisfy (or defeat) the query.
      cleanup();
      emit.mockClear();
      for (const key of Object.keys(handlers)) delete handlers[key];

      await detectApp({ type, name: 'Example App' });

      expect(screen.queryByRole('button', { name: 'Standardize PM2 config' })).toBeNull();
      expect(standardizeEmits()).toHaveLength(0);
    }
  });

  it('explains why a non-Node repo gets no standardize card', async () => {
    await detectApp({ type: 'python', name: 'Example App' });

    expect(screen.getByText(/not a Node\.js project/)).toBeInTheDocument();
  });

  it('still offers standardization for an app whose type detection could not name', async () => {
    // `unknown` is the persisted type of every app imported before non-Node
    // classification existed — most of them are Node apps.
    await detectApp({ type: 'unknown', name: 'Example App' });

    expect(screen.getByRole('button', { name: 'Standardize PM2 config' })).toBeEnabled();
  });

  it('disables the action when no LLM provider is configured', async () => {
    const api = await import('../services/api');
    api.getActiveProvider.mockResolvedValueOnce(null);

    await detectApp();

    expect(screen.getByRole('button', { name: 'Standardize PM2 config' })).toBeDisabled();
    expect(screen.getByText(/Needs an LLM provider/)).toBeInTheDocument();
  });
});
