/**
 * The image-based-lighting and render-profile half of the procedural sculpt contract (`threejsModel.js`), kept DEPENDENCY-FREE.
 *
 * `spec.lights` are punctual (they light a surface but give it nothing to REFLECT) and every reflective PBR channel (`metalness`, `transmission`, `clearcoat`, `iridescence`) reads off an environment or nothing: a conductor with no environment renders near-black however plausible its values, so a refinement pass is tempted to author implausible values back in. The sculpt preview and exported factory share this contract. Both presets are built locally from three's primitives; PortOS never fetches an HDR to render a local model.
 */

export const THREEJS_ENVIRONMENT_PRESETS = ['none', 'neutral', 'studio'];

/** What a spec with no `environment` key means: a record stored before this block was authored and rendered with no environment, so `none` is the honest reading, not a retroactive claim it had one. */
export const DEFAULT_THREEJS_ENVIRONMENT = Object.freeze({ preset: 'none', intensity: 1 });

/** The spec's environment normalized for a caller that mustn't care whether the key is present; tolerant of a partially-filled block so a record predating a field reads as that field's default, not `undefined`. */
export const resolveThreejsEnvironment = (spec) => {
  const environment = spec?.environment;
  if (!environment || typeof environment !== 'object') return { ...DEFAULT_THREEJS_ENVIRONMENT };
  return {
    preset: THREEJS_ENVIRONMENT_PRESETS.includes(environment.preset)
      ? environment.preset
      : DEFAULT_THREEJS_ENVIRONMENT.preset,
    intensity: typeof environment.intensity === 'number' && Number.isFinite(environment.intensity)
      ? environment.intensity
      : DEFAULT_THREEJS_ENVIRONMENT.intensity,
  };
};

/** The renderer settings a spec is composed against, stamped onto the exported factory so a consumer wiring their own `WebGLRenderer` reproduces the model (the react-three-fiber `<Canvas>` defaults the preview runs on; renders are comparable only when both sides agree). Data only: the factory never constructs a renderer, scene or camera. */
export const THREEJS_RENDER_PROFILE = Object.freeze({
  outputColorSpace: 'srgb',
  toneMapping: 'ACESFilmic',
  toneMappingExposure: 1,
});
