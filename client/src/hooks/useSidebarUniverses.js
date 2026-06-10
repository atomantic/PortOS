import * as api from '../services/api';
import { useFocusRefreshedList } from './useFocusRefreshedList.js';

// All universes for the Create > Universes grandchildren. Loads on mount and
// refreshes on window focus (debounced 30s) so freshly-created or renamed
// universes surface without a reload.
export function useSidebarUniverses() {
  return useFocusRefreshedList(api.listUniverses, 'universes');
}
