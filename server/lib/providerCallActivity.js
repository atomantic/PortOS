// Includes direct text calls which do not pass through the run toolkit.
let active = 0;
export const getDirectProviderCallCount = () => active;
export function beginDirectProviderCall() {
  active++;
  let ended = false;
  return () => { if (!ended) { ended = true; active--; } };
}
