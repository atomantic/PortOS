/**
 * May this provider record gain the OTHER execution mode of its harness?
 *
 * One rule for two callers that must never disagree: the provider list decorates each record with `canAddTuiMode` (the card offers the action) and `POST /api/providers/:id/modes/tui` refuses on the same verdict (gating button and endpoint on different expressions makes a card advertise a rejected action). Lives here, not `aiToolkit/`, because the verdict consults the harness registry and that directory stays self-contained (see its AGENTS.md).
 */

import { harnessForProvider, harnessRecipe, harnessSupportsMode } from './providerHarnesses.js';
import { modeSiblingId, providerModeGroups } from './aiToolkit/internal/providerModes.js';

/**
 * Whether a TUI sibling can be minted for `provider`, and with which argv. A refusal carries the HTTP status the endpoint answers with (a record that can never have a TUI mode is a bad request; a harness that already HAS one, or a sibling id something else holds, is a conflict).
 *
 * @param {object|null|undefined} provider - the record to derive from
 * @param {object[]} providers - every stored provider, for the pairing and id checks
 * @param {{id:string,type:string}[]|null} [executionModes] - this record's mode
 *   group when the caller already computed it (the provider list does, per
 *   record); derived here otherwise
 * @returns {{ok:true, args:string[]}|{ok:false, status:number, code:string, message:string}}
 */
export function tuiModeAddition(provider, providers = [], executionModes = null) {
  const refuse = (status, code, message) => ({ ok: false, status, code, message });

  if (provider?.type !== 'cli') {
    // The CLI id is the stem, so minting it FROM a TUI record would rename the existing record, not add beside it.
    return refuse(400, 'TUI_MODE_UNSUPPORTED', 'Only a CLI provider can gain an interactive mode.');
  }
  if (typeof provider.command !== 'string' || provider.command.trim() === '') {
    return refuse(400, 'TUI_MODE_UNSUPPORTED', 'This provider stores no command to launch interactively.');
  }

  // An UNKNOWN harness (a custom binary with no row) passes with no default argv (the user knows their program); a KNOWN harness declaring no TUI mode is different: minting one would store a lie.
  const harness = harnessForProvider(provider);
  if (harness && !harnessSupportsMode(harness.id, 'tui')) {
    return refuse(400, 'TUI_MODE_UNSUPPORTED', `${harness.label} has no interactive mode.`);
  }

  // Ask whether the harness ALREADY has its interactive mode, not merely whether `<id>-tui` is free: `providerModeGroups` pairs `<stem>-cli` with `<stem>-tui`, so shipped `grok-cli` is already half a pair while `grok-cli-tui` sits unclaimed; checking only the id would mint a pointless third record.
  const modes = executionModes
    || providerModeGroups(providers).find(group => group.some(mode => mode.id === provider.id))
    || [];
  if (modes.some(mode => mode.type === 'tui')) {
    return refuse(409, 'TUI_MODE_EXISTS', `${provider.name || provider.id} already has an interactive mode.`);
  }

  const siblingId = modeSiblingId(provider.id, 'tui');
  if (providers.some(entry => entry?.id === siblingId)) {
    return refuse(409, 'TUI_MODE_EXISTS', `A provider with the ID “${siblingId}” already exists.`);
  }

  return { ok: true, args: tuiSiblingArgs(harness) };
}

/** The argv a freshly minted TUI sibling starts with: from the harness recipe's proven interactive line for programs PortOS ships a row for; an unknown harness gets `[]` rather than a guess. */
function tuiSiblingArgs(harness) {
  return [...(harnessRecipe(harness?.id)?.modes?.tui?.args || [])];
}
