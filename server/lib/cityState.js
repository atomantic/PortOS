/**
 * Best-effort US city/state parser for a free-form address line.
 */

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/**
 * Parse an address value into { city, state } best-effort. Handles the common
 * "123 Main St, Portland, OR 97201" and "Portland, OR" shapes; returns nulls
 * when it can't find a 2-letter state token.
 */
export function parseCityState(address) {
  if (typeof address !== 'string' || !address.trim()) return { city: null, state: null };
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  let state = null;
  let city = null;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const tokens = parts[i].split(/\s+/);
    const stTok = tokens.find((t) => US_STATES.has(t.toUpperCase()));
    if (stTok) {
      state = stTok.toUpperCase();
      // City is the comma-part immediately before the state part (or the part's
      // leading tokens if state shares the part).
      if (i > 0) city = parts[i - 1];
      else if (tokens.length > 1) city = tokens.slice(0, tokens.indexOf(stTok)).join(' ') || null;
      break;
    }
  }
  return { city: city || null, state };
}
