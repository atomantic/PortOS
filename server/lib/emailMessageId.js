// RFC-822 `Message-ID` normalization shared by the Takeout mbox importer and the live Gmail sync.
//
// `cleanMessageId(value)` normalizes an RFC-822 `Message-ID` (angle brackets stripped, trimmed) — the
// one rule the Gmail Takeout importer and live Gmail sync share for the `gmail:<id>` activity key
// (#15308).
//
// Both key a Gmail activity row as `gmail:<id>` (#15308), so the two paths must normalize identically
// or one email splits into two rows again.
export function cleanMessageId(value) {
  return String(value || '').replace(/[<>]/g, '').trim();
}
