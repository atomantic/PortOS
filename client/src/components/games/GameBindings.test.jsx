import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import GameBindings from './GameBindings.jsx';

const noop = vi.fn();

describe('GameBindings', () => {
  it('explains bundle blockers and links to the affected source record', () => {
    render(
      <MemoryRouter>
        <GameBindings
          game={{
            spriteBindings: [
              { spriteId: 'ready-sprite' },
              { spriteId: 'draft-hero' },
            ],
            musicBindings: [],
          }}
          sprites={[
            { id: 'ready-sprite', name: 'Ready Sprite', kind: 'character', status: 'ready' },
            { id: 'draft-hero', name: 'Draft Hero', kind: 'character', status: 'draft' },
          ]}
          tracks={[]}
          integrity={{
            issues: [{
              assetType: 'sprite',
              assetId: 'draft-hero',
              name: 'Draft Hero',
              code: 'SPRITE_ATLAS_REQUIRED',
              message: 'Compile or import a runtime atlas for "Draft Hero" before building the game bundle',
            }],
            assets: {
              sprites: [
                { assetId: 'ready-sprite', status: 'ready', message: 'Runtime atlas v2' },
                { assetId: 'draft-hero', status: 'blocked', message: 'Runtime atlas required' },
              ],
              music: [],
            },
          }}
          busy={false}
          onBindSprite={noop}
          onUnbindSprite={noop}
          onBindMusic={noop}
          onUnbindMusic={noop}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('1 asset is blocking the bundle')).toBeInTheDocument();
    expect(screen.getAllByText(/Compile or import a runtime atlas/)).toHaveLength(2);
    const repairLinks = screen.getAllByRole('link', { name: 'Open in Sprite Manager' });
    expect(repairLinks).toHaveLength(2);
    repairLinks.forEach((link) => expect(link).toHaveAttribute('href', '/sprites/draft-hero'));

    const spriteSection = screen.getByRole('heading', { name: 'Sprite assets' }).closest('section');
    const spriteList = within(spriteSection).getByRole('list');
    const rows = within(spriteList).getAllByRole('listitem');
    expect(within(rows[0]).getByText('Draft Hero')).toBeInTheDocument();
  });
});
