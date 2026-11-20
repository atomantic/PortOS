import { recoverInterruptedModels as recoverImageTo3d } from './imageTo3d/db.js';
import { recoverInterruptedModels as recoverThreejsModels } from './threejsModels/db.js';

export async function recoverInterruptedImageTo3dModels() {
  const result = await recoverImageTo3d();
  if (result.recovered > 0) {
    console.log(`🧊 Recovered ${result.recovered} interrupted image-to-3D render(s)`);
  }
  return result;
}

export async function recoverInterruptedThreejsModels() {
  const result = await recoverThreejsModels();
  if (result.recovered > 0) {
    console.log(`🧊 Recovered ${result.recovered} interrupted Three.js model generation(s)`);
  }
  return result;
}
