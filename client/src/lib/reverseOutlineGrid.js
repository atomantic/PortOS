/**
 * Reverse Outline grid layout (#1286) — pure view helper.
 *
 * Turns the flat `scenes[]` + `plotlines[]` from the reverse-outline artifact
 * into a plotline-by-sequence grid: rows = plotlines, columns = scenes in
 * reading order. Each cell tells the renderer whether the scene is on this
 * plotline as its `primary` thread, only `secondary`, or absent (`null`). This
 * is what surfaces thread cadence, gaps, and tangles at a glance.
 *
 * Pure + side-effect-free so it unit-tests without React.
 */

/**
 * @param {Array} scenes - ordered scene objects ({ id, plotlineId, secondaryPlotlineId, ... })
 * @param {Array} plotlines - ordered plotline objects ({ id, label, color, ... })
 * @returns {{ columns: Array, rows: Array<{ plotline, cells: Array<{ scene, role }|null>, count: number }> }}
 */
export function buildPlotlineGrid(scenes, plotlines) {
  const columns = Array.isArray(scenes) ? scenes : [];
  const rows = (Array.isArray(plotlines) ? plotlines : []).map((plotline) => {
    let count = 0;
    const cells = columns.map((scene) => {
      const role = scene?.plotlineId === plotline.id
        ? 'primary'
        : scene?.secondaryPlotlineId === plotline.id
          ? 'secondary'
          : null;
      if (role === 'primary') count += 1;
      return role ? { scene, role } : null;
    });
    return { plotline, cells, count };
  });
  return { columns, rows };
}

/** Count of the three prose modes materially present in a scene (0–3). */
export function sceneComponentCount(scene) {
  const c = scene?.components || {};
  return (c.narrative ? 1 : 0) + (c.action ? 1 : 0) + (c.dialogue ? 1 : 0);
}
