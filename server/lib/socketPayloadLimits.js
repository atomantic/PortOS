// Keep the transport above the handler caps even on Engine.IO polling, which
// base64-encodes binary attachments. Reserve 64 KiB for packet framing and
// metadata, including a small over-cap payload reaching its handler refusal.
export const SOCKET_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
export const SOCKET_MAX_PAYLOAD_BYTES = 4 * Math.ceil(SOCKET_MEDIA_MAX_BYTES / 3) + 64 * 1024;
