/**
 * Taste Questionnaire Service
 *
 * Manages a conversational questionnaire for building an aesthetic taste profile.
 * Covers movies, music, visual art, architecture, and food preferences
 * with branching follow-up questions based on responses.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { resolveAPIProvider, callProviderAISimple } from '../lib/aiProvider.js';
import { buildPrompt } from './promptService.js';
import { digitalTwinEvents } from './digital-twin.js';

const DIGITAL_TWIN_DIR = PATHS.digitalTwin;
const TASTE_PROFILE_FILE = join(DIGITAL_TWIN_DIR, 'taste-profile.json');
const NO_API_PROVIDER_HINT = 'No API-based AI provider is configured. Open AI Providers (e.g. LM Studio, OpenAI, Anthropic) and add one — CLI providers like Claude Code can\'t run this analysis.';

function now() {
  return new Date().toISOString();
}

// =============================================================================
// QUESTION DEFINITIONS
// =============================================================================

// Each section has core questions and conditional follow-ups.
// Follow-ups trigger when a core answer matches certain keywords/conditions.
export const TASTE_SECTIONS = {
  movies: {
    label: 'Movies & Film',
    description: 'Your relationship with cinema — what resonates visually, emotionally, narratively',
    icon: 'Film',
    color: 'red',
    questions: [
      {
        id: 'movies-core-1',
        text: 'Name 3-5 films you consider near-perfect. What specifically makes each one resonate with you?',
        type: 'text',
        followUps: [
          {
            id: 'movies-fu-visual',
            trigger: 'visual|cinematography|shot|color|frame|aesthetic|look',
            text: 'You mentioned visual elements. Do you gravitate more toward naturalistic cinematography (handheld, available light) or highly stylized/composed frames? Any specific directors of photography whose work you love?'
          },
          {
            id: 'movies-fu-narrative',
            trigger: 'story|narrative|character|plot|writing|dialogue',
            text: 'You value narrative craft. Do you prefer tight, economical storytelling or sprawling, layered narratives? Are you drawn to ambiguity or resolution?'
          },
          {
            id: 'movies-fu-mood',
            trigger: 'mood|atmosphere|feeling|tone|vibe|haunting|intense',
            text: 'Atmosphere matters to you. Describe the ideal emotional texture of a film that really grabs you — dark and brooding? Electric and frenetic? Meditative and slow?'
          }
        ]
      },
      {
        id: 'movies-core-2',
        text: 'What genres or styles do you actively avoid in film, and why?',
        type: 'text',
        followUps: [
          {
            id: 'movies-fu-exception',
            trigger: 'except|but|unless|sometimes|one|though',
            text: 'It sounds like there are exceptions to your avoidance. What is it about those exceptions that overcomes your usual resistance?'
          }
        ]
      },
      {
        id: 'movies-core-3',
        text: 'Think about the last film that genuinely surprised you or changed how you see something. What was it and what shifted?',
        type: 'text',
        followUps: []
      }
    ]
  },
  music: {
    label: 'Music & Sound',
    description: 'How you use music — background, active listening, emotional regulation, cognitive tool',
    icon: 'Music',
    color: 'green',
    questions: [
      {
        id: 'music-core-1',
        text: 'Describe your music taste in terms of what it does for you functionally. What do you listen to when you need to focus? To energize? To decompress?',
        type: 'text',
        followUps: [
          {
            id: 'music-fu-focus',
            trigger: 'focus|concentrate|work|deep|flow|code|write',
            text: 'For focus music — do you need something without lyrics, or can you tune out vocals? Do you prefer repetitive/minimal textures or complex evolving soundscapes?'
          },
          {
            id: 'music-fu-energy',
            trigger: 'energy|pump|gym|run|workout|drive|hype',
            text: 'For energy music — is it the tempo that matters most, or the emotional intensity? Name a track that always delivers.'
          }
        ]
      },
      {
        id: 'music-core-2',
        text: 'What artists or albums have had a lasting impact on your musical identity? The ones you return to across years.',
        type: 'text',
        followUps: [
          {
            id: 'music-fu-era',
            trigger: 'teen|young|college|childhood|growing up|first|early',
            text: 'Formative music is powerful. Has your taste evolved significantly since then, or do those early influences still define your core preference?'
          }
        ]
      },
      {
        id: 'music-core-3',
        text: 'What sounds, instruments, or production styles do you find actively unpleasant or grating?',
        type: 'text',
        followUps: []
      }
    ]
  },
  visual_art: {
    label: 'Visual Art & Design',
    description: 'What you find beautiful, compelling, or worth staring at — from fine art to UI design',
    icon: 'Palette',
    color: 'violet',
    questions: [
      {
        id: 'visual-core-1',
        text: 'Minimalist or maximalist? Where do you fall on this spectrum and why? Think about the spaces, screens, and objects you surround yourself with.',
        type: 'text',
        followUps: [
          {
            id: 'visual-fu-minimal',
            trigger: 'minimal|clean|simple|less|sparse|white space|negative space',
            text: 'Within minimalism, there are flavors — Japanese wabi-sabi (imperfect, organic), Scandinavian (warm functional), or Swiss/Bauhaus (geometric precision). Which resonates most?'
          },
          {
            id: 'visual-fu-maximal',
            trigger: 'maximal|bold|busy|layer|complex|rich|ornate|detail',
            text: 'Within maximalism — are you drawn to controlled density (like intricate patterns or data-dense dashboards) or exuberant chaos (like street art or collage)?'
          }
        ]
      },
      {
        id: 'visual-core-2',
        text: 'What color palettes or color combinations make you feel something? Both ones you love and ones you find repulsive.',
        type: 'text',
        followUps: [
          {
            id: 'visual-fu-dark',
            trigger: 'dark|black|moody|shadow|contrast|neon',
            text: 'You lean toward darker palettes. Is this about drama/contrast, or about comfort/coziness? Do you prefer pure black backgrounds or very dark grays/blues?'
          },
          {
            id: 'visual-fu-warm',
            trigger: 'warm|earth|natural|wood|brown|amber|terracotta|sunset',
            text: 'You gravitate toward warm tones. Is there a natural material or environment that captures your ideal color world? Desert, forest, coastline?'
          }
        ]
      },
      {
        id: 'visual-core-3',
        text: 'Name a design movement, artist, or visual style that you feel genuinely represents your aesthetic sensibility.',
        type: 'text',
        followUps: []
      }
    ]
  },
  architecture: {
    label: 'Architecture & Spaces',
    description: 'The built environments that make you feel at home, inspired, or in awe',
    icon: 'Building',
    color: 'amber',
    questions: [
      {
        id: 'arch-core-1',
        text: 'Describe your ideal living space. Not what you can afford — what you would build if constraints didn\'t exist. Materials, light, layout, relationship to outdoors.',
        type: 'text',
        followUps: [
          {
            id: 'arch-fu-light',
            trigger: 'light|window|glass|sun|bright|open|natural light',
            text: 'Natural light is important to you. Do you prefer dramatic directional light (like a cathedral) or diffuse even illumination? Floor-to-ceiling glass or carefully placed apertures?'
          },
          {
            id: 'arch-fu-material',
            trigger: 'concrete|wood|steel|stone|brick|glass|material',
            text: 'You mentioned specific materials. Do you prefer raw/exposed materials (concrete, steel) or finished/refined surfaces? Is tactile quality important?'
          }
        ]
      },
      {
        id: 'arch-core-2',
        text: 'What architectural styles or environments make you uncomfortable or feel wrong? Think about spaces where you feel anxious, uninspired, or trapped.',
        type: 'text',
        followUps: []
      },
      {
        id: 'arch-core-3',
        text: 'Think about a building or space you visited that left a lasting impression. What was it and why did it affect you?',
        type: 'text',
        followUps: [
          {
            id: 'arch-fu-sacred',
            trigger: 'church|temple|museum|library|sacred|spiritual|awe',
            text: 'Sounds like you respond to spaces with a sense of reverence or gravity. Is this about scale, silence, age, or something else? Do secular spaces ever achieve this for you?'
          }
        ]
      }
    ]
  },
  food: {
    label: 'Food & Culinary',
    description: 'Your relationship with food — flavor profiles, cuisines, dining experiences, cooking philosophy',
    icon: 'UtensilsCrossed',
    color: 'orange',
    questions: [
      {
        id: 'food-core-1',
        text: 'What cuisines or flavor profiles do you find yourself craving most often? Be specific — not just "Italian" but what about it.',
        type: 'text',
        followUps: [
          {
            id: 'food-fu-spice',
            trigger: 'spic|heat|chili|pepper|hot|szechuan|thai|indian|capsaicin',
            text: 'You gravitate toward heat/spice. Is it about the endorphin rush, the complexity it adds, or the cultural context? Do you have a preferred type of heat (bright chili vs deep smoky)?'
          },
          {
            id: 'food-fu-umami',
            trigger: 'umami|savory|depth|ferment|miso|soy|mushroom|rich|broth',
            text: 'You appreciate deep savory flavors. Do you actively seek out fermented foods? How do you feel about acquired-taste ingredients like fish sauce, natto, or blue cheese?'
          }
        ]
      },
      {
        id: 'food-core-2',
        text: 'Do you cook? If so, describe your cooking style — improvisational or recipe-following, simple or ambitious, comfort food or experimental?',
        type: 'text',
        followUps: [
          {
            id: 'food-fu-improv',
            trigger: 'improv|experiment|invent|no recipe|freestyle|whatever|fridge',
            text: 'You cook intuitively. What are your go-to base ingredients or flavor building blocks that you always have on hand?'
          }
        ]
      },
      {
        id: 'food-core-3',
        text: 'Describe the ideal dining experience. Is it about the food quality, the setting, the company, the ritual? What matters most?',
        type: 'text',
        followUps: []
      }
    ]
  },
  fashion: {
    label: 'Fashion & Texture',
    description: 'Material preferences, tactile comfort, color wardrobe, style identity',
    icon: 'Shirt',
    color: 'pink',
    questions: [
      {
        id: 'fashion-core-1',
        text: 'What materials or fabrics do you gravitate toward? Think about what feels right against your skin, what you reach for instinctively — cotton, linen, wool, synthetics, leather?',
        type: 'text',
        followUps: [
          {
            id: 'fashion-fu-texture',
            trigger: 'texture|soft|rough|smooth|feel|tactile|touch|sensory',
            text: 'Tactile experience matters to you. Do you choose clothing primarily by how it feels, or is visual appearance more important? Are there textures you absolutely cannot tolerate?'
          },
          {
            id: 'fashion-fu-natural',
            trigger: 'natural|organic|linen|cotton|wool|silk|sustainable|eco',
            text: 'You lean toward natural materials. Is this about comfort, ethics, aesthetics, or all three? Do you actively avoid synthetics?'
          }
        ]
      },
      {
        id: 'fashion-core-2',
        text: 'Describe your color wardrobe — what colors dominate your closet? Where do you fall on the formality spectrum, from athleisure to tailored?',
        type: 'text',
        followUps: [
          {
            id: 'fashion-fu-minimal',
            trigger: 'minimalist|capsule|neutral|black|simple|uniform|same',
            text: 'You favor a minimalist wardrobe approach. Is this about decision fatigue, aesthetic conviction, or practicality? Do you have a signature look or uniform?'
          },
          {
            id: 'fashion-fu-color',
            trigger: 'color|bright|pattern|print|bold|statement|express',
            text: 'You use color expressively. Do you dress for mood, season, or self-expression? Are there colors you associate with specific feelings or identities?'
          }
        ]
      },
      {
        id: 'fashion-core-3',
        text: 'How would you describe your style identity? What fashion movements, eras, or anti-fashion positions resonate with you? What do you refuse to wear?',
        type: 'text',
        followUps: [
          {
            id: 'fashion-fu-vintage',
            trigger: 'vintage|retro|thrift|secondhand|era|classic|timeless',
            text: 'You connect with vintage or classic style. Is there a specific era that defines your aesthetic? Do you actively seek out vintage pieces, or is it more about the timeless quality?'
          }
        ]
      }
    ]
  },
  digital: {
    label: 'Digital & Interface',
    description: 'Dark/light mode, information density, tool aesthetics, digital environment preferences',
    icon: 'Monitor',
    color: 'cyan',
    questions: [
      {
        id: 'digital-core-1',
        text: 'Dark mode or light mode — and why? How do you feel about information density on screen? Do you prefer spacious layouts or packed dashboards? What about animations and transitions?',
        type: 'text',
        followUps: [
          {
            id: 'digital-fu-darkmode',
            trigger: 'dark mode|dark theme|dark|night|black background|oled',
            text: 'You prefer dark interfaces. Is it about eye comfort, aesthetics, or focus? Do you prefer true black (#000) or dark gray? How do you feel about pure white text on dark backgrounds vs softer contrast?'
          },
          {
            id: 'digital-fu-minimal',
            trigger: 'minimal|clean|simple|spacious|breathing room|whitespace',
            text: 'You value visual breathing room. Does this extend to your desktop, file organization, and browser tabs? Or is the preference purely about UI design?'
          },
          {
            id: 'digital-fu-dense',
            trigger: 'dense|packed|data|dashboard|information|everything visible|power user',
            text: 'You like information-dense interfaces. Is this about efficiency, control, or the satisfaction of seeing everything at once? Name a tool that gets information density right for you.'
          }
        ]
      },
      {
        id: 'digital-core-2',
        text: 'What software tools feel genuinely good to use — not just functional, but aesthetically satisfying? What makes them feel that way?',
        type: 'text',
        followUps: [
          {
            id: 'digital-fu-craft',
            trigger: 'craft|polish|attention to detail|animation|smooth|responsive|fast',
            text: 'You appreciate software craftsmanship. How much does performance (speed, responsiveness) factor into your aesthetic experience of software vs visual design alone?'
          },
          {
            id: 'digital-fu-cluttered',
            trigger: 'cluttered|bloated|heavy|slow|electron|ugly|hate',
            text: 'You have strong negative reactions to certain software aesthetics. Is it the visual clutter, the performance overhead, or the feeling of disrespect for your attention?'
          }
        ]
      },
      {
        id: 'digital-core-3',
        text: 'Describe your ideal notification and attention style. How do you manage digital interruptions? What does your ideal digital environment look like in terms of focus and distraction?',
        type: 'text',
        followUps: [
          {
            id: 'digital-fu-focus',
            trigger: 'focus|distraction|notification|dnd|do not disturb|quiet|silence|zen',
            text: 'You actively manage digital attention. Do you use specific tools or systems for this? Is your approach about discipline, environment design, or both?'
          }
        ]
      }
    ]
  }
};

// =============================================================================
// DATA ACCESS
// =============================================================================

let profileCache = null;

async function loadTasteProfile() {
  if (profileCache) return profileCache;

  if (!existsSync(TASTE_PROFILE_FILE)) {
    const defaultProfile = {
      version: '1.0.0',
      createdAt: null,
      updatedAt: null,
      sections: {},
      profileSummary: null,
      lastSessionAt: null
    };
    for (const sectionId of Object.keys(TASTE_SECTIONS)) {
      defaultProfile.sections[sectionId] = { status: 'pending', responses: [], summary: null };
    }
    await saveTasteProfile(defaultProfile);
    return defaultProfile;
  }

  const raw = await readFile(TASTE_PROFILE_FILE, 'utf-8');
  const defaultProfile = {
    version: '1.0.0',
    createdAt: null,
    updatedAt: null,
    sections: {},
    profileSummary: null,
    lastSessionAt: null
  };
  for (const sectionId of Object.keys(TASTE_SECTIONS)) {
    defaultProfile.sections[sectionId] = { status: 'pending', responses: [], summary: null };
  }
  profileCache = safeJSONParse(raw, defaultProfile);
  return profileCache;
}

async function saveTasteProfile(profile) {
  if (!existsSync(DIGITAL_TWIN_DIR)) {
    await ensureDir(DIGITAL_TWIN_DIR);
  }
  profile.updatedAt = now();
  await writeFile(TASTE_PROFILE_FILE, JSON.stringify(profile, null, 2));
  profileCache = profile;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get the full taste profile status — sections, progress, summary
 */
