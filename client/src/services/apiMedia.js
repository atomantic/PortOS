import { request } from './apiCore.js';

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
export const uploadFile = (base64Data, filename) => request('/uploads', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename })
});
export const listUploads = () => request('/uploads');
export const getUploadUrl = (filename) => `/api/uploads/${encodeURIComponent(filename)}`;
export const deleteUpload = (filename) => request(`/uploads/${encodeURIComponent(filename)}`, { method: 'DELETE' });
export const deleteAllUploads = () => request('/uploads?confirm=true', { method: 'DELETE' });
