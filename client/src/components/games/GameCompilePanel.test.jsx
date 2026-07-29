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