export async function getTasteProfile() {
  const profile = await loadTasteProfile();
  const sections = Object.entries(TASTE_SECTIONS).map(([id, config]) => {
    const sectionData = profile.sections[id] || { status: 'pending', responses: [], summary: null };
    const totalCoreQuestions = config.questions.length;
    const answeredCore = sectionData.responses.filter(r => r.questionId.includes('-core-')).length;
    const answeredFollowUps = sectionData.responses.filter(r => r.questionId.includes('-fu-')).length;

    return {
      id,
      label: config.label,
      description: config.description,
      icon: config.icon,
      color: config.color,
      status: sectionData.status,
      progress: {
        coreAnswered: answeredCore,
        coreTotal: totalCoreQuestions,
        followUpsAnswered: answeredFollowUps,
        percentage: totalCoreQuestions > 0 ? Math.round((answeredCore / totalCoreQuestions) * 100) : 0
      },
      summary: sectionData.summary
    };
  });

  const completedCount = sections.filter(s => s.status === 'completed').length;

  return {
    sections,
    completedCount,
    totalSections: sections.length,
    overallPercentage: Math.round((completedCount / sections.length) * 100),
    profileSummary: profile.profileSummary,
    lastSessionAt: profile.lastSessionAt
  };
}

/**
 * Get the next question for a section.
 * Returns core questions first, then triggered follow-ups based on previous answers.
 */
