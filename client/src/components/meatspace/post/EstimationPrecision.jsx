import { estimationToleranceText } from '../../../lib/estimationTolerance.js';

/**
 * The one statement of an estimation drill's grading band, shown wherever a
 * question or its answer key is: a bare `309 - 925` leaves the drillee guessing
 * how precise to be, and an Expected column showing 616 beside an accepted 600
 * reads as a scoring bug until the band is named.
 *
 * Callers gate on the drill type and pass the typography for their surface, so
 * the copy itself has exactly one owner.
 */
export default function EstimationPrecision({ tolerancePct, className = 'text-sm text-gray-400' }) {
  return <div className={className}>{estimationToleranceText(tolerancePct)}</div>;
}
