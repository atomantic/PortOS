// `universeStylePreset(universe, series)` is a pure leaf re-exported from
// server/lib/universeVisualStyle.js so the browser (this file's former home)
// and the server's FableLoom visual-canon compiler compose the same series
// override — prepend / append / override — against the universe's embrace
// tokens. A drift between the two used to leave a series override applied in
// the preview but repeated/ignored in the actual render (#8442).
export { universeStylePreset } from '../../../server/lib/universeVisualStyle.js';