export async function getNextQuestion(sectionId) {
  const config = TASTE_SECTIONS[sectionId];
  if (!config) return null;

  const profile = await loadTasteProfile();
  const sectionData = profile.sections[sectionId] || { status: 'pending', responses: [], summary: null };
  const answeredIds = new Set(sectionData.responses.map(r => r.questionId));

  // First: serve unanswered core questions in order
  for (const q of config.questions) {
    if (!answeredIds.has(q.id)) {
      return {
        questionId: q.id,
        section: sectionId,
        sectionLabel: config.label,
        text: q.text,
        type: q.type,
        isFollowUp: false,
        progress: {
          current: sectionData.responses.length + 1,
          coreTotal: config.questions.length,
          totalAnswered: sectionData.responses.length
        }
      };
    }

    // Check for triggered follow-ups for this core question
    const coreResponse = sectionData.responses.find(r => r.questionId === q.id);
    if (!coreResponse) continue;

    for (const fu of q.followUps) {
      if (answeredIds.has(fu.id)) continue;
      const pattern = new RegExp(fu.trigger, 'i');
      if (pattern.test(coreResponse.answer)) {
        return {
          questionId: fu.id,
          section: sectionId,
          sectionLabel: config.label,
          text: fu.text,
          type: 'text',
          isFollowUp: true,
          triggeredBy: q.id,
          progress: {
            current: sectionData.responses.length + 1,
            coreTotal: config.questions.length,
            totalAnswered: sectionData.responses.length
          }
        };
      }
    }
  }

  // All questions answered for this section
  return null;
}

