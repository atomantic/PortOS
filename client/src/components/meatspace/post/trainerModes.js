// Mode tables for the POST trainers that PostTab loads lazily (Morse, Rhetoric,
// Memory practice, Elements Song). They live outside the trainer modules so the
// route switch (URL mode validation) and the Practice Library catalog can read
// them without pulling a trainer's code into the POST route chunk. The trainers
// import their own list from here; there is no second copy.
//
// server/lib/navManifest.test.js reads the `id:` values of these exported
// rhetoric and elements arrays to check their routed `:mode` deep links.
// Morse routes read the shared IDs directly.
import {
  BookOpen, ChevronRight, EyeOff, Feather, GitBranch, Hand, Headphones, Layers,
  Lightbulb, List as ListIcon, Repeat2, Ruler, Target, Timer, Zap,
} from 'lucide-react';
import { MORSE_MODE_IDS } from '../../../../../server/lib/morseModes.js';

export const RHETORIC_MODES = [
  {
    id: 'meter', label: 'Iambic Pentameter', icon: Timer, color: 'text-cyan-400', bgColor: 'bg-cyan-500/20',
    description: 'Write a ten-syllable line with a rising da-DUM pulse.',
    example: 'The rain returns to silver every street.',
    prompts: [
      'Write a line about an empty train station.',
      'Write a line that turns from doubt to hope.',
      'Write a line containing the word “winter”.',
      'Write a line spoken by someone keeping a secret.',
      'Write a line that ends on a strong one-syllable noun.',
    ],
    checklist: ['about ten syllables', 'mostly iambic (da-DUM) feet', 'a clear image or thought'],
  },
  {
    id: 'diacope', label: 'Diacope', icon: Feather, color: 'text-amber-400', bgColor: 'bg-amber-500/20',
    description: 'Make emphasis through repetition separated by a word or phrase.',
    example: 'Run, for the door is closing. Run!',
    prompts: [
      'Write a warning using “stay”.',
      'Write a plea using “listen”.',
      'Write a defiant line using “no”.',
      'Write a comic line using “again”.',
      'Write a sentence where the repeated word changes meaning.',
    ],
    checklist: ['the repeated word is exact or intentionally varied', 'a meaningful gap separates the repetitions', 'the repetition adds urgency or emphasis'],
  },
  {
    id: 'chiasmus', label: 'Chiasmus', icon: Repeat2, color: 'text-rose-400', bgColor: 'bg-rose-500/20',
    description: 'Cross a phrase’s terms or structure so the second half mirrors the first in reverse.',
    example: 'We shape our tools, and thereafter our tools shape us.',
    prompts: [
      'Write a line about learning that reverses its key terms.',
      'Turn a choice between freedom and safety into a crossed sentence.',
      'Write a compact chiasmus about listening and speaking.',
      'Use a reversal to show a friendship changing over time.',
      'Write a comic chiasmus about making plans and plans making trouble.',
    ],
    checklist: ['two paired terms or structures appear in reverse order', 'the reversal changes or sharpens the thought', 'the syntax stays clear when read aloud'],
  },
  {
    id: 'progressia', label: 'Progressia', icon: ChevronRight, color: 'text-purple-400', bgColor: 'bg-purple-500/20',
    description: 'Build an idea step by step until the final phrase lands harder.',
    example: 'A spark became a flame, a flame became a signal.',
    prompts: [
      'Escalate a whisper into a public alarm.',
      'Build a three-step progression from want to need to obsession.',
      'Turn a small kindness into a changed life.',
      'Escalate a disagreement without using the word “anger”.',
      'Build from a single drop of water to a flood.',
    ],
    checklist: ['at least three discernible steps', 'each step intensifies or transforms the last', 'the final step feels earned'],
  },
  {
    id: 'brainstorm', label: 'Rhetorical Brainstorm', icon: Lightbulb, color: 'text-green-400', bgColor: 'bg-green-500/20',
    description: 'Generate several angles quickly, then choose the one with voltage.',
    example: 'One subject, three stances: praise it, attack it, confess about it.',
    prompts: [
      'Brainstorm three openings for a story about a locked room.',
      'Argue for, against, and sideways about convenience.',
      'Find three metaphors for a difficult conversation.',
      'Write three headlines for the same surprising event.',
      'Describe one ordinary object as sacred, dangerous, and ridiculous.',
    ],
    checklist: ['at least three distinct attempts', 'the angles are genuinely different', 'one version takes an unexpected turn'],
  },
];

export const MEMORY_PRACTICE_MODES = [
  { id: 'learn', label: 'Learn', desc: 'Progressive reveal — read and absorb line by line' },
  { id: 'fill-blank', label: 'Fill in the Blank', desc: 'Fill missing words in partially shown lines' },
  { id: 'sequence', label: 'Sequence Recall', desc: 'Given a line, type what comes next' },
  { id: 'speed-run', label: 'Speed Run', desc: 'Recite the full sequence as fast as possible' },
  { id: 'spaced', label: 'Spaced Repetition', desc: 'Focus on your weakest chunks with graduated hints' },
];

// The routable practice modes (`/post/memory/:itemId/:mode`). PostTab validates
// the URL segment against this list and degrades an unknown one to the picker
// (issue #3249).
export const MEMORY_PRACTICE_MODE_IDS = MEMORY_PRACTICE_MODES.map((m) => m.id);

export const ELEMENTS_PRACTICE_MODES = [
  { id: 'learn', label: 'Learn Lyrics', icon: BookOpen, desc: 'Read through the song verse by verse' },
  // Study (flip-to-reveal) before the recall test, mirroring the study→test
  // split of Morse (copy vs head-copy) and MemoryPractice (learn vs recall).
  { id: 'element-study', label: 'Flash Cards', icon: Layers, desc: 'Study element name ↔ symbol pairings' },
  { id: 'element-flash', label: 'Element Flash', icon: Zap, desc: 'Name elements from symbols or vice versa' },
  { id: 'fill-blank', label: 'Fill the Lyrics', icon: Target, desc: 'Fill in missing element names from the lyrics' },
];

// The routable practice modes (`/post/memory/elements/:mode`); an unknown
// segment degrades to the mode picker.
export const ELEMENTS_MODE_IDS = ELEMENTS_PRACTICE_MODES.map((m) => m.id);

// Mode ids map to the `morse-<id>` drill types, so the blurb lives once in
// DRILL_DESCRIPTIONS (constants.js) and MorseTrainer reads it from there.
const MORSE_MODE_PRESENTATION = {
  copy: {
    label: 'Copy',
    icon: Headphones,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20',
    example: 'Koch progression: K, M → add letters as you hit 90%',
  },
  'head-copy': {
    label: 'Head Copy',
    icon: EyeOff,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20',
    example: 'Same Koch pool, pure recall — nothing to look at',
  },
  send: {
    label: 'Send',
    icon: Hand,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
    example: 'Tap short for ·, hold long for —',
  },
};

export const MORSE_MODES = MORSE_MODE_IDS.map((id) => ({ id, ...MORSE_MODE_PRESENTATION[id] }));
export { MORSE_MODE_IDS };

// The `?ref=` reference charts beside the Morse drill.
export const MORSE_REFERENCE_VIEWS = [
  { id: 'tree', label: 'Tree', icon: GitBranch },
  { id: 'length', label: 'Length', icon: Ruler },
  { id: 'list', label: 'List', icon: ListIcon },
];
