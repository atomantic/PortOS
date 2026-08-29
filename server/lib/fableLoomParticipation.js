/**
 * FableLoom audience-participation semantics shared by persistence, prompts,
 * graph validation, and the client editor.
 *
 * Existing stories predate the distinction and behaved as protagonist-led
 * choose-your-own adventures, so missing loom values retain that behavior.
 * New looms created through the product UI default to the primary helper
 * experience, while API clients that omit the field retain legacy behavior.
 */

export const FABLELOOM_PARTICIPATION_MODES = Object.freeze(['helper', 'protagonist']);
export const FABLELOOM_LEGACY_PARTICIPATION_MODE = 'protagonist';
export const FABLELOOM_NEW_PARTICIPATION_MODE = 'helper';

export const FABLELOOM_AUDIENCE_CONNECTION_STATES = Object.freeze(['disconnected', 'connected']);
export const FABLELOOM_AUDIENCE_CONNECTION_DEFAULT = 'disconnected';

export const isFableLoomParticipationMode = (value) => FABLELOOM_PARTICIPATION_MODES.includes(value);
export const asFableLoomParticipationMode = (value) => (
  isFableLoomParticipationMode(value) ? value : FABLELOOM_LEGACY_PARTICIPATION_MODE
);

export const isFableLoomAudienceConnection = (value) => FABLELOOM_AUDIENCE_CONNECTION_STATES.includes(value);
export const asFableLoomAudienceConnection = (value) => (
  isFableLoomAudienceConnection(value) ? value : FABLELOOM_AUDIENCE_CONNECTION_DEFAULT
);

export const audienceCanParticipate = (loom, node) => (
  asFableLoomParticipationMode(loom?.participationMode) === 'protagonist'
  || asFableLoomAudienceConnection(node?.audienceConnection) === 'connected'
);

export const participationContractForPrompt = (loom, { requiresIntroduction = true } = {}) => {
  const mode = asFableLoomParticipationMode(loom?.participationMode);
  if (mode === 'protagonist') {
    return 'The audience acts as the protagonist. Decision scenes may address their choices from the opening scene onward.';
  }
  const medium = typeof loom?.audienceCommunicationMedium === 'string'
    ? loom.audienceCommunicationMedium.trim()
    : '';
  return [
    'The protagonist has independent agency. The audience enters the fiction as themselves and can only advise or help the protagonist.',
    `Communication medium: ${medium || '(not configured)'}.`,
    requiresIntroduction
      ? 'Open passively, establish and visibly activate this medium close to the beginning, and make that activation an in-story invitation to participate.'
      : 'The audience has already been introduced in the series. Preserve the medium and its current in-world availability without repeating the original invitation.',
    'Only scenes with audienceConnection "connected" may be decision loops or accept audience input. Disconnected scenes are passive canon with exactly one automatic continuation. The medium may be lost, stolen, broken, jammed, or restored later; mark every scene accordingly.',
  ].join(' ');
};
