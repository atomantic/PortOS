/**
 * Universes for the Create > Universes grandchildren (built on `useFocusRefreshedList`, reloads on
 * `universe:changed`).
 *
 * Use when: The sidebar universes section.
 */

import { listUniverseNames } from '../services/apiNavNames.js';
import { useFocusRefreshedList } from '../hooks/useFocusRefreshedList.js';

const UNIVERSE_EVENTS = ['universe:changed'];

// All universes for the Create > Universes grandchildren. Loads on mount,
// reloads when a universe is created, renamed or deleted, and refreshes on
// window focus (debounced 30s).
export function useSidebarUniverses(enabled = true) {
  return useFocusRefreshedList(listUniverseNames, 'universes', UNIVERSE_EVENTS, enabled);
}
