import * as api from '../services/api';
import { useFocusRefreshedList } from './useFocusRefreshedList.js';

const UNIVERSE_EVENTS = ['universe:changed'];

// All universes for the Create > Universes grandchildren. Loads on mount,
// reloads when a universe is created, renamed or deleted, and refreshes on
// window focus (debounced 30s).
export function useSidebarUniverses() {
  return useFocusRefreshedList(api.listUniverseNames, 'universes', UNIVERSE_EVENTS);
}
