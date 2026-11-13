/** Music Video keeps its finishing and Board projections around the shared routes. */
import { createFilmRoutes } from './filmRoutes.js';
import { musicVideoFilmOwner } from '../services/musicVideo/blender/owner.js';

const router = createFilmRoutes({
  async resolveOwner(id) {
    const owner = musicVideoFilmOwner(id);
    await owner.readRecord();
    return owner;
  },
  async readState(owner) {
    const { getBlenderState } = await import('../services/musicVideo/blender/state.js');
    return getBlenderState(owner.id);
  },
  async startCut(owner, input) {
    const { startBlenderCut } = await import('../services/musicVideo/blender/cuts.js');
    return startBlenderCut(owner.id, input);
  },
});

export default router;
