import * as api from '../services/api';
import { useFocusRefreshedList } from './useFocusRefreshedList.js';

const MUSIC_VIDEO_EVENTS = ['music-video:project:changed'];

// All music video projects for the Create > Music Video grandchildren. Loads on
// mount, reloads when a project is created, renamed or deleted, and refreshes
// on window focus (debounced 30s).
export function useSidebarMusicVideos() {
  return useFocusRefreshedList(api.listMusicVideoProjectNames, 'music-videos', MUSIC_VIDEO_EVENTS);
}
