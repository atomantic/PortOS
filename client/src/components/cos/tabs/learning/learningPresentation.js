// Evidence pairing (issue #2617): when the server classified a task type on
// its recency-windowed rate, label the percentage with the WINDOW's sample
// count — rendering "0%" beside the lifetime total ("200 attempts") would
// materially overstate the evidence behind the rate.
export const runsLabel = (item, noun = 'runs') =>
  item?.rateSource === 'windowed'
    ? `${item.windowedCompleted} recent ${noun}`
    : `${item?.completed} ${noun}`;

export function getSuccessRateColor(rate) {
  if (rate >= 80) return 'text-port-success';
  if (rate >= 60) return 'text-port-warning';
  return 'text-port-error';
}

export function getSuccessRateBg(rate) {
  if (rate >= 80) return 'bg-port-success';
  if (rate >= 60) return 'bg-port-warning';
  return 'bg-port-error';
}
