import * as api from '../services/api';
import { useFocusRefreshedList } from './useFocusRefreshedList.js';

// All music video projects for the Create > Music Video grandchildren. Loads on
// mount and refreshes on window focus (debounced 30s) so freshly-created or
// renamed projects surface without a reload.
export function useSidebarMusicVideos() {
  return useFocusRefreshedList(api.listMusicVideoProjectNames, 'music-videos');
}
