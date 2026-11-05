import { IMAGE_GEN_MODE } from './generationModes.js';

// CLI drivers choose their own subsequent image-tool calls. These markers
// describe only what PortOS supplied to the driver, not provider use.
export const CLI_IMAGE_INPUT_PROVENANCE = Object.freeze({
  [IMAGE_GEN_MODE.CODEX]: 'cli-attachments',
  [IMAGE_GEN_MODE.GROK]: 'cli-requested',
  [IMAGE_GEN_MODE.AGY]: 'cli-requested',
});

/** Legacy CLI metadata never proved that the driver forwarded its inputs. */
export function projectImageInputProvenance(metadata) {
  if (!Object.hasOwn(CLI_IMAGE_INPUT_PROVENANCE, metadata?.mode) || metadata.inputProvenance !== 'provider-inputs') return metadata;
  return { ...metadata, inputProvenance: CLI_IMAGE_INPUT_PROVENANCE[metadata.mode] };
}
