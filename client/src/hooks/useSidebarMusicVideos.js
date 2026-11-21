/**
 * Music video projects for the Create > Music Video grandchildren (built on `useFocusRefreshedList`,
 * reloads on `music-video:project:changed`).
 *
 * Use when: The sidebar music-video projects section.
 */

import { listMusicVideoProjectNames } from '../services/apiNavNames.js';
import { useFocusRefreshedList } from './useFocusRefreshedList.js';

const MUSIC_VIDEO_EVENTS = ['music-video:project:changed'];

// All music video projects for the Create > Music Video grandchildren. Loads on
// mount, reloads when a project is created, renamed or deleted, and refreshes
// on window focus (debounced 30s).
export function useSidebarMusicVideos(enabled = true) {
  return useFocusRefreshedList(listMusicVideoProjectNames, 'music-videos', MUSIC_VIDEO_EVENTS, enabled);
}
