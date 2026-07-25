// The user-facing explanation of a BLOCKED walk-set unlock (#3043), in one
// place because two surfaces render it: the Walk Cycles header panel and the
// Loop Trimmer's lock block. Both describe the same server-stamped
// `walkSet.unlock` — two hand-written copies drifted within the same change
// ("one new grok render each" vs "…per direction"), which is exactly how a user
// meets two different accounts of one irreversible-ish action depending on which
// panel they happened to open.
//
// Pure: takes the stamped block, returns strings. No React, no I/O.

// The three facts a blocked unlock has to convey, assembled once.
//
// `blocked: false` returns null — the caller renders its ordinary Unlock. A
// blocked-but-`acknowledgeable` set gets the regeneration offer and the
// `acknowledgeNoClips` flag that carries the user's consent to the server; a
// blocked and NON-acknowledgeable set gets the dead-end explanation and no
// action, because there is genuinely nothing to offer.
export function walkUnlockCopy(unlock) {
  if (!unlock?.blocked) return null;
  const stranded = unlock.stranded || [];
  const one = stranded.length === 1;
  const who = stranded.length
    ? `${stranded.join(', ')} ${one ? 'was' : 'were'} imported from the source pipeline without ${one ? 'its source clip' : 'their source clips'}, so ${one ? 'it' : 'they'} cannot be re-derived at a new frame count.`
    : 'This walk set was imported from the source pipeline with no directions that can be re-derived here.';

  if (!unlock.acknowledgeable) {
    return {
      text: `${who} At least one directional anchor is also unlocked, so there is nothing to regenerate from either — re-import this character, or create a new character version to revise it.`,
      action: null,
      prompt: null,
      acknowledgeNoClips: false,
      toast: null,
    };
  }
  // Scoped to the stranded list on purpose: the server verifies locked anchors
  // for THOSE directions only (`resolveUnlockBlock` probes `stranded`), so a
  // blanket "each of the 8 can be regenerated" would claim more than it checked
  // — a non-stranded direction whose anchor happens to be unlocked is not
  // covered by the gate, and telling the user otherwise is the same
  // promise-more-than-you-proved mistake the gate itself avoids.
  const regenerated = stranded.length
    ? `${stranded.join(', ')} can be regenerated from ${one ? 'its' : 'their'} locked anchor — one new grok render ${one ? 'for it' : 'each'}`
    : 'each direction can be regenerated from its locked anchor — one new grok render per direction';
  return {
    text: `${who} Unlocking anyway re-opens all 8 directions and ${regenerated}. Nothing on disk is deleted, but every approval is dropped and the set stops compiling until all 8 are approved again.`,
    action: 'Unlock anyway',
    prompt: 'Re-open all 8 for regeneration?',
    acknowledgeNoClips: true,
    toast: 'Walk set unlocked — regenerate each direction from its locked anchor',
  };
}

// What an ordinary (unblocked) unlock reports on success. Lives here so the two
// surfaces' success toasts stay in step with the blocked one above.
export const WALK_UNLOCK_TOAST = 'Walk set unlocked — directions are editable again';
