// Trigger a browser "Save as…" for in-memory data without leaking the object
// URL or the temporary <a>. Accepts a Blob, ArrayBuffer, typed array, or string
// — anything the Blob constructor takes. Pass `type` to set the MIME type when
// the data isn't already a Blob (defaults to application/octet-stream).
//
// Collapses the inline `URL.createObjectURL` + `<a download>` + `revokeObjectURL`
// dance (e.g. the soul ExportTab). Data-URL downloads (CityPhotoOverlay) don't
// fit — they have no object URL to revoke, and a data-URL string would get
// re-wrapped in a Blob here.
export function downloadBlob(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
