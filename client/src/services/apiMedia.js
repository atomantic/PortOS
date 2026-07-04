import { request, API_BASE, maybeRedirectToLogin } from './apiCore.js';

// Screenshots
export const uploadScreenshot = (base64Data, filename, mimeType) => request('/screenshots', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename, mimeType })
});

// Attachments (generic file uploads for tasks)
export const uploadAttachment = (base64Data, filename) => request('/attachments', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename })
});
export const getAttachment = (filename) => request(`/attachments/${encodeURIComponent(filename)}`);
export const deleteAttachment = (filename) => request(`/attachments/${encodeURIComponent(filename)}`, { method: 'DELETE' });
export const listAttachments = () => request('/attachments');

// Uploads (general file storage)
export const uploadFile = (base64Data, filename, options = {}) => request('/uploads', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename }),
  ...options
});
export const listUploads = (options = {}) => request('/uploads', options);
export const getUploadUrl = (filename) => `/api/uploads/${encodeURIComponent(filename)}`;
export const deleteUpload = (filename, options = {}) => request(`/uploads/${encodeURIComponent(filename)}`, { method: 'DELETE', ...options });
export const deleteAllUploads = (options = {}) => request('/uploads?confirm=true', { method: 'DELETE', ...options });

// Image Cleaner — composable opt-in pipeline (metadata strip and/or denoise).
// Uploads the RAW image bytes (no base64 inflation) with the step selection in
// the query string; the cleaned bytes come back as the response body and the
// per-step report rides in the `X-Clean-Report` header. Bypasses request()
// because that helper assumes a JSON response and can't surface a Blob body +
// custom header. Returns `{ blob, mimeType, report }`. Throws on failure so the
// page's own catch can toast (no silent flag needed — this never double-toasts).
//
// `steps` is `{ metadata?: boolean, denoise?: boolean }`; both default on the
// server (metadata ON, denoise OFF) when omitted.
export const cleanImage = async (file, steps = {}) => {
  const params = new URLSearchParams();
  if (typeof steps.metadata === 'boolean') params.set('metadata', steps.metadata ? '1' : '0');
  if (typeof steps.denoise === 'boolean') params.set('denoise', steps.denoise ? '1' : '0');
  const qs = params.toString();

  // Always send application/octet-stream rather than the browser's reported
  // file.type. The server sniffs the real format from magic bytes, so a file
  // the page accepted by extension despite an unreliable MIME (image/jpg,
  // image/pjpeg, text/plain, or empty) must not be forwarded with a type the
  // route's express.raw() type-filter would refuse to parse — that would fail
  // with an empty body before the magic-byte sniff ever runs. octet-stream is
  // always in the parser's accepted set.
  const response = await fetch(`${API_BASE}/image-clean${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  }).catch(() => null);

  if (!response) throw new Error('Server unreachable — check your connection and try again');

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to clean image' }));
    maybeRedirectToLogin(response, error);
    const err = new Error(error.error || `HTTP ${response.status}`);
    err.code = error?.code;
    err.status = response.status;
    throw err;
  }

  const reportHeader = response.headers.get('X-Clean-Report');
  let report = null;
  if (reportHeader) { try { report = JSON.parse(reportHeader); } catch { report = null; } }
  const blob = await response.blob();
  return { blob, mimeType: blob.type || report?.format || 'application/octet-stream', report };
};
