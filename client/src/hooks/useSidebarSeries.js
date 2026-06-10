import * as api from '../services/api';
import { useFocusRefreshedList } from './useFocusRefreshedList.js';

// All pipeline series for the Create > Pipeline grandchildren. Loads on mount
// and refreshes on window focus (debounced 30s) so freshly-created or renamed
// series surface without a reload.
export function useSidebarSeries() {
  return useFocusRefreshedList(api.listPipelineSeries, 'pipeline-series');
}
