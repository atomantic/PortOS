import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import SceneFrameReferenceLimitNotice from './SceneFrameReferenceLimitNotice.jsx';

// Catches the Codex-limit warning listing the figure blocking layout the server keeps.
it('never lists the greybox plate or its blocking layout as left out on a tight renderer', () => {
  // A full request of picks: both greybox images ride above the pick limit, so the last pick still shows as left out.
  const cast = Array.from({ length: 16 }, (_, n) => ({ id: `mvr-${n}`, imageId: `${n}.png`, role: 'character', label: `Cast ${n + 1}` }));
  const project = { visualSpec: { references: cast }, scenes: [] };
  const scene = { sceneId: 's1', frameReferenceIds: cast.map((r) => r.id) };
  const greybox = {
    reference: { id: 'mvr-greybox-wide', imageId: 'photo.png', role: 'set', label: 'Rink plate', greybox: true },
    blocking: { id: 'mvr-greybox-blocking-wide', imageId: 'layout.png', role: 'blocking', label: 'Rink blocking', greybox: true, blocking: true },
  };
  render(<SceneFrameReferenceLimitNotice project={project} scene={scene} greybox={greybox} sourceImageId="start.png" />);
  const notice = screen.getByRole('status').textContent;
  expect(notice).not.toMatch(/Rink (plate|blocking)/);
  expect(notice).toContain('Cast 3,');
  expect(notice).toMatch(/Cast 16\.$/);
});
