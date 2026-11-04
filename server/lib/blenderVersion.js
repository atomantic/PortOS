/**
 * Supported Blender releases for the Code Animation renderer. Versions are compared as
 * `major.minor` series: a patch update (5.2.3 → 5.2.4) keeps existing projects valid,
 * while the execution check still records the exact patch it rendered with.
 */

/** Newest stable release PortOS has been checked against; new projects default to it. */
export const LATEST_BLENDER_VERSION = '5.2.3';
/** Oldest series the driver supports (the October 2026 acceptance baseline). */
export const MIN_BLENDER_SERIES = [4, 2];

const parse = (version) => {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version ?? '').trim());
  return match ? match.slice(1, 3).map(Number) : null;
};

/** `5.2.3` → `5.2`, or null for anything that is not a dotted release number. */
export function blenderSeries(version) {
  const parsed = parse(version);
  return parsed ? parsed.join('.') : null;
}

export function isSupportedBlenderVersion(version) {
  const parsed = parse(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major > MIN_BLENDER_SERIES[0] || (major === MIN_BLENDER_SERIES[0] && minor >= MIN_BLENDER_SERIES[1]);
}

/** Python that maps PortOS's engine id onto whichever id the running Blender uses. */
// PortOS keeps 4.x's 'BLENDER_EEVEE_NEXT' as its EEVEE id so saved projects stay valid;
// Blender 5.0 renamed the engine back to 'BLENDER_EEVEE'.
export const BLENDER_COMPAT_PY = String.raw`
def portos_set_engine(scene, engine):
    try:
        scene.render.engine = engine
    except TypeError:
        if engine != 'BLENDER_EEVEE_NEXT':
            raise
        scene.render.engine = 'BLENDER_EEVEE'
def portos_version():
    return '%d.%d.%d' % tuple(bpy.app.version)
def action_fcurves(obj):
    # Blender 5 removed Action.fcurves; layered actions keep curves per slot in a channelbag.
    data = obj.animation_data
    action = data.action if data else None
    if action is None:
        return []
    if hasattr(action, 'fcurves'):
        return list(action.fcurves)
    from bpy_extras import anim_utils
    bag = anim_utils.action_get_channelbag_for_slot(action, data.action_slot)
    return list(bag.fcurves) if bag else []
`;
