// Character birthday-progress CTA helper: `birthDateCta`.
//
// Pure, deterministic helper for character level call-to-action state.
// No React imports so the logic is unit-testable.

// Map a server-derived `birthDateStatus` (#2757) to the call-to-action the level surfaces render
// when there is no usable level. The CTA distinguishes a genuinely UNSET birth date ("set")
// from one that is present-but-unusable — invalid, in the future, or an unreadable config ("fix")
// — so a user is never told to *set* a date they already entered. Every case deep-links to the
// age editor (`/meatspace/age`) where the field lives. Returns `null` for 'ok' (a real level
// exists; no CTA). Tolerates an absent/unknown status by treating it as 'unset'.
export function birthDateCta(status) {
  const fix = (caption) => ({
    kind: 'fix',
    path: '/meatspace/age',
    title: 'Fix your birth date',
    heading: 'Fix your birth date',
    caption,
    badgeLabel: 'LV !',
    badgeCaption: 'FIX BIRTH DATE',
  });
  switch (status) {
    case 'ok':
      return null;
    case 'unreadable':
      return fix("Your birth date couldn't be read. Re-enter it to restore your level.");
    case 'future':
      return fix('Your birth date is in the future. Update it to see your level.');
    case 'invalid':
      return fix('Your birth date looks invalid. Update it to see your level.');
    case 'unset':
    default:
      return {
        kind: 'set',
        path: '/meatspace/age',
        title: 'Set your birth date',
        heading: 'Set your birth date',
        caption: 'Your level is your life experience — each year lived is a level. Add your birth date to see it.',
        badgeLabel: 'LV —',
        badgeCaption: 'SET BIRTH DATE',
      };
  }
}
