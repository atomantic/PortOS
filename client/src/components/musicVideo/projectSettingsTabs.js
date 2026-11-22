/**
 * Project settings drawer tab list. Kept apart from the drawer so the workspace can read the valid
 * `?mvPanel=` ids without statically importing the drawer and its panels (it loads on first open).
 */
import { Bot, CircleDollarSign, FolderOpen, Music, SlidersHorizontal } from 'lucide-react';

export const SETTINGS_TABS = [
  { id: 'project', label: 'Project', icon: SlidersHorizontal },
  { id: 'audio', label: 'Audio', icon: Music },
  { id: 'autopilot', label: 'Autopilot', icon: Bot },
  { id: 'spend', label: 'Spend', icon: CircleDollarSign },
  { id: 'files', label: 'Files', icon: FolderOpen },
];
export const SETTINGS_TAB_IDS = SETTINGS_TABS.map((tab) => tab.id);
