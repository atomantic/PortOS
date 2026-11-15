// Standalone guest pages skip private bootstrap so a password-gate redirect
// cannot discard their fragment admission tickets.
//
// `isPublicGuestRoute` identifies standalone guest pages that skip private app bootstrap.
export function isPublicGuestRoute(pathname) {
  return typeof pathname === 'string'
    && ['/fableloom/join', '/eidoverse/guest'].includes(pathname.replace(/\/+$/, '').toLowerCase());
}
