import { ThumbsDown, ThumbsUp } from 'lucide-react';

// Scope a media gallery to items rated good or bad (one at a time; tap the
// active chip again to clear). Sits beside FavoritesFilterChip.
const CHIPS = [
  { value: 'good', label: 'Good', Icon: ThumbsUp, on: 'bg-port-success/20 border-port-success text-port-success' },
  { value: 'bad', label: 'Bad', Icon: ThumbsDown, on: 'bg-port-error/20 border-port-error text-port-error' },
];

export default function RatingFilterChips({ value, onChange }) {
  return CHIPS.map(({ value: chip, label, Icon, on }) => (
    <button key={chip} type="button" aria-pressed={value === chip} onClick={() => onChange(value === chip ? null : chip)}
      title={`Show ${label.toLowerCase()} only`}
      className={`flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2.5 py-1 rounded-full border text-xs ${value === chip ? on : 'border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'}`}>
      <Icon className="w-3 h-3" aria-hidden="true" /> {label}
    </button>
  ));
}
