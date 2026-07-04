import { request } from './apiCore.js';

// Video downloader (#1946) — Dev Tools utility that downloads a full video from
// a YouTube or x.com/Twitter URL via yt-dlp. Kickoff returns `{ jobId }`;
// progress streams over SSE (subscribe with useSseProgress). `options` lets a
// caller suppress request()'s auto-toast with `{ silent: true }`.
export const startVideoDownload = (url, options = {}) => request('/devtools/video-download', {
  method: 'POST',
  body: JSON.stringify({ url }),
  ...options,
});

export const videoDownloadEventsUrl = (jobId) =>
  `/api/devtools/video-download/${encodeURIComponent(jobId)}/events`;

export const cancelVideoDownload = (jobId, options = {}) =>
  request(`/devtools/video-download/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    ...options,
  });

// The `source: 'download'` slice of video-history, newest first.
export const listVideoDownloads = (options = {}) => request('/devtools/video-download/downloads', options);

export const deleteVideoDownload = (id, options = {}) =>
  request(`/devtools/video-download/downloads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...options,
  });
