/** Fixed visual directions for face sheets. Left/right mean the image, never the subject. */
export const FACE_SHEET_ANGLE_TEMPLATE = 'music-video-face-angles.png';
export const FACE_SHEET_TEMPLATE_INSTRUCTION = "Reference image 1 is ONLY an angle/layout guide: its top row fixes the five angles; its bottom row is placeholder moods, so use the mood count and layout specified below. Follow each grey head's nose and yellow arrow. LEFT faces image-left; RIGHT faces image-right. Left-facing and right-facing panels are mirror opposites. Never copy the template's drawing style, grey skin or arrows; use the person's identity from the remaining references";

const angles = [
  { label: 'FRONT', turn: 0, profile: false },
  { label: '3/4 LEFT', turn: -1, profile: false },
  { label: 'PROFILE LEFT', turn: -1, profile: true },
  { label: '3/4 RIGHT', turn: 1, profile: false },
  { label: 'PROFILE RIGHT', turn: 1, profile: true },
];

/** Regenerate the shipped PNG with sharp(Buffer.from(faceSheetAngleTemplateSvg())).png(). */
export function faceSheetAngleTemplateSvg() {
  const head = (turn, profile) => {
    const face = `<ellipse cx="0" cy="0" rx="${profile ? 40 : 61}" ry="83" fill="#929292"/><path d="M-53 98 Q0 68 53 98 L75 125 H-75Z" fill="#777"/>`;
    if (!turn) return `${face}<path d="M-5 -3 L0 13 L5 -3" fill="none" stroke="#ddd" stroke-width="5"/><circle cx="-24" cy="-23" r="5" fill="#333"/><circle cx="24" cy="-23" r="5" fill="#333"/>`;
    // Draw image-right once and mirror the whole head (including nose and arrow) for image-left.
    return `<g transform="scale(${turn} 1)">${face}<path d="M${profile ? 28 : 35} -27 L${profile ? 79 : 69} 4 L${profile ? 29 : 38} 17Z" fill="#ccc"/><circle cx="${profile ? 23 : 19}" cy="-28" r="5" fill="#333"/><path d="M-40 150 H55 L39 138 M55 150 L39 162" fill="none" stroke="#ffd43b" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  };
  const panels = [0, 1].flatMap((row) => angles.map((angle, column) => {
    const label = row ? `MOOD ${column + 1}` : angle.label;
    return `<g transform="translate(${column * 320} ${row * 320})"><rect x="4" y="4" width="312" height="312" fill="#252525" stroke="#555"/><text x="160" y="37" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#eee">${label}</text><g transform="translate(160 146)">${head(row ? 0 : angle.turn, row ? false : angle.profile)}</g></g>`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="640" viewBox="0 0 1600 640">${panels.join('')}</svg>`;
}
