/**
 * Camera-direction vocabulary for FableLoom's AI prompts and editor. The
 * catalog itself lives in the shared `cameraMovements.js` (#10589), which Music
 * Video planning also uses; these names stay so existing imports and persisted
 * scene-node ids keep working unchanged.
 */
import {
  CAMERA_MOVEMENTS,
  CAMERA_MOVEMENT_VALUES,
  cameraMovementCatalogForPrompt,
  normalizeCameraMovement,
} from './cameraMovements.js';

export const FABLELOOM_CAMERA_MOVEMENTS = CAMERA_MOVEMENTS;
export const FABLELOOM_CAMERA_MOVEMENT_VALUES = CAMERA_MOVEMENT_VALUES;
export const normalizeFableLoomCameraMovement = normalizeCameraMovement;
export const fableLoomCameraMovementCatalogForPrompt = () => cameraMovementCatalogForPrompt();
