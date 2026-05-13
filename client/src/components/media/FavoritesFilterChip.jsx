import { Star } from 'lucide-react';

// Pill that scopes a media gallery to favorited items. Used by MediaHistory,
// ImageGen, VideoGen — anywhere a grid of MediaCards needs a "show only the
// starred ones" toggle. `size` matches the surrounding chip row so the gold
// pressed state lines up visually with sibling filter chips.
export default function FavoritesFilterChip({ active, onToggle, size = 'sm' }) {
  const padding = size === 'sm' ? 'px-2 py-1' : 'px-2.5 py-1';
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center gap-1 ${padding} rounded-full border text-xs ${
        active
          ? 'bg-port-warning/20 border-port-warning text-port-warning'
          : 'border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'
      }`}
      title="Show favorites only"
      aria-pressed={active}
    >
      <Star className={`w-3 h-3 ${active ? 'fill-current' : ''}`} /> Favorites
    </button>
  );
}
