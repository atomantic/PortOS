import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GameCompilePanel from './GameCompilePanel.jsx';

const game = {
  compiledManifest: null,
};

describe('GameCompilePanel', () => {
  it('surfaces integrity blockers and gates build and launch', () => {
    render(
      <GameCompilePanel
        game={game}
        integrity={{
          readyToCompile: false,
          canLaunch: false,
          bundle: { status: 'missing' },
          issues: [{
            assetType: 'sprite',
            assetId: 'draft-hero',
            name: 'Draft Hero',
            message: 'Runtime atlas required',
          }],
          counts: {
            spriteReady: 2,
            spriteTotal: 3,
            verifiedFiles: 5,
          },
        }}
        onCompile={() => {}}
        onLaunch={() => {}}
      />,
    );

    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.getByText('Draft Hero')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build & verify' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled();
  });

  it('surfaces a compile failure as an alert', () => {
    // The inline alert is the only surface for a failed compile — the page
    // deliberately does not also toast it.
    render(
      <GameCompilePanel
        game={game}
        integrity={{
          readyToCompile: true,
          canLaunch: false,
          bundle: { status: 'missing' },
          issues: [],
          counts: { spriteReady: 1, spriteTotal: 1, verifiedFiles: 2 },
        }}
        compileError="The runtime atlas for &quot;Hero&quot; is missing or does not match its recorded hash"
        onCompile={() => {}}
        onLaunch={() => {}}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('does not match its recorded hash');
  });

  it('reports a failed preflight as unverified, not as "not built"', () => {
    // A failed integrity fetch must not read the same as "no bundle exists" —
    // that would leave Build enabled on an unverified tree and label an existing
    // bundle "Not built" right above the block describing it.
    const onRetryIntegrity = vi.fn();
    render(
      <GameCompilePanel
        game={{ compiledManifest: { version: 2, spriteCount: 1, musicCount: 0, builtAt: '2026-07-28T12:00:00.000Z', manifestPath: 'manifests/game-assets-v2.json' } }}
        integrity={null}
        loadingIntegrity={false}
        onCompile={() => {}}
        onLaunch={() => {}}
        onRetryIntegrity={onRetryIntegrity}
      />,
    );

    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByText('Not built')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rebuild & verify' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start game' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryIntegrity).toHaveBeenCalledOnce();
  });

  it('does not offer to build while the preflight is still loading', () => {
    render(
      <GameCompilePanel
        game={game}
        integrity={null}
        loadingIntegrity
        onCompile={() => {}}
        onLaunch={() => {}}
      />,
    );

    expect(screen.getByText('Checking…')).toBeInTheDocument();
    // Loading is not the same as failed — no error banner, no retry.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build & verify' })).toBeDisabled();
  });

  it('allows a verified bundle to launch', () => {
    const onLaunch = vi.fn();
    render(
      <GameCompilePanel
        game={{
          compiledManifest: {
            version: 2,
            spriteCount: 1,
            musicCount: 1,
            verifiedFileCount: 3,
            builtAt: '2026-07-28T12:00:00.000Z',
            manifestPath: 'manifests/game-assets-v2.json',
          },
        }}
        integrity={{
          readyToCompile: true,
          canLaunch: true,
          bundle: { status: 'current' },
          issues: [],
          counts: {
            spriteReady: 1,
            spriteTotal: 1,
            verifiedFiles: 3,
          },
        }}
        onCompile={() => {}}
        onLaunch={onLaunch}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start game' }));
    expect(onLaunch).toHaveBeenCalledOnce();
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });
});