/**
 * Submit an answer for a taste question.
 */
export async function submitAnswer(sectionId, questionId, answer, { source, generatedQuestion, identityContextUsed } = {}) {
  const config = TASTE_SECTIONS[sectionId];
  if (!config) throw new Error(`Unknown taste section: ${sectionId}`);

  const profile = await loadTasteProfile();
  if (!profile.sections[sectionId]) {
    profile.sections[sectionId] = { status: 'pending', responses: [], summary: null };
  }

  // Prevent duplicate answers
  const existing = profile.sections[sectionId].responses.find(r => r.questionId === questionId);
  if (existing) {
    existing.answer = answer;
    existing.updatedAt = now();
    if (source) existing.source = source;
  } else {
    const responseEntry = {
      questionId,
      answer,
      answeredAt: now()
    };
    if (source) responseEntry.source = source;
    if (generatedQuestion) responseEntry.generatedQuestion = generatedQuestion;
    if (identityContextUsed) responseEntry.identityContextUsed = identityContextUsed;
    profile.sections[sectionId].responses.push(responseEntry);
  }

  if (!profile.createdAt) profile.createdAt = now();
  profile.lastSessionAt = now();

  // Update section status
  const answeredCoreIds = new Set(
    profile.sections[sectionId].responses
      .filter(r => r.questionId.includes('-core-'))
      .map(r => r.questionId)
  );
  const allCoreAnswered = config.questions.every(q => answeredCoreIds.has(q.id));

  if (allCoreAnswered) {
    // Check if all triggered follow-ups are also answered
    const next = await getNextQuestionInternal(sectionId, profile);
    profile.sections[sectionId].status = next ? 'in_progress' : 'completed';
  } else {
    profile.sections[sectionId].status = 'in_progress';
  }

  await saveTasteProfile(profile);

  // Also update the AESTHETICS.md document with the response
  await appendToAestheticsDoc(sectionId, config, questionId, answer);

  console.log(`🎨 Taste answer submitted: ${sectionId}/${questionId} (${profile.sections[sectionId].responses.length} responses)`);

  // Get the next question to return inline
  const nextQuestion = await getNextQuestion(sectionId);

  return {
    section: sectionId,
    questionId,
    sectionStatus: profile.sections[sectionId].status,
    totalResponses: profile.sections[sectionId].responses.length,
    nextQuestion
  };
}

