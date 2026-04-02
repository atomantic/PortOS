// Enrichment category configurations
export const ENRICHMENT_CATEGORIES = {
  core_memories: {
    label: 'Core Memories',
    description: 'Formative experiences that shaped your identity',
    targetDoc: 'MEMORIES.md',
    targetCategory: 'enrichment',
    questions: [
      'What childhood memory still influences how you approach problems today?',
      'Describe a pivotal moment that changed your worldview.',
      'What failure taught you the most important lesson?'
    ]
  },
  favorite_books: {
    label: 'Favorite Books',
    description: 'Books that shaped your thinking',
    targetDoc: 'BOOKS.md',
    targetCategory: 'entertainment',
    listBased: true,
    itemLabel: 'Book',
    itemPlaceholder: 'e.g., Gödel, Escher, Bach by Douglas Hofstadter',
    notePlaceholder: 'Why this book matters to you, what it taught you...',
    analyzePrompt: 'Analyze these book choices to understand the reader\'s intellectual interests, values, and worldview.',
    questions: [
      'What book fundamentally changed how you see the world?',
      'Which book do you find yourself re-reading or recommending most?',
      'What fiction shaped your values or aspirations?'
    ]
  },
  favorite_movies: {
    label: 'Favorite Movies',
    description: 'Films that resonate with your aesthetic and values',
    targetDoc: 'MOVIES.md',
    targetCategory: 'entertainment',
    listBased: true,
    itemLabel: 'Movie',
    itemPlaceholder: 'e.g., Blade Runner 2049',
    notePlaceholder: 'What draws you to this film, memorable scenes or themes...',
    analyzePrompt: 'Analyze these film choices to understand the person\'s aesthetic preferences, emotional resonance patterns, and values.',
    questions: [
      'What film captures your aesthetic sensibility?',
      'Which movie do you quote or reference most often?',
      'What film made you think differently about a topic?'
    ]
  },
  music_taste: {
    label: 'Music Taste',
    description: 'Music as cognitive infrastructure',
    targetDoc: 'MUSIC.md',
    targetCategory: 'audio',
    listBased: true,
    itemLabel: 'Album/Artist',
    itemPlaceholder: 'e.g., OK Computer by Radiohead',
    notePlaceholder: 'When you listen to this, how you use it (focus, energy, mood)...',
    analyzePrompt: 'Analyze these music choices to understand how this person uses music for cognitive and emotional regulation.',
    questions: [
      'What album do you use for deep focus work?',
      'What music captures your emotional baseline?',
      'Describe your relationship with music - is it background or active engagement?'
    ]
  },
  communication: {
    label: 'Communication Style',
    description: 'How you prefer to give and receive information',
    targetDoc: 'COMMUNICATION.md',
    targetCategory: 'social',
    questions: [
      'How do you prefer to receive critical feedback?',
      'Do you prefer direct confrontation or diplomatic approach in disagreements?',
      'What communication style irritates you most?'
    ]
  },
  decision_making: {
    label: 'Decision Making',
    description: 'How you approach choices and uncertainty',
    targetDoc: 'PREFERENCES.md',
    targetCategory: 'core',
    questions: [
      'Do you decide quickly with limited info, or deliberate extensively?',
      'How do you handle irreversible decisions differently from reversible ones?',
      'What role does intuition play in your decision-making?'
    ]
  },
  values: {
    label: 'Values',
    description: 'Core principles that guide your actions',
    targetDoc: 'VALUES.md',
    targetCategory: 'core',
    questions: [
      'What are the top three values that guide your most important decisions?',
      'What value do you wish more people held?',
      'Where do you draw the line between pragmatism and principle?'
    ]
  },
  aesthetics: {
    label: 'Aesthetic Preferences',
    description: 'Visual and design sensibilities',
    targetDoc: 'AESTHETICS.md',
    targetCategory: 'creative',
    questions: [
      'Minimalist or maximalist - where do you fall?',
      'What visual style or design movement resonates with you?',
      'How important is aesthetic coherence in your work environment?'
    ]
  },
  daily_routines: {
    label: 'Daily Routines',
    description: 'Habits and rhythms that structure your day',
    targetDoc: 'ROUTINES.md',
    targetCategory: 'lifestyle',
    questions: [
      'Are you a morning person or night owl, and how does this affect your work?',
      'What daily ritual is non-negotiable for your productivity?',
      'How do you recharge - solitude, social, physical activity?'
    ]
  },
  career_skills: {
    label: 'Career & Skills',
    description: 'Professional expertise and growth areas',
    targetDoc: 'CAREER.md',
    targetCategory: 'professional',
    questions: [
      'What are you known for professionally?',
      'What skill are you actively trying to develop?',
      'What unique perspective does your background give you?'
    ]
  },
  non_negotiables: {
    label: 'Non-Negotiables',
    description: 'Principles and boundaries that define your limits',
    targetDoc: 'NON_NEGOTIABLES.md',
    targetCategory: 'core',
    questions: [
      'What principle would you never compromise, even at significant personal cost?',
      'What behavior in others immediately erodes your trust?',
      'What topic should your digital twin absolutely refuse to engage with?'
    ]
  },
  decision_heuristics: {
    label: 'Decision Heuristics',
    description: 'Mental models and shortcuts for making choices',
    targetDoc: 'DECISION_HEURISTICS.md',
    targetCategory: 'core',
    questions: [
      'When facing a decision with limited information, do you act quickly or wait for more data?',
      'How do you weigh reversible vs irreversible decisions differently?',
      'What role does optionality play in your decision-making?'
    ]
  },
  error_intolerance: {
    label: 'Error Intolerance',
    description: 'What your digital twin should never do',
    targetDoc: 'ERROR_INTOLERANCE.md',
    targetCategory: 'core',
    questions: [
      'What communication style or reasoning pattern irritates you most?',
      'What should your digital twin never do when responding to you?',
      'What type of "help" actually makes things worse for you?'
    ]
  },
  personality_assessments: {
    label: 'Personality Assessments',
    description: 'Personality type results from assessments like Myers-Briggs, Big Five, DISC, Enneagram, etc.',
    targetDoc: 'PERSONALITY.md',
    targetCategory: 'core',
    questions: [
      'What is your Myers-Briggs type (e.g., INTJ, ENFP)? If you test differently at different times, list all results.',
      'If you know your Big Five (OCEAN) scores, what are they? High/low on Openness, Conscientiousness, Extraversion, Agreeableness, Neuroticism?',
      'Have you taken other personality assessments (Enneagram, DISC, StrengthsFinder, etc.)? Share those results.'
    ]
  }
};

