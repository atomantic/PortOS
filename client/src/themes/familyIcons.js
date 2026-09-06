import { Compass, Hexagon, Palette, Sparkles, Terminal } from 'lucide-react';

export const FAMILY_ICON = {
  classic: Palette,
  glass: Sparkles,
  terminal: Terminal,
  blueprint: Compass,
  kestrel: Hexagon,
};

export const getFamilyIcon = (family) => FAMILY_ICON[family] ?? Palette;