/**
 * Internal version that operates on an already-loaded profile object
 */
function getNextQuestionInternal(sectionId, profile) {
  const config = TASTE_SECTIONS[sectionId];
  if (!config) return null;

  const sectionData = profile.sections[sectionId] || { status: 'pending', responses: [] };
  const answeredIds = new Set(sectionData.responses.map(r => r.questionId));

  for (const q of config.questions) {
    if (!answeredIds.has(q.id)) return q;

    const coreResponse = sectionData.responses.find(r => r.questionId === q.id);
    if (!coreResponse) continue;

    for (const fu of q.followUps) {
      if (answeredIds.has(fu.id)) continue;
      const pattern = new RegExp(fu.trigger, 'i');
      if (pattern.test(coreResponse.answer)) return fu;
    }
  }

  return null;
}

/**
 * Generate a taste profile summary for a section using AI.
 */
export async function generateSectionSummary(sectionId, providerId, model) {
  const config = TASTE_SECTIONS[sectionId];
  if (!config) throw new Error(`Unknown taste section: ${sectionId}`);

  const profile = await loadTasteProfile();
  const sectionData = profile.sections[sectionId];
  if (!sectionData?.responses?.length) {
    throw new Error(`No responses to summarize for section: ${sectionId}`);
  }

  const provider = await resolveAPIProvider(providerId);
  if (!provider) throw new Error(NO_API_PROVIDER_HINT);

  const modelId = model || provider.defaultModel;

  // Build Q&A transcript for analysis
  const transcript = sectionData.responses.map(r => {
    const qDef = findQuestionDef(sectionId, r.questionId);
    return `Q: ${qDef?.text || r.questionId}\nA: ${r.answer}`;
  }).join('\n\n');

  const prompt = `Analyze the following taste/preference interview responses about ${config.label} and produce a structured profile summary. Extract concrete preferences, patterns, anti-preferences, and aesthetic principles. Be specific — cite actual examples they mentioned.

## Interview Transcript

${transcript}

## Output Format

Respond with a concise profile in this exact structure:

### ${config.label} Profile

**Core Preferences:**
- [Specific preference 1]
- [Specific preference 2]
- ...

**Anti-Preferences (Actively Dislikes):**
- [What they avoid and why]

**Key Patterns:**
- [Recurring theme or principle]

**In Their Words:**
- [1-2 direct quotes that capture their taste]`;

  const result = await callProviderAISimple(provider, modelId, prompt, {
    temperature: 0.3,
    max_tokens: 1000,
    op: `taste-summary:${sectionId}`,
    opLabel: `Generating ${config.label} taste summary`
  });

  if (result.error) throw new Error(`AI analysis failed: ${result.error}`);

  const summary = result.text?.trim();
  if (!summary) throw new Error('AI returned empty summary');

  // Store the summary
  profile.sections[sectionId].summary = summary;
  await saveTasteProfile(profile);

  console.log(`🎨 Taste summary generated for ${sectionId}`);

  return { section: sectionId, summary };
}

