import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GameBindings from './GameBindings.jsx';

const noop = vi.fn();
const onUpdateMusic = vi.fn();
const onPublishMusic = vi.fn();
const onDismissMusicOverwrite = vi.fn();

// Each call mints fresh binding objects, as every Game page mutation does.
const bindingsTree = (props = {}) => (
  <MemoryRouter>
    <GameBindings
      game={{
        spriteBindings: [{ spriteId: 'deleted-sprite' }],
        musicBindings: [{
          id: 'binding-1',
          trackId: 'theme/one',
          destinationPath: 'game/assets/music/example-theme.ogg',
          publication: null,
        }],
        artworkBindings: [{
          id: 'artwork-1',
          imageFilename: 'title.png',
          label: 'Title Key Art',
          role: 'title-key-art',
          destinationPath: 'game/assets/art/title.png',
          publication: null,
        }],
      }}
      sprites={[{
        id: 'deleted-sprite',
        name: 'Stale Deleted Sprite',
        kind: 'character',
        status: 'ready',
      }]}
      tracks={[{
        id: 'theme/one',
        title: 'Example Theme',
        audioFilename: 'example-theme.ogg',
      }]}
      gallery={[{
        filename: 'title.png',
        path: '/data/images/title.png',
        prompt: 'Cinematic alien valley',
      }]}
      integrity={{
        issues: [
          {
            assetType: 'sprite',
            assetId: 'deleted-sprite',
            code: 'SPRITE_MISSING',
            message: 'Bound sprite no longer exists: deleted-sprite',
          },
          {
            assetType: 'music',
            assetId: 'theme/one',
            code: 'TRACK_AUDIO_INTEGRITY_FAILED',
            message: 'The rendered audio path for "Example Theme" is invalid',
          },
        ],
        assets: {
          sprites: [{
            assetId: 'deleted-sprite',
            status: 'blocked',
            message: 'Bound sprite no longer exists',
          }],
          music: [{
            bindingId: 'binding-1',
            status: 'blocked',
            message: 'Audio path invalid',
          }],
          artwork: [{
            bindingId: 'artwork-1',
            status: 'ready',
            publicationStatus: 'pending',
            message: 'Gallery source verified · publish pending',
          }],
        },
      }}
      busy={false}
      onBindSprite={noop}
      onUnbindSprite={noop}
      onBindMusic={noop}
      onUpdateMusic={onUpdateMusic}
      onPublishMusic={onPublishMusic}
      onUnbindMusic={noop}
      musicOverwriteFor={null}
      onDismissMusicOverwrite={onDismissMusicOverwrite}
      onBindArtwork={noop}
      onUpdateArtwork={noop}
      onPublishArtwork={noop}
      onUnbindArtwork={noop}
      {...props}
    />
  </MemoryRouter>
);
const renderBindings = (props = {}) => render(bindingsTree(props));

const musicSection = () => screen.getByRole('heading', { name: 'Music assets' }).closest('section');

