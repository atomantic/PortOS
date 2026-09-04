import { request } from './apiCore.js';

// Selectable rigged + animated records for the avatar surfaces (#5894).
// `GET /avatar/rigged` answers the install's verified animated records, each
// with the `?variant=` spelling that selects it, the serving URL, the
// retargeted clip name, and the server-computed CoS-state coverage — so a
// selector shows what a character covers without re-deriving the vocabulary.
export const getRiggedAvatars = (options) =>
  request('/avatar/rigged', options);
