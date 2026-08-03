import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { MemoryRouter } from 'react-router';

// Regression guard for #3387: typing in the WorkEditor body must NOT re-render
// the <StoryboardPanel> sidebar. The panel is a heavy tree (bibles, boards,
// scene cards, image config) with zero dependency on the prose text, so a
// per-keystroke re-render of it was the editor's dominant typing cost.
//
// Two halves, because either alone is a false green:
//   1. The panel is wrapped in React.memo (asserted against the REAL module).
//   2. Every prop WorkEditor hands it stays referentially stable across
//      keystrokes — otherwise memo compares unequal and re-renders anyway.
//      A memoized stub proves this: it only skips a render when the props it
//      receives are identical.

const probe = vi.hoisted(() => ({ renders: 0, props: null }));

vi.mock('./StoryboardPanel', async () => {
  const { memo } = await import('react');
  const StoryboardPanelStub = memo(function StoryboardPanelStub(props) {
    probe.renders += 1;
    probe.props = props;
    return <div data-testid="storyboard-panel" />;
  });
  return {
    default: StoryboardPanelStub,
    STORYBOARD_TAB: {
      CHARACTERS: 'characters',
      WORLD: 'world',
      OBJECTS: 'objects',
      SCENES: 'scenes',
      BOARDS: 'boards',
      CONFIG: 'config',
    },
    STORYBOARD_TAB_VALUES: ['characters', 'world', 'objects', 'scenes', 'boards', 'config'],
  };
});

// Socket.IO auto-connects on import (useImageGenQueue / LiveRenderPanel).
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false },
}));

// Keep every other export real so a signature drift still breaks the suite;
// only the three mount-effect fetches are stubbed.
vi.mock('../../services/apiWritersRoom', async (importOriginal) => ({
  ...(await importOriginal()),
  listWritersRoomCharacters: vi.fn(async () => []),
  listWritersRoomPlaces: vi.fn(async () => []),
  listWritersRoomObjects: vi.fn(async () => []),
}));

import WorkEditor from './WorkEditor';

const work = {
  id: 'wr-work-1',
  title: 'Example Work',
  status: 'drafting',
  kind: 'novel',
  activeDraftBody: 'The hero wakes.',
  activeDraftVersionId: 'wr-draft-1',
  drafts: [{ id: 'wr-draft-1', label: 'v1', wordCount: 3 }],
};

async function renderEditor() {
  const view = render(
    <MemoryRouter>
      <WorkEditor work={work} onChange={() => {}} />
    </MemoryRouter>
  );
  // Settle the mount-effect bible fetches before asserting render counts.
  await act(async () => {});
  return view;
}

beforeEach(() => {
  probe.renders = 0;
  probe.props = null;
});

describe('WorkEditor typing does not re-render StoryboardPanel (#3387)', () => {
  it('leaves the panel untouched across a burst of keystrokes', async () => {
    const { container } = await renderEditor();
    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();
    expect(probe.renders).toBeGreaterThan(0);

    // The FIRST keystroke legitimately re-renders the panel once: `dirty`
    // flips false → true and the panel renders a save-first warning from it.
    fireEvent.change(textarea, { target: { value: 'The hero wakes. A' } });
    expect(probe.props.dirty).toBe(true);

    const rendersAfterDirty = probe.renders;
    const propsAfterDirty = probe.props;

    // Every subsequent keystroke must be free.
    for (const next of ['Ab', 'Abc', 'Abcd', 'Abcde', 'Abcdef']) {
      fireEvent.change(textarea, { target: { value: `The hero wakes. ${next}` } });
    }

    expect(textarea.value).toBe('The hero wakes. Abcdef');
    expect(probe.renders).toBe(rendersAfterDirty);
    // Same props object identity — nothing WorkEditor passes down churned.
    expect(probe.props).toBe(propsAfterDirty);
  });

  it('keeps every StoryboardPanel handler referentially stable while typing', async () => {
    const { container } = await renderEditor();
    const textarea = container.querySelector('textarea');
    // Get past the dirty flip first so the comparison isolates typing churn.
    fireEvent.change(textarea, { target: { value: 'x' } });
    const before = probe.props;

    fireEvent.change(textarea, { target: { value: 'xy' } });

    // These are the props that used to be rebuilt per render — inline arrows
    // (onRunAdapt / onRunCharacters / onRunPlaces / onRunObjects), a plain
    // async fn (onStyleChange), and a useCallback with `body` in its deps
    // (onJumpToScene). Each one alone defeats the memo boundary.
    for (const key of [
      'onRunAdapt', 'onRunCharacters', 'onRunPlaces', 'onRunObjects',
      'onRunFullPipeline', 'onStyleChange', 'onJumpToScene', 'onDebug',
      'onScenesChange', 'onLiveRenderContextChange', 'registerSceneImageMerge',
      'onCharactersChange', 'onPlacesChange', 'onObjectsChange',
      'onSceneHover', 'onSceneRenderStart', 'onTabChange',
    ]) {
      expect(typeof before[key], `${key} should be a function`).toBe('function');
      expect(probe.props[key], `${key} changed identity on a keystroke`).toBe(before[key]);
    }
  });

  it('ships StoryboardPanel behind a real memo boundary', async () => {
    const actual = await vi.importActual('./StoryboardPanel');
    expect(actual.default.$$typeof).toBe(Symbol.for('react.memo'));
  });
});
