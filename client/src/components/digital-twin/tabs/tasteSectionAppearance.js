import { Building, Film, Monitor, Music, Palette, Shirt, UtensilsCrossed } from 'lucide-react';

const SECTION_ICONS = {
  movies: Film,
  music: Music,
  visual_art: Palette,
  architecture: Building,
  food: UtensilsCrossed,
  fashion: Shirt,
  digital: Monitor
};

const SECTION_COLORS = {
  movies: 'red',
  music: 'green',
  visual_art: 'violet',
  architecture: 'amber',
  food: 'orange',
  fashion: 'pink',
  digital: 'cyan'
};

export function tasteSectionAppearance(sectionId) {
  return {
    Icon: SECTION_ICONS[sectionId] || Palette,
    color: SECTION_COLORS[sectionId] || 'blue',
  };
}
