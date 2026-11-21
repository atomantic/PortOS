/**
 * Pipeline series for the Create > Pipeline grandchildren (built on `useFocusRefreshedList`, reloads
 * on `pipeline-series:changed`).
 *
 * Use when: The sidebar pipeline-series section.
 */

import { listPipelineSeriesNames } from '../services/apiNavNames.js';
import { useFocusRefreshedList } from './useFocusRefreshedList.js';

const SERIES_EVENTS = ['pipeline-series:changed'];

// All pipeline series for the Create > Pipeline grandchildren. Loads on mount,
// reloads when a series is created, renamed or deleted, and refreshes on window
// focus (debounced 30s).
export function useSidebarSeries(enabled = true) {
  return useFocusRefreshedList(listPipelineSeriesNames, 'pipeline-series', SERIES_EVENTS, enabled);
}
