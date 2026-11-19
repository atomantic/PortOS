/**
 * API client for the Dev Tools yt-dlp video downloader: start and cancel downloads with SSE progress,
 * list and delete clips, `getYtDlpStatus` and `updateYtDlp`.
 *
 * Dev Tools video downloader (#1946): start/cancel a YouTube/x.com full-video download via yt-dlp (SSE
 * progress), list + delete downloaded clips, plus `getYtDlpStatus`/`updateYtDlp` for the in-place
 * yt-dlp update the page offers when a download fails on a stale binary.
 */

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

// yt-dlp's own version and whether PortOS can update it in place. A stale
// yt-dlp is the usual cause of a failed YouTube download, so the page surfaces
// the state and the one-click remedy next to the URL field.
export const getYtDlpStatus = (options = {}) => request('/devtools/video-download/yt-dlp', options);

export const updateYtDlp = (options = {}) =>
  request('/devtools/video-download/yt-dlp/update', { method: 'POST', ...options });

export const installYtDlp = (options = {}) =>
  request('/devtools/video-download/yt-dlp/install', { method: 'POST', ...options });