// Scale questions for Likert-based trait scoring (1-5)
export const SCALE_QUESTIONS = [
  // Big Five — Openness (2 items)
  { id: 'bf-o-1', text: 'I enjoy exploring new ideas and unconventional perspectives.', category: 'personality_assessments', dimension: 'openness', trait: 'O', traitPath: 'bigFive.O', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-o-2', text: 'I prefer familiar routines over trying something new.', category: 'personality_assessments', dimension: 'openness', trait: 'O', traitPath: 'bigFive.O', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Big Five — Conscientiousness (2 items)
  { id: 'bf-c-1', text: 'I keep a detailed plan and follow through on commitments.', category: 'personality_assessments', dimension: 'conscientiousness', trait: 'C', traitPath: 'bigFive.C', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-c-2', text: 'I tend to leave things unfinished or improvise instead of planning.', category: 'personality_assessments', dimension: 'conscientiousness', trait: 'C', traitPath: 'bigFive.C', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Big Five — Extraversion (2 items)
  { id: 'bf-e-1', text: 'I feel energized after spending time with a group of people.', category: 'personality_assessments', dimension: 'extraversion', trait: 'E', traitPath: 'bigFive.E', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-e-2', text: 'I prefer solitary activities over social gatherings.', category: 'personality_assessments', dimension: 'extraversion', trait: 'E', traitPath: 'bigFive.E', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Big Five — Agreeableness (2 items)
  { id: 'bf-a-1', text: 'I go out of my way to help others, even at personal cost.', category: 'personality_assessments', dimension: 'agreeableness', trait: 'A', traitPath: 'bigFive.A', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-a-2', text: 'I prioritize my own goals over group harmony.', category: 'personality_assessments', dimension: 'agreeableness', trait: 'A', traitPath: 'bigFive.A', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Big Five — Neuroticism (2 items)
  { id: 'bf-n-1', text: 'I frequently worry about things that might go wrong.', category: 'personality_assessments', dimension: 'neuroticism', trait: 'N', traitPath: 'bigFive.N', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'bf-n-2', text: 'I stay calm and composed under pressure.', category: 'personality_assessments', dimension: 'neuroticism', trait: 'N', traitPath: 'bigFive.N', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Communication — formality + verbosity (2 items)
  { id: 'comm-f', text: 'I prefer formal, structured language over casual speech.', category: 'communication', dimension: 'communication', trait: 'formality', traitPath: 'communicationProfile.formality', direction: 1, labels: ['Very Casual', 'Casual', 'Balanced', 'Formal', 'Very Formal'] },
  { id: 'comm-v', text: 'I prefer thorough, detailed explanations over brief answers.', category: 'communication', dimension: 'communication', trait: 'verbosity', traitPath: 'communicationProfile.verbosity', direction: 1, labels: ['Very Terse', 'Brief', 'Balanced', 'Detailed', 'Very Elaborate'] },
  // Daily routines — conscientiousness proxy (2 items)
  { id: 'rout-1', text: 'My day follows a consistent structure and set of rituals.', category: 'daily_routines', dimension: 'conscientiousness', trait: 'C', traitPath: 'bigFive.C', direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'rout-2', text: 'I adapt my schedule spontaneously based on how I feel.', category: 'daily_routines', dimension: 'conscientiousness', trait: 'C', traitPath: 'bigFive.C', direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Values (2 items)
  { id: 'val-1', text: 'I would sacrifice personal gain to uphold a principle.', category: 'values', dimension: 'values', trait: 'values', traitPath: null, direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'val-2', text: 'Pragmatism matters more to me than idealism.', category: 'values', dimension: 'values', trait: 'values', traitPath: null, direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  // Decision heuristics (2 items)
  { id: 'dec-1', text: 'I make decisions quickly with available information rather than waiting.', category: 'decision_heuristics', dimension: 'decision_making', trait: 'decision_making', traitPath: null, direction: 1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] },
  { id: 'dec-2', text: 'I prefer to gather extensive data before committing to a choice.', category: 'decision_heuristics', dimension: 'decision_making', trait: 'decision_making', traitPath: null, direction: -1, labels: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'] }
];

export const SCALE_WEIGHT = 0.3;
export const CONFIDENCE_BOOST = 0.15;
