// Editorial checks — naming group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  analyzeNamePair,
  castNameTokens,
  comparisonName,
  escalateSeverity,
  findFirstLetterClusters,
  normalizeName,
  renameSuggestion,
  tokenLabel,
  z,
} from '../checkInfra.js';

export const namingChecks = [
  {
    id: 'naming.dissimilar-names',
    sources: ['canon'],
    label: 'Character name dissimilarity',
    description:
      'Flags character names a reader could confuse — sharing a first letter, length, vowel pattern, opening, ending, near-identical spelling (edit distance) or phonetic key — plus first-letter crowding across the cast. Reads aliases and respects locked characters.',
    scope: 'series',
    kind: 'deterministic',
    category: 'naming',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // How many similarity signals two names must share before they're flagged
      // (near-identical spelling and a phonetic match also flag on their own).
      minSharedSignals: z.number().int().min(1).max(7).default(2),
      // Flag name pairs within this Levenshtein edit distance regardless of the
      // shared-signal count. 0 disables the edit-distance signal entirely.
      minEditDistance: z.number().int().min(0).max(3).default(1),
      // Toggle the individual signals that tend to be noisy on large casts.
      flagSameLength: z.boolean().default(true),
      vowelSkeletonCollision: z.boolean().default(true),
      usePhonetic: z.boolean().default(true),
      // Flag first-letter crowding when a single starting letter is shared by at
      // least 3 names AND at least this fraction of the cast (0 disables).
      maxShareFirstLetterRatio: z.number().min(0).max(1).default(0.4),
    }),
    configFields: [
      {
        key: 'minSharedSignals',
        label: 'Minimum shared signals to flag',
        type: 'number',
        min: 1,
        max: 7,
        step: 1,
        help: 'How many similarity signals (first letter, length, vowel pattern, opening, ending, near-identical spelling, phonetic key) two names must share before they are flagged.',
      },
      {
        key: 'minEditDistance',
        label: 'Flag within edit distance',
        type: 'number',
        min: 0,
        max: 3,
        step: 1,
        help: 'Always flag name pairs within this many single-character edits (e.g. Alina / Alana = 1). 0 turns the edit-distance signal off.',
      },
      {
        key: 'flagSameLength',
        label: 'Treat equal length as a signal',
        type: 'boolean',
        help: 'Count two names of the same length as one similarity signal (noisy on large casts — turn off to ignore).',
      },
      {
        key: 'vowelSkeletonCollision',
        label: 'Treat shared vowel pattern as a signal',
        type: 'boolean',
        help: 'Count names with the same ordered vowels (Blake / Jane → a-e) as one similarity signal.',
      },
      {
        key: 'usePhonetic',
        label: 'Treat phonetic match as a signal',
        type: 'boolean',
        help: 'Count names that sound alike (same Soundex key, e.g. Smith / Smyth) as a similarity signal.',
      },
      {
        key: 'maxShareFirstLetterRatio',
        label: 'First-letter crowding ratio',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        help: 'Flag a starting letter shared by ≥3 names when they make up at least this fraction of the cast. 0 disables the crowding check.',
      },
    ],
    run: (ctx) => {
      const cfg = ctx.config || {};
      const min = cfg.minSharedSignals ?? 2;
      const signalOpts = {
        minEditDistance: cfg.minEditDistance ?? 1,
        flagSameLength: cfg.flagSameLength !== false,
        vowelSkeletonCollision: cfg.vowelSkeletonCollision !== false,
        usePhonetic: cfg.usePhonetic !== false,
      };
      const tokens = castNameTokens(ctx);
      const findings = [];

      // Pairwise confusability over name + alias tokens (skip same-owner pairs).
      for (let i = 0; i < tokens.length; i += 1) {
        for (let j = i + 1; j < tokens.length; j += 1) {
          const a = tokens[i];
          const b = tokens[j];
          if (a.owner === b.owner) continue;
          // Exact normalized collision — two DIFFERENT characters whose names
          // (or an alias) reduce to the same letters once case/punctuation are
          // stripped ("Anne-Marie" / "Anne Marie", or an alias matching another's
          // name). This is the strongest confusion case, so flag it at top severity
          // regardless of the shared-signal threshold (analyzeNamePair treats equal
          // forms as inert, so it's handled here where owner identity is known).
          const na = normalizeName(a.token);
          if (na && na === normalizeName(b.token)) {
            findings.push({
              severity: escalateSeverity(ctx.severityDefault, 2),
              category: 'naming',
              location: `Characters: ${a.ownerName} / ${b.ownerName}`,
              problem: `Character names "${tokenLabel(a)}" and "${tokenLabel(b)}" are identical once case and punctuation are ignored — readers cannot tell them apart.`,
              suggestion: renameSuggestion(a, b),
              anchorQuote: a.token,
              issueNumber: null,
            });
            continue;
          }
          // Single pass yields the signals AND the severity metrics (edit distance,
          // phonetic match) so neither is recomputed below.
          const { signals, distance, phoneticMatch } = analyzeNamePair(a.token, b.token, signalOpts);
          // A near-typo (within the enabled edit-distance threshold) ALWAYS flags —
          // the minEditDistance knob is documented as "Always flag", so it bypasses
          // the shared-signal gate. Otherwise the user-controlled shared-signal
          // count is the gate (phonetic match is a counted signal, not a bypass —
          // Soundex is coarse, so always-flagging it would be noisy).
          const withinEdit = signalOpts.minEditDistance > 0 && distance <= signalOpts.minEditDistance;
          if (!withinEdit && signals.length < min) continue;
          // Severity scales with how confusable the pair really is, above the
          // check's low floor: a near-identical pair (edit distance ≤1, edit-distance
          // enabled) escalates 2; a wider near-typo, a phonetic match, or 4+ signals
          // is strong (escalate 1).
          const nearIdentical = signalOpts.minEditDistance > 0 && distance <= 1;
          const steps = nearIdentical ? 2 : (withinEdit || phoneticMatch || signals.length >= 4 ? 1 : 0);
          findings.push({
            severity: escalateSeverity(ctx.severityDefault, steps),
            category: 'naming',
            location: `Characters: ${a.ownerName} / ${b.ownerName}`,
            problem: `Character names "${tokenLabel(a)}" and "${tokenLabel(b)}" are easy to confuse (${signals.join(', ')}).`,
            suggestion: renameSuggestion(a, b),
            anchorQuote: a.token,
            issueNumber: null,
          });
        }
      }

      // First-letter crowding across the cast — severity scaled by how much of the
      // cast clusters on one starting letter (#1291's "2 of 30 is fine, 4 of 6 is not").
      const ratio = cfg.maxShareFirstLetterRatio ?? 0.4;
      if (ratio > 0) {
        const primaries = tokens.filter((t) => !t.isAlias);
        const clusters = findFirstLetterClusters(primaries.map((t) => t.token), { minCount: 3, maxRatio: ratio });
        for (const cluster of clusters) {
          // Derive the unlocked members from the tokens (not a name-keyed map) so
          // two distinct characters sharing an identical name both count.
          const unlocked = primaries
            .filter((t) => !t.locked && comparisonName(t.token)[0] === cluster.letter)
            .map((t) => t.token);
          const renameHint = unlocked.length
            ? `Consider renaming some of the unlocked ones (${unlocked.join(', ')}) so the cast doesn't blur together.`
            : 'All of these are locked — unlock one to rename it so the cast doesn\'t blur together.';
          findings.push({
            severity: escalateSeverity(ctx.severityDefault, cluster.ratio >= 0.5 ? 2 : 1),
            category: 'naming',
            location: `Characters starting with "${cluster.letter.toUpperCase()}"`,
            problem: `${cluster.names.length} of ${primaries.length} character names start with "${cluster.letter.toUpperCase()}" (${cluster.names.join(', ')}) — readers can confuse names that all open the same way.`,
            suggestion: renameHint,
            anchorQuote: cluster.names[0],
            issueNumber: null,
          });
        }
      }

      return findings;
    },
  },
];
