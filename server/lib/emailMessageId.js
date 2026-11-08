// RFC-822 `Message-ID` normalization shared by the Takeout mbox importer and the
// live Gmail sync. Both key a Gmail activity row as `gmail:<id>` (#15308), so the
// two paths must normalize identically or one email splits into two rows again.
export function cleanMessageId(value) {
  return String(value || '').replace(/[<>]/g, '').trim();
}
