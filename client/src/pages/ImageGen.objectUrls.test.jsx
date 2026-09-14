import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

// Codex is i2i-capable and declares no input-image cap, so the form offers the
// init image plus all four reference slots without needing a FLUX.2 install.
const MODEL = { id: 'dev', name: 'FLUX.1 Dev', runner: 'mflux', steps: 20, guidance: 3.5 };

const objectUrl = { created: [], createdFiles: [], revoked: [], fileSeq: 0 };

const nextFile = () => new File(['x'], `photo-${++objectUrl.fileSeq}.jpg`, { type: 'image/jpeg' });

// Interactive stubs for the three pickers that own the object-URL lifecycle.
// Each exposes the page's own handler as a button plus the previewUrl it is
// currently rendering, so a test can assert the page never leaves a REVOKED
// url wired to a live <img src>.
const InitPicker = ({ initImage, onPick, onClear, onBrowse }) => (
  <div>
    <button type="button" onClick={() => onPick({ target: { files: [nextFile()] } })}>pick-init</button>
    <button type="button" onClick={onClear}>clear-init</button>
    <button type="button" onClick={onBrowse}>browse-init</button>
    <span data-testid="init-url">{initImage.previewUrl || ''}</span>
  </div>
);
const RefPicker = ({ referenceImages, onPick, onClear }) => (
  <div>
    {referenceImages.map((slot, i) => (
      <div key={i}>
        <button type="button" onClick={() => onPick(i, { target: { files: [nextFile()] } })}>{`pick-ref-${i}`}</button>
        <button type="button" onClick={() => onClear(i)}>{`clear-ref-${i}`}</button>
        <span data-testid={`ref-url-${i}`}>{slot.previewUrl || ''}</span>
      </div>
    ))}
  </div>
);
const GalleryPicker = ({ open, onSelect }) => (open
  ? <button type="button" onClick={() => onSelect({ filename: 'gallery-pick.png' })}>gallery-select</button>
  : null);

await loadImageGenPage();

const mount = ({ strict = false } = {}) => renderImageGenPage('/media/image', { strict });

const click = async (name) => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
};

// Blob URLs created but not yet revoked — what a real tab would still be
// pinning the underlying File for.
const liveUrls = () => objectUrl.created.filter((u) => !objectUrl.revoked.includes(u));

// jsdom ships none of these, so restoring means DELETING the property again —
// assigning `undefined` back would leave an own property that later files see
// as "present but broken".
const stub = (host, key, value) => {
  const had = Object.hasOwn(host, key);
  const prev = host[key];
  host[key] = value;
  return () => { if (had) host[key] = prev; else delete host[key]; };
};

