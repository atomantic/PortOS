/**
 * The image-based-lighting and render-profile half of the procedural sculpt
 * contract (`threejsModel.js`), kept in its own DEPENDENCY-FREE module.
 *
 * `spec.lights` alone are punctual: they light a surface but give it nothing to
 * REFLECT, and every reflective PBR channel the material schema accepts —
 * `metalness`, `transmission`, `clearcoat`, `iridescence` — reads off an
 * environment or reads off nothing at all. A conductor in a scene with no
 * environment renders near-black however plausible its values are, so a
 * refinement pass has every incentive to "fix" the look by authoring
 * implausible values back in.
 *
 * The client mirrors all of this in `client/src/lib/threejsEnvironment.js`, and
 * its suite asserts the two agree — which is why nothing here may import
 * anything. `threejsModel.js` pulls in `zod`, which the client CI job does not
 * install, so a client test importing it fails to resolve at all.
 *
 * Both presets are built locally from three's own primitives — PortOS never
 * fetches an HDR to render a local model.
 */

export const THREEJS_ENVIRONMENT_PRESETS = ['none', 'neutral', 'studio'];

/**
 * What a spec with no `environment` key means. A record stored before this block
 * shipped was authored and rendered with no environment at all, so `none` is the
 * honest reading of it — not a retroactive claim that it had one.
 */
export const DEFAULT_THREEJS_ENVIRONMENT = Object.freeze({ preset: 'none', intensity: 1 });

/**
 * The spec's environment, normalized for a caller that must not care whether the
 * key is present. Tolerant of a partially-filled block so a stored record that
 * predates a field reads as the default for it rather than `undefined`.
 */
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

/**
 * The renderer settings a PortOS-authored spec is composed against, stamped onto
 * the exported factory so a consumer wiring their own `WebGLRenderer` reproduces
 * the model instead of a differently tone-mapped approximation of it. These are
 * the react-three-fiber `<Canvas>` defaults the preview runs on; two renders of
 * the same spec are only comparable when both sides agree on them.
 *
 * Data only. The exported factory never constructs a renderer, exactly as it
 * never constructs a scene or a camera.
 */
export const THREEJS_RENDER_PROFILE = Object.freeze({
  outputColorSpace: 'srgb',
  toneMapping: 'ACESFilmic',
  toneMappingExposure: 1,
});
