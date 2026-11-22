import { describe, expect, it, vi, beforeAll } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SceneCard from './SceneCard.jsx';
import { normalizeSceneCardProps } from './sceneCardProps.js';
import { warmSceneCard } from './sceneCardTestWarmup.jsx';
beforeAll(warmSceneCard, 30000);

vi.mock('../../services/apiRunwayCatalog.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadRunwayCatalog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../hooks/useVideoFileSrc.js', () => ({ useVideoFileSrc: () => ({ src: null }) }));

// Regression: grouped domain props passed by ShotCardHost must wire every section cleanly
// without falling back to flat legacy prop names.
describe('SceneCard grouped domain props', () => {
  it('renders header controls, timing, and dispatches grouped actions', async () => {
    const onClose = vi.fn();
    const onSetDone = vi.fn();
    const onGenerateVideo = vi.fn();
    const onEditLocal = vi.fn();
    const onSave = vi.fn();
    const onPrev = vi.fn();
    const scene = {
      sceneId: 'grouped-1',
      order: 1,
      label: 'Chorus wide',
      startSec: 12,
      endSec: 16,
      prompt: 'Band plays in golden light',
      referenceImageId: 'still-1.png',
      takes: [],
    };
    const project = { id: 'mv-grouped', scenes: [scene] };

    render(
      <SceneCard
        scene={scene}
        project={project}
        locked={false}
        position={{ index: 1, isLast: true, shotName: 'Shot 2 · Chorus wide', stepShot: { prev: onPrev, next: null } }}
        composition={{ projectId: 'mv-grouped', aspect: '16:9', layered: false, songDurationSec: 180 }}
        media={{ lipSyncBackend: 'grok', falVideoSettings: { backend: 'grok' }, videoModels: [], defaultVideoModel: '' }}
        takes={{ busy: false, pending: null, checking: null }}
        actions={{ onClose, onSetDone, onGenerateVideo, onEditLocal, onSave }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Shot 2 · Chorus wide' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous shot' }));
    expect(onPrev).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    });
    expect(onSetDone).toHaveBeenCalledWith('grouped-1', true);

    fireEvent.click(screen.getByRole('button', { name: 'Close shot' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(onGenerateVideo).toHaveBeenCalledTimes(1);
    expect(onGenerateVideo.mock.calls[0][0]).toBe(scene);
  });

  it('prefers grouped domain values over legacy flat fallbacks', () => {
    const normalized = normalizeSceneCardProps({
      position: { index: 3, isLast: false, shotName: 'Grouped Name' },
      composition: { aspect: '9:16', layered: true },
      takes: { busy: true },
      index: 0,
      isLast: true,
      shotName: 'Legacy Name',
      aspect: '16:9',
      layered: false,
      takeBusy: false,
    });

    expect(normalized.position.index).toBe(3);
    expect(normalized.position.isLast).toBe(false);
    expect(normalized.position.shotName).toBe('Grouped Name');
    expect(normalized.composition.aspect).toBe('9:16');
    expect(normalized.composition.layered).toBe(true);
    expect(normalized.takes.busy).toBe(true);
  });
});
