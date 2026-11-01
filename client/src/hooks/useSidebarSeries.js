import * as api from '../services/api';
import { useFocusRefreshedList } from './useFocusRefreshedList.js';

const SERIES_EVENTS = ['pipeline-series:changed'];

// All pipeline series for the Create > Pipeline grandchildren. Loads on mount,
// reloads when a series is created, renamed or deleted, and refreshes on window
// focus (debounced 30s).
export function useSidebarSeries() {
  return useFocusRefreshedList(api.listPipelineSeriesNames, 'pipeline-series', SERIES_EVENTS);
}
