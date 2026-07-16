/**
 * Digital Twin — Live Avatar Bio.
 *
 * Assembles a concise, three-part persona ("Who I am / How I speak / What I
 * know") sized for live-avatar platforms (HeyGen, Tavus, Simli, ElevenLabs
 * conversational agents, etc.) whose persona/knowledge fields want a tight
 * blurb, not the full soul-document dump that Export produces.
 *
 * Two paths:
 *   - buildAvatarBio()  — DETERMINISTIC. Pure assembly from the twin documents +
 *     stored traits + goals. No LLM call, so it is safe to run on tab load and
 *     never trips the "no cold-bootstrap LLM calls" policy.
 *   - polishAvatarBio() — explicit, user-triggered provider call that rewrites
 *     the deterministic draft into first-person, avatar-ready prose.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { DIGITAL_TWIN_DIR, callProviderAI } from './digital-twin-helpers.js';
import { loadMeta } from './digital-twin-meta.js';
import { getTraits } from './digital-twin-analysis.js';
import { getGoals } from './identity.js';
import { getProviderById } from './providers.js';
import { estimateTokens } from '../lib/contextBudget.js';

// Bio length presets. `blurb` is a single paragraph per section (avatar persona
// fields are often short); `persona` is the balanced default; `knowledge` keeps
// more detail for platforms that accept a longer knowledge-base document.
export const AVATAR_BIO_LENGTHS = ['blurb', 'persona', 'knowledge'];
export const DEFAULT_AVATAR_BIO_LENGTH = 'persona';

async function readDoc(filename) {
  const filePath = join(DIGITAL_TWIN_DIR, filename);
  if (!existsSync(filePath)) return null;
  return readFile(filePath, 'utf-8').catch(() => null);
}

/**
 * Pull a single `**Label:** value` line out of a markdown block (the SOUL.md
 * identity list uses this shape). Returns the trimmed value or null.
 */
function pullLabeledLine(md, label) {
  if (!md) return null;
  const m = md.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
  return m ? m[1].trim() : null;
}

/**
 * Extract the body of a `## Heading` (or `### Heading`) section — everything up
 * to the next heading of the same-or-higher level (or end of document). Returns
 * trimmed text or null. Line-based rather than a single regex so a section that
 * runs to EOF (no trailing heading) still resolves.
 */
function extractSection(md, heading) {
  if (!md) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^(#{2,3})\\s+${escaped}\\s*$`, 'i');
  const lines = md.split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) { start = i + 1; level = m[1].length; break; }
  }
  if (start === -1) return null;
  const body = [];
  for (let j = start; j < lines.length; j++) {
    const hm = lines[j].match(/^(#{1,6})\s/);
    if (hm && hm[1].length <= level) break; // next same-or-higher-level heading
    body.push(lines[j]);
  }
  const text = body.join('\n').trim();
  return text || null;
}

/**
 * Pull the answer text that follows a `### Question?` heading in the enrichment
 * docs (VALUES.md, PERSONALITY.md, NON_NEGOTIABLES.md). Matches the first
 * heading that *contains* `needle` (case-insensitive). Returns the first
 * non-empty line of the answer, or null.
 */
function pullEnrichmentAnswer(md, needle) {
  if (!md) return null;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,4}\s/.test(lines[i]) && lines[i].toLowerCase().includes(needle.toLowerCase())) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (/^#{1,4}\s/.test(t)) break; // hit the next heading — no answer
        if (t) return t;
      }
    }
  }
  return null;
}