describe('GameBindings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('explains a missing source without trusting a stale catalog entry enough to link it', () => {
    renderBindings();

    expect(screen.getByText(
      'This Sprite Manager record was deleted. Unbind it from this game to clear the blocker.',
    )).toBeInTheDocument();
    const spriteSection = screen.getByRole('heading', { name: 'Sprite assets' }).closest('section');
    expect(within(spriteSection).queryByRole('link')).not.toBeInTheDocument();
  });

  it('falls back to the server message and links when the source record exists', () => {
    renderBindings();

    expect(screen.getByText(
      'The rendered audio path for "Example Theme" is invalid',
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Music' }))
      .toHaveAttribute('href', '/music/tracks/theme%2Fone');
  });

  it('previews role-specific artwork and keeps publishing behind saved details', () => {
    renderBindings();
    expect(screen.getByRole('heading', { name: 'World & interface artwork' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Title Key Art preview' })).toHaveAttribute('src', '/data/images/title.png');
    const artworkSection = screen.getByRole('heading', { name: 'World & interface artwork' }).closest('section');
    expect(within(artworkSection).getByText('Publish pending')).toBeInTheDocument();
    expect(within(artworkSection).getByRole('button', { name: 'Publish to game' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Generate for this role' }))
      .toHaveAttribute('href', expect.stringContaining('/media/image?prompt='));
    expect(screen.getAllByRole('option', { name: 'Game logo' })).toHaveLength(2);
  });

  it('keeps an artwork edit in progress when an unrelated mutation re-renders the game', () => {
    const { rerender } = renderBindings();
    const field = () => document.getElementById('art-label-artwork-1');
    fireEvent.change(field(), { target: { value: 'Draft Name' } });

    rerender(bindingsTree());

    expect(field()).toHaveValue('Draft Name');
  });

  it('edits the music destination and keeps publishing behind the saved path', () => {
    renderBindings();
    const section = musicSection();
    expect(within(section).getByText('Publish pending')).toBeInTheDocument();

    const publish = within(section).getByRole('button', { name: 'Publish to game' });
    expect(publish).toBeEnabled();
    fireEvent.click(publish);
    expect(onPublishMusic).toHaveBeenCalledWith('binding-1');

    const destination = within(section).getByLabelText('Game destination');
    expect(destination).toHaveValue('game/assets/music/example-theme.ogg');
    fireEvent.change(destination, { target: { value: 'game/assets/audio/theme.ogg' } });
    // A dirty destination gates the publish button — publishing must use the
    // path the server has, not the one still sitting unsaved in the input.
    expect(within(section).getByRole('button', { name: 'Publish to game' })).toBeDisabled();

    fireEvent.click(within(section).getByRole('button', { name: 'Save destination' }));
    expect(onUpdateMusic).toHaveBeenCalledWith('binding-1', { destinationPath: 'game/assets/audio/theme.ogg' });
  });

  it('escalates an occupied music destination to explicit overwrite consent', () => {
    renderBindings({ musicOverwriteFor: { bindingId: 'binding-1', destinationPath: 'game/assets/music/example-theme.ogg' } });
    const section = musicSection();

    expect(within(section).getByText(
      'game/assets/music/example-theme.ogg contains bytes PortOS did not publish. Overwrite it?',
    )).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Overwrite' }));
    expect(onPublishMusic).toHaveBeenCalledWith('binding-1', true);

    fireEvent.click(within(section).getByRole('button', { name: 'Cancel' }));
    expect(onDismissMusicOverwrite).toHaveBeenCalled();
  });

  it('drops overwrite consent when the destination it was granted for changed', () => {
    // The consent is for a SPECIFIC path. The server applies
    // `acknowledgeOverwrite` to whatever the binding points at when the request
    // lands, so a consent keyed on the binding alone would let a "yes" for the
    // occupied path silently authorize destroying a different, never-checked
    // file after the destination is edited.
    renderBindings({ musicOverwriteFor: { bindingId: 'binding-1', destinationPath: 'game/assets/music/some-other.ogg' } });
    const section = musicSection();

    expect(within(section).queryByRole('button', { name: 'Overwrite' })).not.toBeInTheDocument();
    expect(within(section).queryByText(/contains bytes PortOS did not publish/)).not.toBeInTheDocument();
  });

  it('keeps publish disabled for a binding with no destination yet', () => {
    renderBindings({
      game: {
        spriteBindings: [],
        musicBindings: [{ id: 'binding-legacy', trackId: 'theme/one', destinationPath: null, publication: null }],
        artworkBindings: [],
      },
      integrity: null,
    });
    const section = musicSection();
    expect(within(section).getByLabelText('Game destination')).toHaveValue('');
    expect(within(section).getByRole('button', { name: 'Publish to game' })).toBeDisabled();
    expect(within(section).queryByText('Publish pending')).not.toBeInTheDocument();
  });
});
