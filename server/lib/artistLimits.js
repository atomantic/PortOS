// Length/count caps for artists records. Pure constants so the server sanitizer
// (services/artists/logic.js) and the client editors import ONE definition —
// see storyArcLimits.js for the same pattern.
export const NAME_MAX = 120;
export const GENRE_MAX = 120;
export const BIO_MAX = 4000;
export const MUSICAL_STYLE_MAX = 4000;
export const PHYSICAL_DESCRIPTION_MAX = 2000;
export const PORTRAIT_STYLE_MAX = 2000;
export const PORTRAIT_IMAGE_URL_MAX = 1000;

// Press & submission profile: the human-curated text festival, distributor and
// EPK forms ask for. Agents filling those forms read it (music.artist-profile
// tool, GET /api/artists/:id/submission-profile) instead of inventing answers.
// One spec drives the sanitizer, route schema, editor and Markdown export.
// Every value is a plain string; `section` groups the editor and the export.
export const SUBMISSION_FIELD_SPECS = Object.freeze([
  { key: 'creditName', max: 120, section: 'identity', label: 'Name for credits' },
  { key: 'pronouns', max: 40, section: 'identity', label: 'Pronouns' },
  { key: 'location', max: 120, section: 'identity', label: 'Based in' },
  { key: 'contactEmail', max: 200, section: 'identity', label: 'Contact email' },
  { key: 'bioOneLine', max: 300, section: 'bio', label: 'One-line bio' },
  { key: 'bioShort', max: 1500, section: 'bio', label: 'Short bio' },
  { key: 'artistStatement', max: 4000, section: 'statements', label: 'Artist / director statement' },
  { key: 'aiStatement', max: 3000, section: 'statements', label: 'AI process statement' },
  { key: 'highlights', max: 4000, section: 'statements', label: 'Releases, screenings & awards' },
  { key: 'websiteUrl', max: 500, section: 'links', label: 'Website' },
  { key: 'sunoUrl', max: 500, section: 'links', label: 'Suno' },
  { key: 'spotifyUrl', max: 500, section: 'links', label: 'Spotify' },
  { key: 'appleMusicUrl', max: 500, section: 'links', label: 'Apple Music' },
  { key: 'youtubeUrl', max: 500, section: 'links', label: 'YouTube' },
  { key: 'xUrl', max: 500, section: 'links', label: 'X' },
  { key: 'instagramUrl', max: 500, section: 'links', label: 'Instagram' },
  { key: 'tiktokUrl', max: 500, section: 'links', label: 'TikTok' },
  { key: 'substackUrl', max: 500, section: 'links', label: 'Substack' },
  { key: 'bandcampUrl', max: 500, section: 'links', label: 'Bandcamp' },
  { key: 'soundcloudUrl', max: 500, section: 'links', label: 'SoundCloud' },
  { key: 'otherLinks', max: 2000, section: 'links', label: 'Other links' },
  { key: 'submissionNotes', max: 2000, section: 'notes', label: 'Notes for agents filling forms' },
].map((spec) => Object.freeze(spec)));
export const SUBMISSION_FIELDS = Object.freeze(SUBMISSION_FIELD_SPECS.map(({ key }) => key));