/**
 * Generate an overall taste profile summary across all completed sections.
 */
export async function generateOverallSummary(providerId, model) {
  const profile = await loadTasteProfile();

  const completedSections = Object.entries(profile.sections)
    .filter(([, data]) => data.responses?.length > 0);

  if (completedSections.length === 0) {
    throw new Error('No taste responses to summarize. Complete at least one section first.');
  }

  const provider = await resolveAPIProvider(providerId);
  if (!provider) throw new Error(NO_API_PROVIDER_HINT);

  const modelId = model || provider.defaultModel;

  // Build combined transcript
  const allTranscripts = completedSections.map(([sectionId, data]) => {
    const config = TASTE_SECTIONS[sectionId];
    const transcript = data.responses.map(r => {
      const qDef = findQuestionDef(sectionId, r.questionId);
      return `Q: ${qDef?.text || r.questionId}\nA: ${r.answer}`;
    }).join('\n\n');
    return `## ${config.label}\n\n${transcript}`;
  }).join('\n\n---\n\n');

  const prompt = `Analyze the following taste/preference interview responses across multiple aesthetic domains and produce a unified taste profile. Identify cross-cutting themes, contradictions, and the person's core aesthetic identity.

${allTranscripts}

## Output Format

### Unified Taste Profile

**Aesthetic Identity (2-3 sentences):**
[A concise description of this person's overall aesthetic sensibility]

**Cross-Cutting Themes:**
- [Theme that appears across multiple domains]

**Core Aesthetic Principles:**
- [Fundamental principle 1]
- [Fundamental principle 2]

**Contradictions & Tensions:**
- [Any interesting tensions in their preferences]

**Summary Tags:**
[5-8 descriptive tags like: "brutalist minimalist", "atmospheric storyteller", "texture-obsessed", etc.]`;

  const result = await callProviderAISimple(provider, modelId, prompt, {
    temperature: 0.3,
    max_tokens: 1500,
    op: 'taste-summary:overall',
    opLabel: 'Generating unified taste profile'
  });

  if (result.error) throw new Error(`AI analysis failed: ${result.error}`);

  const summary = result.text?.trim();
  if (!summary) throw new Error('AI returned empty summary');

  profile.profileSummary = summary;
  await saveTasteProfile(profile);

  // Also write to AESTHETICS.md as the definitive profile
  await writeAestheticsDocument(summary, completedSections);

  digitalTwinEvents.emit('taste:profile-updated', { summary });
  console.log(`🎨 Overall taste profile generated`);

  return { summary };
}

