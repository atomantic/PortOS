/**
 * Zod request schemas for the Settings › Software Homebrew routes (`/api/update/software/homebrew/*`).
 */
import { z } from 'zod';

// Homebrew formula and cask names: lowercase words, digits, `@`, `+`, `.`, `-`,
// `_`, optionally tap-qualified (`owner/tap/name`). Never an option (`-…`).
const homebrewName = z.string().min(1).max(200).regex(/^[a-z0-9][\w.+@-]*(?:\/[\w.+@-]+){0,2}$/i, 'not a Homebrew package name');

export const homebrewStatusQuerySchema = z.object({ fresh: z.enum(['0', '1']).optional() });

export const homebrewUpgradeSchema = z.object({
  names: z.array(homebrewName).min(1).max(500),
  // The owner goes ahead although the upgrade can break what PortOS runs on.
  acknowledgeRisk: z.boolean().optional(),
  acknowledgeBusy: z.boolean().optional(),
});

export const homebrewRepairSchema = z.object({ acknowledgeBusy: z.boolean().optional() });

export const homebrewHoldSchema = z.object({
  names: z.array(homebrewName).min(1).max(100),
  hold: z.boolean(),
});
