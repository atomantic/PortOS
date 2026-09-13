/**
 * Regression: a bible read for the PREVIOUS work must not land on the current one.
 *
 * `WorkEditor` is rendered without a `key` (`pages/WritersRoom.jsx`), so it
 * stays mounted when the user switches works and its `[work.id]` bible effect
 * merely re-fires. Before #7242 that effect had no disposal guard, so a slow
 * read for work A resolved after work B was already on screen and overwrote
 * `characters` / `places` / `objects` with A's records.
 *
 * It did not self-correct: `WorkEditor` hands those lists down as controlled
 * props and `BibleSection` returns early rather than refetching when it gets
 * them, so nothing re-read the server until the user manually re-ran an
 * extraction. In the meantime `StoryboardPanel` — "Persisted across runs ·
 * feeds image-gen prompts" — enriched work B's image prompts with work A's
 * characters and places, and those renders were persisted.
 *
 * The assertion is therefore on what `StoryboardPanel` is handed, not on
 * internal state: that prop is the path by which the wrong data reached
 * generated output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

// Records the bible lists the panel is rendered with, so the test asserts on
// what actually reaches image-prompt enrichment.
const storyboardProps = [];
vi.mock('./StoryboardPanel', () => ({
  default: function StoryboardPanelStub(props) {
    storyboardProps.push({ characters: props.characters, places: props.places, objects: props.objects });
    return <div data-testid="storyboard-panel" />;
  },
  STORYBOARD_TAB: {
    CHARACTERS: 'characters', WORLD: 'world', OBJECTS: 'objects',
    SCENES: 'scenes', BOARDS: 'boards', CONFIG: 'config',
  },
  STORYBOARD_TAB_VALUES: ['characters', 'world', 'objects', 'scenes', 'boards', 'config'],
}));

// Socket.IO auto-connects on import (useImageGenQueue / LiveRenderPanel).
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false },
}));

vi.mock('../../services/apiWritersRoom', async (importOriginal) => ({
  ...(await importOriginal()),
  listWritersRoomFolders: vi.fn(async () => []),
  listWritersRoomWorks: vi.fn(async () => []),
  getWritersRoomWork: vi.fn(),
  saveWritersRoomDraft: vi.fn(),
  listWritersRoomCharacters: vi.fn(async () => []),
  listWritersRoomPlaces: vi.fn(async () => []),
  listWritersRoomObjects: vi.fn(async () => []),
}));

vi.mock('../CatalogCastPanel', () => ({ default: () => <div>Catalog cast controls</div> }));
vi.mock('./LibraryPane', () => ({ default: () => <div>Library controls</div> }));

import WorkEditor from './WorkEditor';
import {
  listWritersRoomCharacters,
  listWritersRoomPlaces,
  listWritersRoomObjects,
} from '../../services/apiWritersRoom';

const workNamed = (id, title) => ({
  id,
  title,
  status: 'drafting',
  kind: 'novel',
  activeDraftBody: `${title} opens.`,
  activeDraftVersionId: `${id}-draft-1`,
  drafts: [{ id: `${id}-draft-1`, label: 'v1', wordCount: 2 }],
});

const WORK_A = workNamed('wr-work-a', 'Work A');
const WORK_B = workNamed('wr-work-b', 'Work B');

const A_CHARACTERS = [{ id: 'char-a', name: 'Ada from Work A' }];
const A_PLACES = [{ id: 'place-a', name: 'Harbour in Work A' }];
const A_OBJECTS = [{ id: 'obj-a', name: 'Lantern from Work A' }];

/**
 * A deferred list reader: the first call (work A) hangs until released, every
 * later call (work B) resolves empty straight away. That is the exact ordering
 * the bug needs — A's response arriving after B is on screen.
 */
function deferredReader(lateValue) {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let first = true;
  const read = vi.fn(() => {
    if (!first) return Promise.resolve([]);
    first = false;
    return pending;
  });
  return { read, release: () => release(lateValue) };
}

// A DATA router: WorkEditor's unsaved-changes guard uses `useBlocker`, which
// throws under a plain <MemoryRouter> (#3995).
const routerFor = (work) => createMemoryRouter(
  [{ path: '/writers-room', element: <WorkEditor work={work} onChange={() => {}} /> }],
  { initialEntries: ['/writers-room'] },
);

beforeEach(() => {
  vi.clearAllMocks();
  storyboardProps.length = 0;
});

describe('WorkEditor bible load disposal (#7242)', () => {
  it('drops a bible response for the previous work', async () => {
    const characters = deferredReader(A_CHARACTERS);
    const places = deferredReader(A_PLACES);
    const objects = deferredReader(A_OBJECTS);
    listWritersRoomCharacters.mockImplementation(characters.read);
    listWritersRoomPlaces.mockImplementation(places.read);
    listWritersRoomObjects.mockImplementation(objects.read);

    // Work A mounts; its bible read is in flight and has not resolved.
    const view = render(<RouterProvider router={routerFor(WORK_A)} />);
    await act(async () => {});
    expect(listWritersRoomCharacters).toHaveBeenCalledWith(WORK_A.id);

    // The user switches to work B before that read comes back. WorkEditor has
    // no `key`, so this is a re-render of the SAME instance, not a remount.
    view.rerender(<RouterProvider router={routerFor(WORK_B)} />);
    await act(async () => {});
    expect(listWritersRoomCharacters).toHaveBeenLastCalledWith(WORK_B.id);

    // Now work A's answer lands.
    characters.release();
    places.release();
    objects.release();
    await act(async () => {});

    const latest = storyboardProps.at(-1);
    expect(latest.characters).toEqual([]);
    expect(latest.places).toEqual([]);
    expect(latest.objects).toEqual([]);

    // Nothing work A owned may appear in ANY render after the switch — the
    // storyboard reads these on every frame, so a single frame holding them is
    // enough to enrich a prompt.
    const afterSwitch = storyboardProps.slice(storyboardProps.indexOf(latest) - 1);
    for (const frame of afterSwitch) {
      expect(frame.characters).not.toContainEqual(A_CHARACTERS[0]);
      expect(frame.places).not.toContainEqual(A_PLACES[0]);
      expect(frame.objects).not.toContainEqual(A_OBJECTS[0]);
    }
  });

  it('still applies the response for the work that is current', async () => {
    listWritersRoomCharacters.mockResolvedValue(A_CHARACTERS);
    listWritersRoomPlaces.mockResolvedValue(A_PLACES);
    listWritersRoomObjects.mockResolvedValue(A_OBJECTS);

    render(<RouterProvider router={routerFor(WORK_A)} />);
    await act(async () => {});

    const latest = storyboardProps.at(-1);
    expect(latest.characters).toEqual(A_CHARACTERS);
    expect(latest.places).toEqual(A_PLACES);
    expect(latest.objects).toEqual(A_OBJECTS);
  });
});
