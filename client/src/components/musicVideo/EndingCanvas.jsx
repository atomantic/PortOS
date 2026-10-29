import CreditsOutroCanvas from './CreditsOutroCanvas.jsx';
import StatsOutroCanvas from './StatsOutroCanvas.jsx';
import { endingPartAt } from '../../../../server/lib/musicVideoEnding.js';

/**
 * The ending after the song (lib/musicVideoEnding.js) at its own time `t`:
 * the cutting room floor, then the credits, whichever is showing.
 */
export default function EndingCanvas({ parts, stats, t }) {
  const at = endingPartAt(parts, t);
  if (!at.part) return null;
  return at.part.kind === 'floor'
    ? <StatsOutroCanvas stats={stats} outro={at.part.outro} t={at.t} durationSec={at.part.durationSec} />
    : <CreditsOutroCanvas credits={at.part.credits} t={at.t} durationSec={at.part.durationSec} />;
}