/** Strip markdown backslash-escapes (e.g. `\[._.]/` → `[._.]/`) and trim. */
function unescapeMd(str) {
  return str == null ? str : str.replace(/\\([[\]._./*])/g, '$1').trim();
}

/** Drop trailing sentence punctuation/whitespace so callers can re-add one `.`. */
function stripTrailingPunct(str) {
  return str == null ? str : str.replace(/[.;,\s]+$/, '');
}

/**
 * Collapse a markdown bullet block into a compact `a; b; c` phrase. Only real
 * bullet lines (`-`/`*`) are taken — plain prose lines that happen to sit inside
 * the section (e.g. a trailing "Tone target:" lead-in) are skipped.
 */
function bulletsToPhrase(block, max = 8) {
  if (!block) return null;
  const items = block
    .split('\n')
    .filter(l => /^\s*[-*]\s+/.test(l))
    .map(l => l.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .slice(0, max);
  return items.length ? items.join('; ') : null;
}

function formalityWord(n) {
  if (n == null) return null;
  if (n <= 3) return 'casual';
  if (n <= 6) return 'balanced';
  return 'formal';
}
function verbosityWord(n) {
  if (n == null) return null;
  if (n <= 3) return 'terse';
  if (n <= 6) return 'measured';
  return 'elaborate';
}

/**
 * Build the deterministic three-part avatar bio.
 *
 * Every fact is pulled from real twin data with a graceful fallback — a missing
 * document or section simply omits its contribution rather than throwing. When
 * the whole twin is empty the sections come back with a single "no data yet"
 * note so the UI can still render and point the user at enrichment.
 */
export async function buildAvatarBio({ length = DEFAULT_AVATAR_BIO_LENGTH } = {}) {
  const useLength = AVATAR_BIO_LENGTHS.includes(length) ? length : DEFAULT_AVATAR_BIO_LENGTH;

  // Honor the same disabled-document boundary as getDigitalTwinForPrompt and
  // exportDigitalTwin: a doc the user turned off must not surface in the bio (and
  // must never be transmitted to an external provider on Refine). Only a doc that
  // is explicitly disabled in meta is excluded; untracked/ambient files still read.
  const meta = await loadMeta().catch(() => ({ documents: [] }));
  const disabled = new Set(
    (Array.isArray(meta.documents) ? meta.documents : [])
      .filter(d => d && d.enabled === false)
      .map(d => d.filename)
  );
  const readEnabled = (filename) => (disabled.has(filename) ? Promise.resolve(null) : readDoc(filename));

  const [soul, communication, personality, cognitive, technical, creative, values, nonNegotiables, traits, goalsData] =
    await Promise.all([
      readEnabled('SOUL.md'),
      readEnabled('COMMUNICATION.md'),
      readEnabled('PERSONALITY.md'),
      readEnabled('COGNITIVE.md'),
      readEnabled('TECHNICAL.md'),
      readEnabled('CREATIVE.md'),
      readEnabled('VALUES.md'),
      readEnabled('NON_NEGOTIABLES.md'),
      getTraits().catch(() => null),
      getGoals().catch(() => ({ goals: [] })),
    ]);

  const name = unescapeMd(pullLabeledLine(soul, 'Name')) || 'the user';
  const aliases = unescapeMd(pullLabeledLine(soul, 'Aliases'));
  const orientation = pullLabeledLine(soul, 'Orientation');
  const primaryMode = pullLabeledLine(soul, 'Primary Mode');
  const topValues = pullEnrichmentAnswer(values, 'top three values') || pullEnrichmentAnswer(values, 'values that guide');

  const comm = traits?.communicationProfile || null;
  const hasVoiceTraits = Boolean(comm && (comm.formality != null || comm.verbosity != null ||
    comm.preferredTone || (Array.isArray(comm.distinctiveMarkers) && comm.distinctiveMarkers.length)));

  const goals = Array.isArray(goalsData?.goals) ? goalsData.goals : [];
  const activeGoals = goals
    .filter(g => g.status && g.status !== 'abandoned' && g.status !== 'completed')
    .sort((a, b) => (b.priority === 'high' ? 1 : 0) - (a.priority === 'high' ? 1 : 0));
  const topGoalTitles = activeGoals.slice(0, useLength === 'blurb' ? 3 : 6).map(g => g.title).filter(Boolean);

  // ---- WHO I AM ----
  const whoLines = [];
  const idBits = [name, aliases ? `also known as ${aliases}` : null].filter(Boolean).join(', ');
  if (primaryMode || orientation) {
    whoLines.push(`${idBits}${primaryMode ? ` — ${primaryMode.toLowerCase()}` : ''}${orientation ? `. ${orientation}` : ''}.`);
  } else if (idBits && idBits !== 'the user') {
    whoLines.push(`${idBits}.`);
  }
  const corePurpose = extractSection(soul, 'Core Purpose');
  const purposeLead = corePurpose ? corePurpose.split('\n').map(l => l.trim()).find(l => l && !/^#/.test(l)) : null;
  if (purposeLead) whoLines.push(purposeLead);
  if (topValues) whoLines.push(`Core values: ${topValues}.`);
  const refuseTopic = pullEnrichmentAnswer(nonNegotiables, 'absolutely refuse');
  if (refuseTopic && useLength !== 'blurb') whoLines.push(`Will not engage with: ${refuseTopic}.`);
  if (topGoalTitles.length) whoLines.push(`Current goals: ${topGoalTitles.join('; ')}.`);

  // ---- HOW I SPEAK ----
  const howLines = [];
  const toneTarget = soul?.match(/Tone target:\s*\n>\s*(.+)/i)?.[1]?.trim();
  if (toneTarget) howLines.push(`Tone: ${stripTrailingPunct(toneTarget)}.`);
  const commPrefs = bulletsToPhrase(extractSection(soul, 'Communication Preferences'));
  if (commPrefs) howLines.push(`Style: ${commPrefs}.`);
  const feedbackPref = pullEnrichmentAnswer(communication, 'critical feedback');
  if (feedbackPref) howLines.push(`Prefers ${feedbackPref} feedback.`);
  const mbti = pullEnrichmentAnswer(personality, 'Myers-Briggs');
  if (mbti) howLines.push(`Personality type: ${mbti}.`);
  if (hasVoiceTraits) {
    const bits = [];
    const fw = formalityWord(comm.formality);
    const vw = verbosityWord(comm.verbosity);
    if (fw) bits.push(`${fw} formality (${comm.formality}/10)`);
    if (vw) bits.push(`${vw} verbosity (${comm.verbosity}/10)`);
    if (comm.avgSentenceLength) bits.push(`~${Math.round(comm.avgSentenceLength)}-word sentences`);
    if (bits.length) howLines.push(`Cadence: ${bits.join(', ')}.`);
    if (Array.isArray(comm.distinctiveMarkers) && comm.distinctiveMarkers.length) {
      howLines.push(`Verbal markers: ${comm.distinctiveMarkers.join('; ')}.`);
    }
  }
  // Humor lists "acceptable when" bullets then an "Avoid:" block — keep only the
  // positive half so the bio doesn't read as if slapstick IS the user's humor.
  const humorBlock = useLength !== 'blurb' ? extractSection(soul, 'Humor') : null;
  const humor = humorBlock ? bulletsToPhrase(humorBlock.split(/^avoid\b/im)[0]) : null;
  if (humor) howLines.push(`Humor: ${humor}.`);

  // ---- WHAT I KNOW ----
  const whatLines = [];
  const techDepth = bulletsToPhrase(extractSection(technical, 'Depth & Orientation'));
  const techPhilosophy = useLength === 'knowledge' ? bulletsToPhrase(extractSection(technical, 'Building Philosophy')) : null;
  if (techDepth) whatLines.push(`Technical: ${techDepth}.`);
  if (techPhilosophy) whatLines.push(`Building philosophy: ${techPhilosophy}.`);
  const creativeDna = bulletsToPhrase(extractSection(creative, 'Creative DNA'));
  if (creativeDna) whatLines.push(`Creative: ${creativeDna}.`);
  const reasoning = bulletsToPhrase(extractSection(cognitive, 'Reasoning Defaults'));
  if (reasoning) whatLines.push(`Reasoning: ${reasoning}.`);
  const epistemic = useLength === 'knowledge' ? bulletsToPhrase(extractSection(cognitive, 'Epistemic Style')) : null;
  if (epistemic) whatLines.push(`Epistemics: ${epistemic}.`);

  const sections = {
    whoIAm: whoLines.length ? whoLines.join('\n\n') : '_No identity data yet — add documents in the Enrich tab._',
    howISpeak: howLines.length ? howLines.join('\n\n') : '_No communication data yet — run the Voice or Personality tab._',
    whatIKnow: whatLines.length ? whatLines.join('\n\n') : '_No knowledge data yet — add Technical/Creative/Cognitive documents._',
  };

  const combined = [
    `# Live Avatar Bio — ${name}`,
    '',
    '## Who I Am',
    sections.whoIAm,
    '',
    '## How I Speak',
    sections.howISpeak,
    '',
    '## What I Know',
    sections.whatIKnow,
  ].join('\n');

  return {
    length: useLength,
    name,
    sections,
    combined,
    hasVoiceTraits,
    tokenEstimate: estimateTokens(combined),
  };
}

const LENGTH_GUIDANCE = {
  blurb: 'Keep it very tight — one short paragraph per section, suitable for a small persona field.',
  persona: 'Balanced length — 2–4 sentences per section, avatar-persona ready.',
  knowledge: 'Fuller detail per section — this feeds an avatar knowledge base, so more depth is welcome.',
};

/**
 * Refine the deterministic draft into first-person, avatar-ready prose via an
 * AI provider. Explicit user action only. Returns { content, tokenEstimate } or
 * { error, rawResponse } so the caller can surface an unparseable/failed run.
 */
export async function polishAvatarBio({ providerId, model, length = DEFAULT_AVATAR_BIO_LENGTH }) {
  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { error: 'Provider not found or disabled' };
  }

  const draft = await buildAvatarBio({ length });

  const prompt = [
    'You are helping a person create the persona description for a live conversational AI avatar of themselves.',
    'Rewrite the structured draft below into natural, first-person prose ("I am…", "I speak…", "I know…").',
    'Keep three clearly labeled sections: "Who I Am", "How I Speak", and "What I Know".',
    'Preserve every concrete fact from the draft. Do NOT invent biography, credentials, or details not present.',
    LENGTH_GUIDANCE[draft.length] || LENGTH_GUIDANCE.persona,
    'Output clean Markdown with a `## ` heading per section and no preamble.',
    '',
    '--- DRAFT ---',
    draft.combined,
    '--- END DRAFT ---',
  ].join('\n');

  const { text, error } = await callProviderAI(provider, model, prompt);
  if (error) return { error };

  const content = (text || '').trim();
  if (!content || !/who i am/i.test(content)) {
    return { error: 'The model response could not be parsed as an avatar bio', rawResponse: text || '' };
  }

  return {
    length: draft.length,
    name: draft.name,
    hasVoiceTraits: draft.hasVoiceTraits,
    content,
    tokenEstimate: estimateTokens(content),
  };
}
