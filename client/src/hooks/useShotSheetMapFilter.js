import { useSearchParams } from 'react-router';
import { SHOT_SHEET_MAP_BARS } from '../../../server/lib/musicVideoShotSheet.js';

/**
 * The stretch tapped on the shot sheet's map, kept in the URL so the sheet and
 * the scene board narrow together and a reload keeps the view. `value` is '' for
 * shots with nothing set in that column.
 */
export default function useShotSheetMapFilter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const bar = searchParams.get('mapBar');
  const known = SHOT_SHEET_MAP_BARS.some(([id]) => id === bar);
  const mapFilter = known ? { bar, value: searchParams.get('mapValue') ?? '' } : null;
  const setMapFilter = (next) => setSearchParams((prev) => {
    const params = new URLSearchParams(prev);
    if (next) { params.set('mapBar', next.bar); params.set('mapValue', next.value); } else { params.delete('mapBar'); params.delete('mapValue'); }
    return params;
  }, { replace: true });
  return [mapFilter, setMapFilter];
}
