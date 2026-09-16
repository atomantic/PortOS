/**
 * May this provider record gain the OTHER execution mode of its harness?
 *
 * One rule, read by two callers that must never disagree: the provider list
 * decorates each record with `canAddTuiMode` so the card offers the action, and
 * `POST /api/providers/:id/modes/tui` refuses on the same verdict. Gating the
 * button on one expression and the endpoint on another is how a card comes to
 * advertise an action the server rejects.
 *
 * Lives here rather than in `aiToolkit/` because the verdict consults the
 * harness registry, and that directory stays self-contained (see its AGENTS.md).
 */

import { harnessForProvider, harnessRecipe, harnessSupportsMode } from './providerHarnesses.js';
import { modeSiblingId } from './aiToolkit/internal/providerModes.js';

/**
 * Whether a TUI sibling can be minted for `provider`, and with which argv.
 *
 * A refusal carries the HTTP status the endpoint answers with, because the two
 * refusals mean different things to a caller: a record that can never have a
 * TUI mode is a bad request, while a sibling id that is already taken is a
 * conflict with something standing in that slot.
 *
 * @param {object|null|undefined} provider - the record to derive from
 * @param {object[]} providers - every stored provider, for the id-collision check
 * @returns {{ok:true, args:string[]}|{ok:false, status:number, code:string, message:string}}
 */
export function tuiModeAddition(provider, providers = []) {
  const refuse = (status, code, message) => ({ ok: false, status, code, message });

  if (provider?.type !== 'cli') {
    // The CLI id is the stem, so minting it FROM a TUI record would be a
    // rename of the record that already exists, not an addition beside it.
    return refuse(400, 'TUI_MODE_UNSUPPORTED', 'Only a CLI provider can gain an interactive mode.');
  }
  if (typeof provider.command !== 'string' || provider.command.trim() === '') {
    return refuse(400, 'TUI_MODE_UNSUPPORTED', 'This provider stores no command to launch interactively.');
  }

  // An UNKNOWN harness (a custom binary PortOS has no row for) is allowed
  // through with no default argv — the user knows their own program. A KNOWN
  // harness that declares no TUI mode is a different answer: the registry says
  // this program has no interactive mode, so minting one would store a lie.
  const harness = harnessForProvider(provider);
  if (harness && !harnessSupportsMode(harness.id, 'tui')) {
    return refuse(400, 'TUI_MODE_UNSUPPORTED', `${harness.label} has no interactive mode.`);
  }

  const siblingId = modeSiblingId(provider.id, 'tui');
  if (providers.some(entry => entry?.id === siblingId)) {
    return refuse(409, 'TUI_MODE_EXISTS', `A provider with the ID “${siblingId}” already exists.`);
  }

  return { ok: true, args: tuiSiblingArgs(harness) };
}

/** Convenience for the list decoration — the verdict as the one boolean a card needs. */
export const canAddTuiMode = (provider, providers = []) => tuiModeAddition(provider, providers).ok;

/**
 * The argv a freshly minted TUI sibling starts with.
 *
 * Taken from the harness recipe, which already carries the proven interactive
 * line for the programs PortOS ships a row for. An unknown harness gets an
 * empty list rather than a guess — the user edits it like any other provider.
 */
function tuiSiblingArgs(harness) {
  return [...(harnessRecipe(harness?.id)?.modes?.tui?.args || [])];
}