/**
 * Get all responses for a section (for review/editing)
 */
export async function getSectionResponses(sectionId) {
  const config = TASTE_SECTIONS[sectionId];
  if (!config) throw new Error(`Unknown taste section: ${sectionId}`);

  const profile = await loadTasteProfile();
  const sectionData = profile.sections[sectionId] || { responses: [] };

  return sectionData.responses.map(r => {
    const qDef = findQuestionDef(sectionId, r.questionId);
    const isPersonalized = r.questionId.includes('-p25-') || r.source === 'personalized';
    return {
      questionId: r.questionId,
      questionText: isPersonalized ? (r.generatedQuestion || r.questionId) : (qDef?.text || r.questionId),
      answer: r.answer,
      isFollowUp: r.questionId.includes('-fu-'),
      isPersonalized,
      answeredAt: r.answeredAt
    };
  });
}

/**
 * Reset a section (clear all responses)
 */
export async function resetSection(sectionId) {
  const profile = await loadTasteProfile();
  if (profile.sections[sectionId]) {
    profile.sections[sectionId] = { status: 'pending', responses: [], summary: null };
    await saveTasteProfile(profile);
    console.log(`🎨 Taste section reset: ${sectionId}`);
  }
  return { section: sectionId, status: 'reset' };
}

// =============================================================================
// PERSONALIZED QUESTION GENERATION
// =============================================================================

const IDENTITY_DOCS = ['BOOKS.md', 'AUDIO.md', 'CREATIVE.md', 'PREFERENCES.md', 'PERSONALITY.md'];
const MAX_CONTEXT_CHARS = 4000;

/**
 * Aggregate identity context from digital twin documents for personalized prompting.
 */
async function aggregateIdentityContext(sectionId) {
  const contextParts = [];
  const sourcesUsed = [];

  // Read identity documents (first ~2000 chars each)
  for (const docName of IDENTITY_DOCS) {
    const docPath = join(DIGITAL_TWIN_DIR, docName);
    if (!existsSync(docPath)) continue;
    const content = await readFile(docPath, 'utf-8');
    if (content.trim().length > 0) {
      contextParts.push(`## ${docName}\n${content.slice(0, 2000)}`);
      sourcesUsed.push(docName);
    }
  }

  // Read enrichment answers from meta.json
  const metaPath = join(DIGITAL_TWIN_DIR, 'meta.json');
  if (existsSync(metaPath)) {
    const metaRaw = await readFile(metaPath, 'utf-8');
    const meta = safeJSONParse(metaRaw, {});
    if (meta.enrichment?.questionsAnswered) {
      const enrichmentSummary = Object.entries(meta.enrichment.questionsAnswered)
        .filter(([, count]) => count > 0)
        .map(([cat, count]) => `${cat}: ${count} answers`)
        .join(', ');
      if (enrichmentSummary) {
        contextParts.push(`## Enrichment Progress\n${enrichmentSummary}`);
        sourcesUsed.push('enrichment');
      }
    }
  }

  // Read existing taste responses from other completed sections
  const profile = await loadTasteProfile();
  for (const [sid, sectionData] of Object.entries(profile.sections)) {
    if (sid === sectionId || !sectionData.responses?.length) continue;
    const config = TASTE_SECTIONS[sid];
    if (!config) continue;
    const excerpt = sectionData.responses.slice(0, 3).map(r => {
      const qDef = findQuestionDef(sid, r.questionId);
      return `Q: ${qDef?.text || r.questionId}\nA: ${r.answer.slice(0, 300)}`;
    }).join('\n\n');
    if (excerpt) {
      contextParts.push(`## Taste: ${config.label}\n${excerpt}`);
      sourcesUsed.push(`taste:${sid}`);
    }
  }

  if (contextParts.length === 0) return { context: '', sourcesUsed: [] };

  // Truncate combined context to max length
  let combined = contextParts.join('\n\n---\n\n');
  if (combined.length > MAX_CONTEXT_CHARS) {
    combined = combined.slice(0, MAX_CONTEXT_CHARS) + '\n\n[...truncated]';
  }

  return { context: combined, sourcesUsed };
}

/**
 * Generate a personalized follow-up question for a taste section using LLM.
 */
