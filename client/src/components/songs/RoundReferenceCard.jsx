import { AudioLines, ExternalLink } from 'lucide-react';
import { isHttpUrl, tiktokEmbedSrc, tiktokVideoId } from '../../utils/urlNormalize';

// One reference: a TikTok video renders as the official embed iframe; any other
// URL renders as a link card (label + note + the raw URL). A reference with
// attached audio grows an "Analyze audio" action (#2106) that deep-links to
// the analysis workbench (?analyze=<refId>).
export default function RoundReferenceCard({ reference, onAnalyze }) {
  const ttId = tiktokVideoId(reference.url);
  const title = reference.label || reference.url;
  const safeHref = isHttpUrl(reference.url);
  const analyzeButton = reference.audioFilename && onAnalyze ? (
    <button
      type="button"
      onClick={() => onAnalyze(reference.id)}
      className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-accent/50 text-port-accent hover:bg-port-accent/10 w-fit"
    >
      <AudioLines size={14} /> Analyze audio
    </button>
  ) : null;
  if (ttId) {
    return (
      <div className="w-full sm:w-80 lg:w-96 max-w-[45vh] space-y-2">
        <iframe
          title={title}
          src={tiktokEmbedSrc(ttId)}
          className="w-full aspect-[9/16] rounded-lg border border-port-border bg-port-card"
          loading="lazy"
          allow="encrypted-media; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
        />
        {(reference.label || reference.note) && (
          <div className="px-1">
            {reference.label && <p className="text-sm text-white truncate">{reference.label}</p>}
            {reference.note && <p className="text-xs text-gray-500">{reference.note}</p>}
          </div>
        )}
        {analyzeButton}
      </div>
    );
  }
  // Non-http(s) URLs render as a non-clickable card so a javascript:/data:
  // scheme can't ride into an href.
  const Wrapper = safeHref ? 'a' : 'div';
  const wrapperProps = safeHref
    ? { href: reference.url, target: '_blank', rel: 'noopener noreferrer' }
    : {};
  return (
    <div className="w-full sm:w-80 lg:w-96 space-y-2">
      <Wrapper
        {...wrapperProps}
        className={`block bg-port-card border border-port-border rounded-lg p-4 ${safeHref ? 'hover:border-port-accent/50 transition-colors' : ''}`}
      >
        <div className="flex items-center gap-2 text-white">
          <ExternalLink size={15} className="text-port-accent shrink-0" />
          <span className="text-sm truncate">{title}</span>
        </div>
        {reference.note && <p className="mt-1 text-xs text-gray-500">{reference.note}</p>}
        <p className="mt-1 text-xs text-gray-600 truncate">{reference.url}</p>
      </Wrapper>
      {analyzeButton}
    </div>
  );
}
