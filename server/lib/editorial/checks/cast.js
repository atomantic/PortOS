// Editorial checks — cast group. Extracted from checkRegistry.js (#1829).
// Each entry is a declarative check; see ../README.md and ../checkInfra.js.
import {
  UNMODELED_NAMES_STAGE,
  attributeDialogueByOwner,
  buildAppearingKeys,
  buildCastIdentities,
  buildRosterAppearances,
  canonRosterNamesSummary,
  characterMatcher,
  escalateSeverity,
  normalizeName,
  runManuscriptLlmCheck,
  sceneCastKeys,
  z,
} from '../checkInfra.js';

export const castChecks = [
  {
    id: 'roster.economy',
    sources: ['manuscript', 'canon'],
    label: 'Character roster economy / throwaway names',
    description:
      'Flags named characters who appear in only one issue (a named body the reader is told to remember but who never recurs), too many named characters crowded into the opening issue, and overall roster size relative to the drafted length. Reads canon names + aliases against the stitched manuscript.',
    scope: 'series',
    kind: 'deterministic',
    category: 'casting',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript (per-issue sections) to build the appearance
    // map — so the runner only pays the section-collection I/O when enabled.
    needsManuscript: true,
    configSchema: z.object({
      // A named character appearing in fewer than this many issues is flagged as
      // a non-recurring throwaway. 1 disables the throwaway check (never warn).
      minAppearancesToWarn: z.number().int().min(1).max(10).default(2),
      // Flag the opening issue when more than this many distinct named characters
      // appear in it. 0 disables the first-issue-crowding check.
      maxFirstIssueCharacters: z.number().int().min(0).max(30).default(5),
      // Advisory roster-pressure threshold: flag when the appearing named cast
      // exceeds this many characters per drafted issue. 0 disables it.
      maxCastPerIssue: z.number().min(0).max(50).default(6),
    }),
    configFields: [
      {
        key: 'minAppearancesToWarn',
        label: 'Warn below this many appearances',
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        help: 'Flag a named character who appears in fewer than this many issues (1 = never warn; 2 = flag one-issue-only names). Characters who never appear at all are left alone — they may simply be undrafted.',
      },
      {
        key: 'maxFirstIssueCharacters',
        label: 'Max named characters in opening issue',
        type: 'number',
        min: 0,
        max: 30,
        step: 1,
        help: 'Flag when more than this many distinct named characters appear in the first issue — too many introductions at once dilutes the ones that matter. 0 disables the check.',
      },
      {
        key: 'maxCastPerIssue',
        label: 'Roster-pressure ratio (cast per issue)',
        type: 'number',
        min: 0,
        max: 50,
        step: 0.5,
        help: 'Advisory: flag when the appearing named cast exceeds this many characters per drafted issue. 0 disables the pressure check.',
      },
    ],
    // Need both prose to scan AND at least one named canon character to scan for.
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0
      && Array.isArray(ctx.canon?.characters)
      && ctx.canon.characters.some((c) => typeof c?.name === 'string' && c.name.trim()),
    run: (ctx) => {
      const cfg = ctx.config || {};
      const minAppear = cfg.minAppearancesToWarn ?? 2;
      const maxFirst = cfg.maxFirstIssueCharacters ?? 5;
      const castPerIssue = cfg.maxCastPerIssue ?? 6;
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const sectionCount = sections.length;
      const rows = buildRosterAppearances(ctx);
      const findings = [];
      // All roster findings share category 'casting' and the same shape — collapse
      // the per-block boilerplate (mirrors arc.ticking-clock-hygiene's `flag`).
      const flag = ({ severity, location, problem, suggestion, anchorQuote = '', issueNumber = null }) =>
        findings.push({ severity, category: 'casting', location, problem, suggestion, anchorQuote, issueNumber });
      // A long story makes a one-issue-only named character read as noise more
      // clearly than a one-shot in a 2-issue story — escalate above the low floor.
      const lengthBump = sectionCount >= 8 ? 1 : 0;

      // 1) Throwaway / non-recurring named characters: appears at least once but
      //    in fewer than minAppearancesToWarn issues. Zero-appearance canon
      //    characters are left alone (possibly undrafted — a different concern).
      if (minAppear > 1) {
        for (const r of rows) {
          const n = r.appearedInIssues.length;
          if (n === 0 || n >= minAppear) continue;
          const issuesList = r.appearedInIssues.join(', ');
          // "never recurs" is only true for a one-issue character; with a higher
          // minAppearancesToWarn, a 2+-issue character DOES recur (just under the
          // threshold), so word that case factually.
          const problem = n === 1
            ? `"${r.name}" is a named character who appears in only 1 issue (${issuesList}) — a named body readers are told to remember but who never recurs.`
            : `"${r.name}" is a named character who appears in only ${n} issues (${issuesList}) — fewer than your ${minAppear}-issue recurrence threshold, so they barely register as part of the cast.`;
          flag({
            severity: escalateSeverity(ctx.severityDefault, lengthBump),
            location: r.firstIssueNumber != null ? `Issue ${r.firstIssueNumber}: ${r.name}` : `Character: ${r.name}`,
            problem,
            suggestion: `Cut "${r.name}", merge them into another character, or leave them unnamed (a description) unless they are meant to recur.`,
            anchorQuote: r.anchorQuote,
            issueNumber: r.firstIssueNumber,
          });
        }
      }

      // 2) First-issue crowding: too many distinct named characters introduced in
      //    the opening issue dilutes the ones that matter.
      if (sectionCount > 0 && maxFirst > 0) {
        const firstNumber = sections[0].number;
        const inFirst = rows.filter((r) => r.appearedInIssues.includes(firstNumber));
        if (inFirst.length > maxFirst) {
          // Low by default; escalate to medium only when crowding is well over the
          // threshold (≥1.5×) — it's a pacing nudge, not a correctness error.
          const heavy = inFirst.length >= Math.ceil(maxFirst * 1.5);
          flag({
            severity: escalateSeverity(ctx.severityDefault, heavy ? 1 : 0),
            location: `Issue ${firstNumber} (opening)`,
            problem: `${inFirst.length} named characters appear in the opening issue (${inFirst.map((r) => r.name).join(', ')}) — more than ${maxFirst}. Too many introductions at once makes it hard for readers to tell who matters.`,
            suggestion: 'Introduce fewer named characters up front — delay, merge, or leave some unnamed until readers have anchored to the leads.',
            // Anchor on a real matched token from the opening issue (these rows all
            // first appear there), not the canonical name which may be an alias-only mention.
            anchorQuote: inFirst[0].anchorQuote,
            issueNumber: firstNumber,
          });
        }
      }

      // 3) Roster size pressure (advisory): the cast that ACTUALLY appears vs the
      //    drafted length — tied to prose appearances so canon bloat alone (named
      //    characters who never show up) doesn't trip it.
      if (castPerIssue > 0 && sectionCount > 0) {
        const appearingCast = rows.filter((r) => r.appearedInIssues.length > 0).length;
        if (appearingCast > castPerIssue * sectionCount) {
          flag({
            severity: ctx.severityDefault,
            location: 'Series roster',
            problem: `The drafted story has ${appearingCast} named characters across ${sectionCount} issue${sectionCount === 1 ? '' : 's'} (about ${(appearingCast / sectionCount).toFixed(1)} per issue) — a large roster relative to its length can overwhelm readers.`,
            suggestion: 'Consider consolidating minor named characters or spreading their introductions across more of the story.',
          });
        }
      }

      return findings;
    },
  },
  {
    // LLM-assisted companion to roster.economy (#1412, part of #1283). The
    // deterministic roster.economy scan only sees canon names/aliases; it can't
    // detect proper nouns used as apparent CHARACTER names that were never bibled
    // (the LLM-assist half #1292 called out). This check surfaces those — and
    // classifies them (is this token actually a named character, vs a place/org/
    // brand/honorific the deterministic scan can't tell apart).
    id: 'roster.unmodeled-names',
    sources: ['manuscript', 'canon'],
    label: 'Unmodeled proper nouns used as character names',
    description:
      'LLM scan — surfaces capitalized proper nouns used as apparent CHARACTER names that are ABSENT from the story bible (canon.characters names + aliases), and classifies each (is this actually a named person, vs a place, organization, brand, or honorific the deterministic roster.economy scan can\'t distinguish). Flags throwaway one-appearance unmodeled names readers are asked to remember, suggesting either adding them to canon or leaving them unnamed. The LLM-assisted half of roster economy (#1292) that the deterministic check deliberately leaves alone.',
    scope: 'series',
    kind: 'llm',
    category: 'casting',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript corpus — so the runner only pays the
    // section-collection I/O when a manuscript-consuming check is enabled.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a large unmodeled cast can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a large unmodeled cast can not flood the review.',
      },
    ],
    // Needs prose to scan. Unlike roster.economy this does NOT require a populated
    // canon — an EMPTY bible is the strongest case (every named proper noun is
    // unmodeled), and the prompt's {{^knownCharacters}} branch handles it.
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: async (ctx) => {
      // The known-character roster is fixed per-call overhead (re-sent on each
      // chunk) — it's the exclusion list the model classifies against. Counted into
      // the per-chunk budget so the manuscript isn't squeezed past the window.
      const knownCharacters = canonRosterNamesSummary(ctx.canon);
      // The LLM does ONLY what it alone can: surface a proper noun used as a
      // character name and classify it (person vs place/org/brand/honorific). It
      // does NOT judge recurrence — that's a whole-corpus count the model can't make
      // when the manuscript is chunked (a name in issues 1 and 12 would look like a
      // one-appearance throwaway to whichever chunk sees it). `crossChunkDigest`
      // keeps a later chunk from re-describing a name an earlier chunk surfaced.
      const findings = await runManuscriptLlmCheck(ctx, {
        stage: UNMODELED_NAMES_STAGE,
        category: 'casting',
        context: { knownCharacters },
        crossChunkDigest: true,
        buildVars: (manuscript, _meta, c) => ({ manuscript, knownCharacters: c.knownCharacters }),
      });
      // Deterministic whole-corpus recurrence pass. The model's job is the judgment
      // it alone can make — is this surfaced proper noun a PERSON (vs a place/org/
      // brand/honorific)? — expressed by whether it emits the finding at all and by
      // the name it quotes in `location`. It is NOT trusted for frequency: that's a
      // whole-corpus count it can't make per-chunk (a name in issues 1 and 12 looks
      // like a one-off to whichever chunk sees it). So we OWN `problem`/`suggestion`
      // here — composing them from the deterministic count rather than appending to
      // (and risking contradiction with) the model's free text — and keep only the
      // model's `anchorQuote` + `issueNumber` (facts it's authoritative on). We count
      // the name's distinct-issue appearances across ALL sections, set the location
      // label + severity, and collapse the same name surfaced from different chunks.
      // Malformed findings are DROPPED, not passed through (passing the model's
      // un-vetted text would reopen the contradiction risk this pass closes): one
      // with no quoted name to verify, or one whose quoted name the matcher can't
      // find in any section (a stray/garbled LLM token / 0-appearance phantom).
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const seenNames = new Set();
      const out = [];
      for (const f of findings) {
        const name = (String(f.location || '').match(/"([^"]+)"/) || [])[1];
        // The contract requires the model to quote the surfaced name in `location`.
        // A finding without one is malformed — drop it rather than pass the model's
        // un-vetted free text through unrewritten (which would reopen the contradiction
        // risk this deterministic pass exists to close: keep ONLY anchorQuote +
        // issueNumber, never the model's problem/suggestion).
        if (!name) continue;
        const key = normalizeName(name);
        if (key && seenNames.has(key)) continue; // same unmodeled name from another chunk
        if (key) seenNames.add(key);
        const matcher = characterMatcher([name]);
        const issues = matcher
          ? new Set(sections.filter((s) => matcher.test(s.content || '')).map((s) => s.number))
          : new Set();
        const count = issues.size;
        // The model surfaced a name the matcher can't locate in any section (a garbled
        // token, or a form the whole-token matcher won't match) — drop it rather than
        // emit a finding the editor can't anchor.
        if (count === 0) continue;
        const base = { category: 'casting', anchorQuote: f.anchorQuote || '', issueNumber: f.issueNumber ?? null };
        out.push(count === 1
          ? {
              ...base,
              severity: 'low',
              location: `Throwaway name — "${name}" (1 appearance)`,
              problem: `"${name}" is used as a character name but is not in the story bible, and appears in only one issue — a named body the reader is told to remember but who never recurs and was never bibled.`,
              suggestion: `Add "${name}" to canon only if they are meant to recur; otherwise recast them as an unnamed description (e.g. "the bartender") so the reader isn't asked to track a name that goes nowhere.`,
            }
          : {
              ...base,
              severity: 'medium',
              location: `Unmodeled character — "${name}" (${count} issues)`,
              problem: `"${name}" is used as a character name across ${count} issues but is not in the story bible.`,
              suggestion: `A recurring character should be modeled — add "${name}" to canon.`,
            });
      }
      return out;
    },
  },
  {
    id: 'cast.representation-balance',
    sources: ['manuscript', 'canon', 'reverseOutline'],
    label: 'Cast representation & balance (Bechdel signal, dialogue share, screen time)',
    description:
      'Coarse, computable casting signals: a Bechdel co-presence signal (does any scene put two or more non-male characters on the page together?), dialogue share (does one character dominate the spoken lines?), per-character dialogue distribution relative to stated role (a major character who appears but is oddly silent, or a minor character who dominates the conversation), and screen-time balance (is the appearing named cast strongly skewed by inferred gender?). Gender is inferred only from the canon pronouns field and role tier only from the canon role field — characters with absent or ambiguous pronouns/roles are left out of those signals rather than guessed. Advisory: representation is an authorial choice, so these are nudges, not errors.',
    scope: 'series',
    kind: 'deterministic',
    category: 'casting',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript (per-issue sections) for the dialogue-share
    // scan — so the runner only pays the section-collection I/O when enabled.
    needsManuscript: true,
    configSchema: z.object({
      // Flag dialogue share when the top speaker holds more than this fraction of
      // all attributed dialogue lines (and there are 2+ speakers). 1 disables it.
      maxDialogueShare: z.number().min(0.1).max(1).default(0.6),
      // Minimum attributed dialogue lines before the share/distribution checks run
      // — a handful of lines isn't a meaningful distribution. 0 keeps the floor at 1.
      minDialogueLines: z.number().int().min(0).max(500).default(12),
      // Flag a MINOR-tier character (per the canon `role` field) who holds more
      // than this fraction of all attributed dialogue — a walk-on dominating the
      // conversation. 1 disables the minor-dominating signal.
      maxMinorShare: z.number().min(0.1).max(1).default(0.35),
      // Flag a MAJOR-tier character (per the canon `role` field) who APPEARS in the
      // prose yet holds less than this fraction of the attributed dialogue — a lead
      // who is oddly silent. 0 disables the silent-major signal.
      minMajorShare: z.number().min(0).max(0.5).default(0.05),
      // Flag screen-time skew when one gender holds more than this fraction of the
      // gender-known appearing cast (and 2+ are gender-known). 1 disables it.
      maxGenderShare: z.number().min(0.1).max(1).default(0.8),
      // Run the Bechdel co-presence signal (any scene with 2+ non-male characters).
      bechdelSignal: z.boolean().default(true),
    }),
    configFields: [
      {
        key: 'maxDialogueShare',
        label: 'Max dialogue share for one speaker',
        type: 'number',
        min: 0.1,
        max: 1,
        step: 0.05,
        help: 'Flag when the top speaker holds more than this fraction of all attributed dialogue lines (with 2+ speakers). 1 disables the dialogue-share check.',
      },
      {
        key: 'minDialogueLines',
        label: 'Minimum attributed dialogue lines',
        type: 'number',
        min: 0,
        max: 500,
        step: 1,
        help: 'Skip the dialogue-share/distribution checks until at least this many dialogue lines can be attributed — a few lines is not a meaningful distribution.',
      },
      {
        key: 'maxMinorShare',
        label: 'Max dialogue share for a minor character',
        type: 'number',
        min: 0.1,
        max: 1,
        step: 0.05,
        help: 'Flag when a character whose canon role reads as minor (background, cameo, walk-on, etc.) holds more than this fraction of all attributed dialogue. 1 disables the minor-dominating signal.',
      },
      {
        key: 'minMajorShare',
        label: 'Min dialogue share for a major character',
        type: 'number',
        min: 0,
        max: 0.5,
        step: 0.01,
        help: 'Flag when a character whose canon role reads as major (protagonist, lead, antagonist, etc.) appears in the prose yet holds less than this fraction of the attributed dialogue — a lead who is oddly silent. 0 disables the silent-major signal.',
      },
      {
        key: 'maxGenderShare',
        label: 'Max screen-time share for one gender',
        type: 'number',
        min: 0.1,
        max: 1,
        step: 0.05,
        help: 'Flag when one inferred gender holds more than this fraction of the gender-known appearing cast (with 2+ gender-known characters). 1 disables the screen-time check.',
      },
      {
        key: 'bechdelSignal',
        label: 'Bechdel co-presence signal',
        type: 'boolean',
        help: 'Flag when no scene puts two or more non-male characters on the page together — the structural precondition for the Bechdel test. Needs a reverse outline with charactersPresent.',
      },
    ],
    // Need at least one named canon character to scan for; the per-signal gates
    // (manuscript for dialogue, outline for Bechdel) are decided inside run().
    gate: (ctx) => Array.isArray(ctx.canon?.characters)
      && ctx.canon.characters.some((c) => typeof c?.name === 'string' && c.name.trim()),
    run: (ctx) => {
      const cfg = ctx.config || {};
      const maxDialogueShare = cfg.maxDialogueShare ?? 0.6;
      const minDialogueLines = Math.max(1, cfg.minDialogueLines ?? 12);
      const maxMinorShare = cfg.maxMinorShare ?? 0.35;
      const minMajorShare = cfg.minMajorShare ?? 0.05;
      const maxGenderShare = cfg.maxGenderShare ?? 0.8;
      const bechdelSignal = cfg.bechdelSignal !== false;

      const identities = buildCastIdentities(ctx);
      if (!identities.length) return [];
      const identityByKey = new Map(identities.map((id) => [id.key, id]));
      const nameByKey = new Map(identities.map((id) => [id.key, id.name]));
      const genderByKey = new Map(identities.map((id) => [id.key, id.gender]));
      const findings = [];
      const flag = ({ severity, location, problem, suggestion, anchorQuote = '', issueNumber = null }) =>
        findings.push({ severity, category: 'casting', location, problem, suggestion, anchorQuote, issueNumber });

      // --- 1) Dialogue distribution (share + role-relative outliers) --------
      // The runner injects the canonical stitched corpus as ctx.manuscript
      // (needsManuscript) — reuse it rather than re-stitching ctx.sections.
      // One attribution pass feeds three sub-signals: the overall top-speaker
      // share, a MINOR-tier character dominating the conversation, and a MAJOR-tier
      // character who appears yet is oddly silent. Role tier comes only from the
      // canon `role` field (absent/ambiguous → 'unknown', signal opts out).
      const manuscript = typeof ctx.manuscript === 'string' ? ctx.manuscript : '';
      const wantShare = maxDialogueShare < 1;
      const wantMinorDom = maxMinorShare < 1;
      const wantSilentMajor = minMajorShare > 0;
      if ((wantShare || wantMinorDom || wantSilentMajor) && manuscript.trim()) {
        const owners = identities
          .filter((id) => id.matcher)
          .map((id) => ({ key: id.key, matcher: id.matcher }));
        const { byOwner, attributed } = attributeDialogueByOwner(manuscript, owners);
        if (attributed >= minDialogueLines) {
          // The top-speaker share signal compares one voice against the others, so
          // it needs 2+ speakers to mean anything. The role-relative signals do NOT:
          // a lone minor speaking every line (size 1, 100% share) or a major who
          // appears yet never speaks while a single other voice carries the scene is
          // their STRONGEST case — gating those on size >= 2 would skip exactly the
          // imbalance they exist to catch.
          if (wantShare && byOwner.size >= 2) {
            let topKey = null;
            let topCount = 0;
            for (const [key, count] of byOwner) {
              if (count > topCount) { topCount = count; topKey = key; }
            }
            const share = topCount / attributed;
            if (topKey && share > maxDialogueShare) {
              const pct = Math.round(share * 100);
              // Escalate above the low floor when one voice utterly dominates (≥80%).
              flag({
                severity: escalateSeverity(ctx.severityDefault, share >= 0.8 ? 1 : 0),
                location: 'Series dialogue',
                problem: `"${nameByKey.get(topKey)}" speaks about ${pct}% of the attributed dialogue (${topCount} of ${attributed} lines across ${byOwner.size} speaking characters) — one voice dominating the page can flatten the rest of the cast.`,
                suggestion: `Give other characters more of the conversation, or let scenes play out from a viewpoint where ${nameByKey.get(topKey)} isn't the one talking.`,
              });
            }
          }

          // Role-relative distribution. Silent-major is gated on prose appearance
          // (a major who never appears is just absent — a different signal — not
          // "oddly silent"); the appearing-cast scan is skipped entirely unless the
          // signal is enabled AND there's a major-tier character to score.
          if (wantMinorDom || wantSilentMajor) {
            const hasMajor = identities.some((id) => id.roleTier === 'major');
            const appearingKeys = wantSilentMajor && hasMajor ? buildAppearingKeys(ctx) : null;
            for (const id of identities) {
              const count = byOwner.get(id.key) || 0;
              const share = count / attributed;
              if (wantMinorDom && id.roleTier === 'minor' && share > maxMinorShare) {
                const pct = Math.round(share * 100);
                flag({
                  // A walk-on taking over the conversation is a stronger signal the
                  // higher the share climbs — escalate past the low floor at ≥50%.
                  severity: escalateSeverity(ctx.severityDefault, share >= 0.5 ? 1 : 0),
                  location: 'Series dialogue',
                  problem: `"${id.name}" reads as a minor character (canon role) yet speaks about ${pct}% of the attributed dialogue (${count} of ${attributed} lines) — a walk-on dominating the conversation usually means the cast hierarchy on the page doesn't match the bible.`,
                  suggestion: `Either give ${id.name} a larger stated role to match the page time, or shift dialogue to the characters the story is actually about.`,
                });
              }
              if (wantSilentMajor && id.roleTier === 'major' && appearingKeys.has(id.key) && share < minMajorShare) {
                const pct = Math.round(share * 100);
                flag({
                  // A major who appears but never says a word (0%) is the strongest
                  // form — escalate past the low floor for the silent case.
                  severity: escalateSeverity(ctx.severityDefault, count === 0 ? 1 : 0),
                  location: 'Series dialogue',
                  problem: `"${id.name}" reads as a major character (canon role) and appears in the prose, yet speaks only about ${pct}% of the attributed dialogue (${count} of ${attributed} lines) — a lead who is on the page but barely talks can feel like a passenger in their own story.`,
                  suggestion: `Give ${id.name} more of the conversation in the scenes they appear in, or reconsider whether the stated major role matches their actual presence.`,
                });
              }
            }
          }
        }
      }

      // --- 2) Bechdel co-presence signal -----------------------------------
      // The structural precondition: at least one scene with two or more
      // non-male (female / nonbinary) characters present. Coarse — we can't
      // deterministically read whether they talk about something other than a
      // man — so this is a "no scene even has the cast for it" nudge, and it
      // only fires when gender is actually inferable for the cast.
      if (bechdelSignal) {
        const scenes = Array.isArray(ctx.reverseOutline) ? ctx.reverseOutline : [];
        const scenesWithPresence = scenes.filter(
          (s) => Array.isArray(s?.charactersPresent) && s.charactersPresent.length > 0
        );
        const haveNonMaleKnown = identities.some((id) => id.gender === 'female' || id.gender === 'nonbinary');
        // Only meaningful when the outline records presence AND the cast has at
        // least one known non-male character (otherwise "absent" is just unknown
        // gender, not a representation gap).
        if (scenesWithPresence.length > 0 && haveNonMaleKnown) {
          const anyCopresent = scenesWithPresence.some((scene) => {
            const keys = sceneCastKeys(scene, identityByKey, identities);
            let nonMale = 0;
            for (const k of keys) {
              const g = genderByKey.get(k);
              if (g === 'female' || g === 'nonbinary') nonMale += 1;
              if (nonMale >= 2) return true;
            }
            return false;
          });
          if (!anyCopresent) {
            flag({
              severity: ctx.severityDefault,
              location: 'Series cast',
              problem: 'No scene puts two or more non-male characters on the page together (per the reverse-outline scene presence) — the structural precondition for the Bechdel test is never met. Two women (or non-male characters) are never in a scene to talk to each other.',
              suggestion: 'Add at least one scene where two non-male characters share the page and a conversation that isn\'t about a man — or, if the story\'s premise genuinely calls for it, treat this as expected and disable the signal.',
            });
          }
        }
      }

      // --- 3) Screen-time balance (gender skew) -----------------------------
      // Over the APPEARING named cast (tied to prose appearances so canon-only
      // bloat doesn't trip it), is one inferable gender strongly over-represented?
      if (maxGenderShare < 1) {
        const appearingKeys = buildAppearingKeys(ctx);
        const counts = { female: 0, male: 0, nonbinary: 0 };
        for (const key of appearingKeys) {
          const g = genderByKey.get(key);
          if (g === 'female' || g === 'male' || g === 'nonbinary') counts[g] += 1;
        }
        const known = counts.female + counts.male + counts.nonbinary;
        if (known >= 2) {
          const entries = Object.entries(counts).filter(([, n]) => n > 0);
          const [topGender, topN] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
          const share = topN / known;
          if (share > maxGenderShare) {
            const pct = Math.round(share * 100);
            flag({
              severity: ctx.severityDefault,
              location: 'Series cast',
              problem: `Of the ${known} appearing named characters whose gender is inferable, ${pct}% are ${topGender} (${topN} of ${known}) — a strongly skewed cast. Representation is an authorial choice, but a near-monochrome roster is worth a deliberate look.`,
              suggestion: 'Consider whether some named roles could be cast more diversely, or confirm the skew is intentional for the story and disable the screen-time signal.',
            });
          }
        }
      }

      return findings;
    },
  },
];