describe('ImageGen object-URL lifecycle', () => {
  let restore = [];

  beforeEach(() => {
    resetImageGenMockState();
    state.models = [MODEL];
    state.settings = { imageGen: { mode: 'codex' } };
    state.getImageGenStatus.mockResolvedValue({ connected: true, mode: 'codex' });
    state.flux2Status = { installed: false, ready: false };
    state.initImagePickerFactory = InitPicker;
    state.referenceImagePickerFactory = RefPicker;
    state.galleryImagePickerFactory = GalleryPicker;
    objectUrl.created = [];
    objectUrl.createdFiles = [];
    objectUrl.revoked = [];
    objectUrl.fileSeq = 0;
    restore = [
      stub(URL, 'createObjectURL', vi.fn((file) => {
        const url = `blob:portos/${objectUrl.created.length + 1}`;
        objectUrl.created.push(url);
        objectUrl.createdFiles.push(file?.name ?? '');
        return url;
      })),
      stub(URL, 'revokeObjectURL', vi.fn((url) => { objectUrl.revoked.push(url); })),
      // The page EXIF-normalizes uploads through createImageBitmap; jsdom has
      // no decoder, and the page's own `.catch` falls back to the original File.
      stub(window, 'createImageBitmap', vi.fn(() => Promise.reject(new Error('no decoder')))),
    ];
  });

  afterEach(() => {
    // Unmount anything a test left mounted BEFORE the stubs go away: the
    // global cleanup in src/test/setup.js runs after this hook, and the
    // unmount sweep it triggers would reach a deleted revokeObjectURL.
    cleanup();
    restore.forEach((undo) => undo());
    restore = [];
  });

  // The leak this file exists for: navigating away from /image-gen with images
  // still selected must not pin their Files for the rest of the tab's life.
  it('revokes every blob URL it created when the page unmounts', async () => {
    const { unmount } = await mount();
    await click('pick-init');
    // Every slot, not just the first: a sweep that walked a truncated list
    // would still pass on a two-slot sample.
    for (let i = 0; i < 4; i += 1) await click(`pick-ref-${i}`);

    await waitFor(() => expect(objectUrl.created).toHaveLength(5));
    expect(objectUrl.revoked).toEqual([]);

    await act(async () => { unmount(); });

    expect(liveUrls()).toEqual([]);
  });

  // Each pick handler awaits (EXIF normalization) BEFORE it mints its url, so
  // an unmount mid-await would otherwise resume past the sweep and create one
  // nothing owns — a leak the steady-state test above cannot see.
  it('creates no object URL for a pick that resolves after the page unmounted', async () => {
    // One deferred normalization per pick — release ALL of them, or a handler
    // left suspended would fake a pass.
    const pending = [];
    window.createImageBitmap = vi.fn(() => new Promise((_, reject) => {
      pending.push(() => reject(new Error('no decoder')));
    }));

    const { unmount } = await mount();
    await click('pick-init');
    await click('pick-ref-0');
    expect(pending).toHaveLength(2);
    expect(objectUrl.created).toEqual([]);

    await act(async () => { unmount(); });
    // Let the suspended handlers resume all the way through their `.catch`
    // fallback to the point where they would mint a url.
    await act(async () => {
      pending.forEach((fail) => fail());
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(objectUrl.created).toEqual([]);
  });

  // Replacing keeps reclaiming immediately, and the url left rendered must be
  // the LIVE one — a revoked url wired to an <img src> renders a broken image.
  it('revokes the replaced url on both the init image and a reference slot, never the live one', async () => {
    await mount();
    await click('pick-init');
    await click('pick-ref-0');
    await waitFor(() => expect(objectUrl.created).toHaveLength(2));
    const [firstInit, firstRef] = objectUrl.created;

    await click('pick-init');
    await click('pick-ref-0');
    await waitFor(() => expect(objectUrl.created).toHaveLength(4));
    const [, , secondInit, secondRef] = objectUrl.created;

    expect(objectUrl.revoked).toContain(firstInit);
    expect(objectUrl.revoked).toContain(firstRef);
    expect(objectUrl.revoked).not.toContain(secondInit);
    expect(objectUrl.revoked).not.toContain(secondRef);
    expect(screen.getByTestId('init-url')).toHaveTextContent(secondInit);
    expect(screen.getByTestId('ref-url-0')).toHaveTextContent(secondRef);
  });

  // The app renders under StrictMode (client/src/main.jsx), which invokes a
  // functional state updater TWICE in dev. A url minted inside the updater is
  // created on both passes but only one is kept, so the other is unreachable
  // and can never be revoked — a leak on every single reference pick.
  it('mints exactly one url per pick under StrictMode', async () => {
    const { unmount } = await mount({ strict: true });
    await click('pick-init');
    await click('pick-ref-0');

    await waitFor(() => expect(screen.getByTestId('ref-url-0')).not.toHaveTextContent(''));
    expect(objectUrl.created).toHaveLength(2);

    await act(async () => { unmount(); });
    expect(liveUrls()).toEqual([]);
  });

  // Clearing reclaims immediately, and the later unmount must not re-revoke a
  // url the clear already released.
  it('revokes on clear and does not revoke again at unmount', async () => {
    const { unmount } = await mount();
    await click('pick-init');
    await click('pick-ref-0');
    await waitFor(() => expect(objectUrl.created).toHaveLength(2));

    await click('clear-init');
    await click('clear-ref-0');
    expect(liveUrls()).toEqual([]);

    await act(async () => { unmount(); });
    expect(objectUrl.revoked).toHaveLength(2);
  });

  // `revokeIfBlob` exists for exactly this: gallery previews are plain
  // `/data/...` paths the whole app shares. Revoking one is a no-op on the
  // blob registry but would be a bug the moment it were passed to revoke.
  it('never revokes a gallery /data/ preview url', async () => {
    const { unmount } = await mount();
    await click('pick-init');
    await waitFor(() => expect(objectUrl.created).toHaveLength(1));
    const [blobUrl] = objectUrl.created;

    // Swap the upload for a gallery pick: the blob is reclaimed, the
    // `/data/...` path that replaces it is not a revoke candidate.
    await click('browse-init');
    await click('gallery-select');

    await waitFor(() => expect(screen.getByTestId('init-url')).toHaveTextContent('/data/images/gallery-pick.png'));
    expect(objectUrl.revoked).toEqual([blobUrl]);

    await act(async () => { unmount(); });

    expect(objectUrl.revoked).toEqual([blobUrl]);
  });

  // Two picks that overlap in the EXIF-normalization await must not each mint
  // a url: only the last setState survives, so the loser's url would be
  // unreachable from state, the clear path, and the unmount sweep.
  it('creates exactly one url when two init picks overlap, keeping the last pick', async () => {
    // Defer only the normalization calls (two-arg form); the dims probe
    // (one-arg form) keeps its immediate fallback so it can't hold a handler.
    const pending = [];
    window.createImageBitmap = vi.fn((...args) => (args.length === 2
      ? new Promise((_, reject) => { pending.push(() => reject(new Error('no decoder'))); })
      : Promise.reject(new Error('no decoder'))));

    await mount();
    await click('pick-init');
    await click('pick-init');
    expect(pending).toHaveLength(2);
    expect(objectUrl.created).toEqual([]);

    await act(async () => {
      pending.forEach((fail) => fail());
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(objectUrl.created).toHaveLength(1));
    expect(objectUrl.createdFiles).toEqual(['photo-2.jpg']);
    expect(liveUrls()).toHaveLength(1);
    expect(screen.getByTestId('init-url')).toHaveTextContent(objectUrl.created[0]);
  });

  it('creates exactly one url when two picks overlap on one reference slot, keeping the last pick', async () => {
    const pending = [];
    window.createImageBitmap = vi.fn(() => new Promise((_, reject) => {
      pending.push(() => reject(new Error('no decoder')));
    }));

    await mount();
    await click('pick-ref-0');
    await click('pick-ref-0');
    expect(pending).toHaveLength(2);
    expect(objectUrl.created).toEqual([]);

    await act(async () => {
      pending.forEach((fail) => fail());
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(objectUrl.created).toHaveLength(1));
    expect(objectUrl.createdFiles).toEqual(['photo-2.jpg']);
    expect(liveUrls()).toHaveLength(1);
    expect(screen.getByTestId('ref-url-0')).toHaveTextContent(objectUrl.created[0]);
  });
});
