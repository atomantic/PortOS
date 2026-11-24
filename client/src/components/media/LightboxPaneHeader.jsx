import { X, Star, ThumbsUp, ThumbsDown, ShieldCheck } from 'lucide-react';

const RATING_BUTTONS = [['good', ThumbsUp, 'bg-port-success/90 text-white'], ['bad', ThumbsDown, 'bg-port-error/90 text-white']];

function verificationBadgeClass(verification) {
  if (verification.overridden) return 'bg-purple-600/20 text-purple-300';
  return verification.verdict === 'pass' ? 'bg-port-success/20 text-port-success' : 'bg-port-error/20 text-port-error';
}

function verificationBadgeText(verification) {
  if (verification.overridden) return 'Override';
  return verification.verdict === 'pass' ? 'Verified' : 'Defect';
}

function VerificationBadge({ verification }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${verificationBadgeClass(verification)}`}
      title={verification.summary || (verification.verdict === 'pass' ? 'Verification passed' : 'Defect detected')}
    >
      <ShieldCheck className="w-3 h-3" />
      {verificationBadgeText(verification)}
    </span>
  );
}

function RatingButtons({ rating }) {
  return RATING_BUTTONS.map(([value, Icon, on]) => {
    const active = rating.value === value;
    return (
      <button key={value} type="button" disabled={rating.busy} aria-pressed={active}
        onClick={() => rating.onRate(active ? null : value)}
        className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded disabled:opacity-50 ${active ? on : 'text-gray-400 hover:text-white hover:bg-port-border/50'}`}
        aria-label={value === 'good' ? 'Good' : 'Bad'}
        title={active ? `Rated ${value} (tap to clear)` : (rating.title?.[value] || (value === 'good' ? 'Good: keep it' : 'Bad: a file to clean up'))}>
        <Icon className="w-4 h-4" />
      </button>
    );
  });
}

export default function LightboxPaneHeader({ item, isVideo, rating, starred, onAnnotationChange, onClose }) {
  return (
    <header className="shrink-0 flex items-center justify-between p-3 border-b border-port-border">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs uppercase tracking-wide text-gray-400 truncate">{isVideo ? 'Video' : 'Image'} settings</span>
        {item?.verification && <VerificationBadge verification={item.verification} />}
      </div>
      <div className="flex items-center gap-1">
        {rating && <RatingButtons rating={rating} />}
        {onAnnotationChange && (
          <button
            type="button"
            onClick={() => onAnnotationChange({ starred: !starred })}
            className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded ${starred ? 'bg-port-warning/90 text-black' : 'text-gray-400 hover:text-white hover:bg-port-border/50'}`}
            aria-label={starred ? 'Unfavorite' : 'Favorite'}
            title={starred ? 'Unfavorite (s)' : 'Favorite (s)'}
          >
            <Star className={`w-4 h-4 ${starred ? 'fill-current' : ''}`} />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50 min-h-[44px] min-w-[44px] flex items-center justify-center"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
