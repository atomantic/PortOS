// Pure, deterministic mapping from live system state → ambient soundscape parameters
// (CyberCity v2 roadmap 3.4). The synth-music layer reads these to shift its mood, brightness,
// and "energy" so the city's drone reflects what's actually happening: a healthy, quiet system
// sounds calm and bright; a stressed system (high CPU/mem, health warnings) darkens and tenses;
// active agents add rhythmic energy (a louder arp voice). No Web Audio / React imports so the
// mapping is unit-testable — citySynthMusic.js applies the result to the live graph.

// Two chord tables the music engine switches between. BRIGHT is the existing major-leaning
// progression (calm/healthy); TENSE is a darker, more dissonant set used when the system is
// under stress. Frequencies are bass roots + chord tones in Hz, matching citySynthMusic's shape.
export const CHORD_SETS = {
  bright: [
    [110, 130.81, 164.81],   // Am
    [82.41, 123.47, 164.81], // Em
    [87.31, 110, 130.81],    // F
    [65.41, 98.0, 130.81],   // C
  ],
  tense: [
    [110, 138.59, 164.81],   // A diminished-ish (A, C#dim color)
    [77.78, 116.54, 155.56], // Eb — tritone-ish tension
    [92.50, 116.54, 138.59], // F#m color
    [69.30, 103.83, 138.59], // C# — unresolved
  ],
};

// Classify overall system stress into a mood. Driven primarily by the health verdict, with a
// CPU/memory fallback so a system that's hammered but not yet "warning" still tenses up.
// `health` is the /system/health/details payload (or null); `agentCount` is live agents.
export function classifyMood(health) {
  const verdict = health?.overallHealth;
  if (verdict === 'critical' || verdict === 'unhealthy') return 'tense';
  const cpu = health?.system?.cpu?.usagePercent ?? 0;
  const mem = health?.system?.memory?.usagePercent ?? 0;
  if (cpu >= 85 || mem >= 90) return 'tense';
  if (verdict === 'degraded' || cpu >= 65 || mem >= 75) return 'neutral';
  return 'bright';
}

// Energy 0..1 — how much rhythmic "life" the music has. Rises with the number of active agents
// (the city is busy → the music gets busier), saturating so a swarm of agents doesn't blow it
// out. A quiet, agent-less city sits at a low ambient floor, never fully silent.
export function computeActivityEnergy(agentCount) {
  const n = Math.max(0, agentCount || 0);
  // Diminishing returns: 0 agents → 0.15 floor, ~5 agents → ~0.85, asymptotic to 1.
  return Math.min(1, 0.15 + (1 - Math.exp(-n / 2.5)) * 0.85);
}

// Full soundscape view-model the music engine applies. `mood` picks the chord table and a base
// filter brightness; `energy` scales the arp/lead voice gain and a subtle tempo feel; `detune`
// widens the pads as tension rises for an uneasy shimmer. Deterministic for a given snapshot.
export function computeSoundscape(snapshot = {}) {
  const { systemHealth, agentCount } = snapshot;
  const mood = classifyMood(systemHealth);
  const energy = computeActivityEnergy(agentCount);

  // Brighter (higher) filter cutoff when healthy; clamped low when tense for a muffled, anxious
  // tone. Energy nudges it up a touch so a busy-but-healthy city sparkles.
  const filterBase = (mood === 'bright' ? 320 : mood === 'neutral' ? 220 : 150) + energy * 80;

  return {
    mood,
    energy,
    chordSet: mood === 'tense' ? 'tense' : 'bright', // neutral still uses the bright table, just darker filter
    filterBase,
    arpGain: 0.02 + energy * 0.08, // near-silent at rest, prominent when many agents run
    padDetune: mood === 'tense' ? 14 : mood === 'neutral' ? 10 : 8, // wider = more unease
    // A gentle tempo feel: the arp envelope opens a little faster with energy. Expressed as a
    // 0..1 scalar the engine maps onto its arp attack, NOT a literal BPM change (rescheduling
    // the running intervals mid-stream would race; modulating the voice is equivalent + safe).
    pulse: energy,
  };
}
