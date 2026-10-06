/**
 * DistroKid's store genres, and a first guess at a song's from its own style
 * words (the Suno style prompt and the musical description the autonomous run
 * wrote). Pure: project in, `{ primary, secondary }` out. The director can
 * always pick another; the adapter matches DistroKid's option by its text.
 */

export const DISTROKID_GENRES = Object.freeze([
  'Alternative', 'Blues', "Children's Music", 'Classical', 'Comedy', 'Country', 'Dance', 'Electronic',
  'Folk', 'Hip Hop/Rap', 'Holiday', 'Industrial', 'Instrumental', 'J-Pop', 'Jazz', 'K-Pop', 'Latin',
  'Metal', 'New Age', 'Pop', 'Punk', 'R&B/Soul', 'Reggae', 'Rock', 'Singer/Songwriter', 'Soundtrack',
  'Spoken Word', 'World',
]);

// Style words to a store genre. The earliest word in the song's style picks the
// primary genre, the next different genre the secondary.
const STYLE_WORDS = [
  [/\b(hip[\s-]?hop|rap|trap|boom[\s-]?bap|drill)\b/gi, 'Hip Hop/Rap'],
  [/\b(r&b|rnb|soul|neo[\s-]?soul|funk)\b/gi, 'R&B/Soul'],
  [/\b(industrial|ebm)\b/gi, 'Industrial'],
  [/\b(edm|house|techno|trance|dubstep|drum (?:and|&|n) bass|dnb|synthwave|electronic|electronica|electro|idm|glitch|downtempo|trip[\s-]?hop|ambient)\b/gi, 'Electronic'],
  [/\b(dance|disco)\b/gi, 'Dance'],
  [/\b(metal|metalcore|djent)\b/gi, 'Metal'],
  [/\b(punk|post[\s-]?punk|hardcore)\b/gi, 'Punk'],
  [/\b(indie|alternative|alt)\b/gi, 'Alternative'],
  [/\b(rock|grunge|shoegaze)\b/gi, 'Rock'],
  [/\b(folk|acoustic|americana)\b/gi, 'Folk'],
  [/\b(country|bluegrass)\b/gi, 'Country'],
  [/\b(jazz|swing|bebop)\b/gi, 'Jazz'],
  [/\b(blues)\b/gi, 'Blues'],
  [/\b(classical|orchestral|chamber|baroque)\b/gi, 'Classical'],
  [/\b(soundtrack|cinematic|film score|score)\b/gi, 'Soundtrack'],
  [/\b(reggae|dub|dancehall)\b/gi, 'Reggae'],
  [/\b(latin|reggaeton|salsa|bossa nova|cumbia)\b/gi, 'Latin'],
  [/\b(k[\s-]?pop)\b/gi, 'K-Pop'],
  [/\b(j[\s-]?pop)\b/gi, 'J-Pop'],
  [/\b(new age|meditation)\b/gi, 'New Age'],
  [/\b(spoken word|poetry)\b/gi, 'Spoken Word'],
  [/\b(singer[\s-]?songwriter)\b/gi, 'Singer/Songwriter'],
  [/\b(pop|synth[\s-]?pop|hyperpop)\b/gi, 'Pop'],
];

const styleText = (project) => {
  const out = project?.autonomousRun?.output || {};
  return [out.sunoStyle, out.musicalDescription, project?.concept?.genre].filter((s) => typeof s === 'string' && s.trim()).join(' \n ');
};

/** `{ primary, secondary }` store genres for the song, either null when its style names none. */
export function suggestDistrokidGenres(project) {
  const text = styleText(project);
  const hits = [];
  for (const [re, genre] of STYLE_WORDS) {
    // A "k-pop" or "j-pop" mention is not also a "pop" one.
    for (const m of text.matchAll(re)) {
      if (genre === 'Pop' && /[kj][\s-]?$/i.test(text.slice(Math.max(0, m.index - 2), m.index))) continue;
      hits.push({ at: m.index, genre });
      break;
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const genres = [...new Set(hits.map((h) => h.genre))];
  return { primary: genres[0] || null, secondary: genres[1] || null };
}
