/**
 * Name and format of the HttpOnly cookie that carries a federated Eidoverse visitor's ticket to the
 * renderer proxy (`EIDOVERSE_GUEST_COOKIE_NAME`, `buildEidoverseGuestCookie`).
 *
 * Only the Eidoverse proxy honors it; it is not a PortOS session and opens no `/api` or `/data` route.
 */
export const EIDOVERSE_GUEST_COOKIE_NAME = 'portos_eidoverse_guest';

export const buildEidoverseGuestCookie = (ticket, { expiresAt, secure = false }) => [
  `${EIDOVERSE_GUEST_COOKIE_NAME}=${encodeURIComponent(ticket)}`,
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  `Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`,
  ...(secure ? ['Secure'] : []),
].join('; ');