export async function generatePersonalizedTasteQuestion(sectionId, providerId, model) {
  const config = TASTE_SECTIONS[sectionId];
  if (!config) return null;

  const { context, sourcesUsed } = await aggregateIdentityContext(sectionId);
  if (!context) return null;

  const provider = await resolveAPIProvider(providerId);
  if (!provider) return null;

  const modelId = model || provider.defaultModel;

  // Build existing responses transcript
  const profile = await loadTasteProfile();
  const sectionData = profile.sections[sectionId] || { responses: [] };
  const transcript = sectionData.responses.map(r => {
    const qDef = findQuestionDef(sectionId, r.questionId);
    return `Q: ${qDef?.text || r.questionId}\nA: ${r.answer}`;
  }).join('\n\n');

  const prompt = `You are a thoughtful interviewer building an aesthetic taste profile for someone. You already know a lot about this person from their identity documents and previous responses. Your job is to ask ONE follow-up question about "${config.label}" that:

1. References something specific from their identity context (a book they read, music they like, a personality trait, a preference)
2. Connects it to the ${config.label} domain in a surprising or insightful way
3. Feels conversational and curious, not clinical or formulaic
4. Goes deeper than generic taste questions — probe the "why" behind their preferences

## Identity Context
${context}

## Previous ${config.label} Responses
${transcript || '(No responses yet for this section)'}

## Instructions
Generate exactly ONE question. Do not include any preamble, numbering, or explanation. Just the question text itself. Keep it under 150 words. Make it feel like a question from someone who genuinely knows and is curious about this person.`;

  const result = await callProviderAISimple(provider, modelId, prompt, {
    temperature: 0.8,
    max_tokens: 200,
    op: `taste-deep-question:${sectionId}`,
    opLabel: `Crafting a deeper ${config.label} question`
  });

  if (result.error || !result.text?.trim()) {
    console.log(`🎨 Personalized question generation failed for ${sectionId}: ${result.error || 'empty response'}`);
    return null;
  }

  const questionId = `${sectionId}-p25-${uuidv4()}`;
  console.log(`🎨 Personalized question generated for ${sectionId} (${sourcesUsed.length} sources)`);

  return {
    questionId,
    text: result.text.trim(),
    isPersonalized: true,
    identityContextUsed: sourcesUsed,
    section: sectionId,
    sectionLabel: config.label
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function findQuestionDef(sectionId, questionId) {
  const config = TASTE_SECTIONS[sectionId];
  if (!config) return null;

  for (const q of config.questions) {
    if (q.id === questionId) return q;
    for (const fu of q.followUps) {
      if (fu.id === questionId) return fu;
    }
  }
  return null;
}

async function appendToAestheticsDoc(sectionId, config, questionId, answer) {
  const targetPath = join(DIGITAL_TWIN_DIR, 'AESTHETICS.md');
  let content = '';

  if (existsSync(targetPath)) {
    content = await readFile(targetPath, 'utf-8');
  } else {
    content = '# Aesthetic Preferences\n\n';
  }

  const qDef = findQuestionDef(sectionId, questionId);
  const questionText = qDef?.text || questionId;
  const sectionHeader = `## ${config.label}`;

  // Add section header if not present
  if (!content.includes(sectionHeader)) {
    content += `\n${sectionHeader}\n\n`;
  }

  // Append the Q&A
  const entry = `### ${questionText}\n\n${answer}\n\n`;

  // Insert after the section header
  const headerIdx = content.indexOf(sectionHeader);
  const afterHeader = headerIdx + sectionHeader.length;
  const nextSection = content.indexOf('\n## ', afterHeader + 1);

  if (nextSection > -1) {
    content = content.slice(0, nextSection) + entry + content.slice(nextSection);
  } else {
    content += entry;
  }

  await writeFile(targetPath, content);
}

async function writeAestheticsDocument(profileSummary, completedSections) {
  const targetPath = join(DIGITAL_TWIN_DIR, 'AESTHETICS.md');

  let content = '# Aesthetic Preferences\n\n';
  content += '## Taste Profile Summary\n\n';
  content += profileSummary + '\n\n';
  content += '---\n\n';
  content += '## Detailed Responses\n\n';

  for (const [sectionId, data] of completedSections) {
    const config = TASTE_SECTIONS[sectionId];
    content += `### ${config.label}\n\n`;

    for (const r of data.responses) {
      const qDef = findQuestionDef(sectionId, r.questionId);
      content += `**Q: ${qDef?.text || r.questionId}**\n\n`;
      content += `${r.answer}\n\n`;
    }
  }

  await writeFile(targetPath, content);
}
