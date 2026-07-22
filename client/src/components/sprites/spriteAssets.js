// Shared URL builder for sprite record assets served by the /data/sprites
// static mount — one place for the per-segment encoding rules.
export const spriteAssetUrl = (recordId, relPath) => `/data/sprites/${encodeURIComponent(recordId)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
