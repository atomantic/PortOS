/** Legacy XML points carry src (including null); legacy HAE points do not. */
export function healthPointOrigin(point) {
  return point.origin ?? (Object.prototype.hasOwnProperty.call(point, 'src') ? 'xml' : 'hae');
}

/** Identity within one metric: HAE is already device-merged; XML is per source. */
export function healthPointKey(point) {
  const origin = healthPointOrigin(point);
  return JSON.stringify([origin, origin === 'xml' ? (point.src ?? null) : null, point.date]);
}
