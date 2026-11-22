import { expect } from 'vitest';
/**
 * Test helper: SceneCard loads its settings groups as a lazy chunk, which suspends the first time any card
 * renders in a test file. Awaiting this once in `beforeAll` resolves it so the synchronous
 * assertions in the file see the settings controls from the first render.
 */
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import SceneCard from './SceneCard.jsx';

export async function warmSceneCard() {
  render(<SceneCard scene={{ sceneId: 'warm', startSec: 0, endSec: 4, takes: [], videoHistoryId: 'warm-clip' }} index={0} expanded onEditLocal={() => {}} onSave={() => {}} />);
  await waitFor(() => expect(screen.queryByText('Loading shot settings…')).toBeNull(), { timeout: 20000 });
  cleanup();
}
