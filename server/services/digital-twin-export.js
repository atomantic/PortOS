import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getStories } from './autobiography.js';
import { getGenomeSummary } from './genome.js';
import { getTasteProfile } from './taste-questionnaire.js';
import { getChronotype, getLongevity, getGoals } from './identity.js';
import { getAllAccounts as getAllSocialAccounts } from './socialAccounts.js';
import { DIGITAL_TWIN_DIR, now } from './digital-twin-helpers.js';
import { loadMeta } from './digital-twin-meta.js';
import { getTraits } from './digital-twin-analysis.js';

export function getExportFormats() {
  return [
    { id: 'system_prompt', label: 'System Prompt', description: 'Combined markdown for direct injection' },
    { id: 'claude_md', label: 'CLAUDE.md', description: 'Format for Claude Code integration' },
    { id: 'json', label: 'JSON', description: 'Structured JSON for API integration' },
    { id: 'individual', label: 'Individual Files', description: 'Separate files for each document' },
    { id: 'legacy_portrait', label: 'Legacy Portrait', description: 'Comprehensive human-readable identity document' }
  ];
}

export async function exportDigitalTwin(format, documentIds = null, includeDisabled = false) {
  const meta = await loadMeta();
  let docs = meta.documents;

  // Filter by IDs if provided
  if (documentIds) {
    docs = docs.filter(d => documentIds.includes(d.id));
  }

  // Filter disabled unless explicitly included
  if (!includeDisabled) {
    docs = docs.filter(d => d.enabled);
  }

  // Exclude behavioral test suite from exports
  docs = docs.filter(d => d.category !== 'behavioral');

  // Sort by priority
  docs.sort((a, b) => a.priority - b.priority);

  // Load content for each document
  const documentsWithContent = [];
  for (const doc of docs) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      documentsWithContent.push({ ...doc, content });
    }
  }

  switch (format) {
    case 'system_prompt':
      return exportAsSystemPrompt(documentsWithContent);
    case 'claude_md':
      return exportAsClaudeMd(documentsWithContent);
    case 'json':
      return exportAsJson(documentsWithContent);
    case 'individual':
      return exportAsIndividual(documentsWithContent);
    case 'legacy_portrait':
      return exportAsLegacyPortrait(documentsWithContent);
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

function exportAsSystemPrompt(docs) {
  let output = '# User Identity & Persona (Soul)\n\n';
  output += 'The following describes the identity, values, and preferences of the user you are assisting. ';
  output += 'Use this context to align your responses with their communication style, values, and goals.\n\n';
  output += '---\n\n';

  for (const doc of docs) {
    output += doc.content + '\n\n---\n\n';
  }

  return {
    format: 'system_prompt',
    content: output.trim(),
    documentCount: docs.length,
    tokenEstimate: Math.ceil(output.length / 4)
  };
}

function exportAsClaudeMd(docs) {
  let output = '# Soul - User Identity\n\n';
  output += '> This section defines the identity, values, and preferences of the user.\n\n';

  for (const doc of docs) {
    // Remove the main header from each doc to avoid duplication
    const content = doc.content.replace(/^#\s+.+\n+/, '');
    output += `## ${doc.title}\n\n${content}\n\n`;
  }

  return {
    format: 'claude_md',
    content: output.trim(),
    documentCount: docs.length,
    tokenEstimate: Math.ceil(output.length / 4)
  };
}

function exportAsJson(docs) {
  const structured = {
    version: '1.0.0',
    exportedAt: now(),
    documents: docs.map(doc => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      content: doc.content
    })),
    metadata: {
      totalDocuments: docs.length,
      categories: [...new Set(docs.map(d => d.category))]
    }
  };

  const jsonString = JSON.stringify(structured, null, 2);

  return {
    format: 'json',
    content: jsonString,
    documentCount: docs.length,
    tokenEstimate: Math.ceil(jsonString.length / 4)
  };
}

function exportAsIndividual(docs) {
  return {
    format: 'individual',
    files: docs.map(doc => ({
      filename: doc.filename,
      title: doc.title,
      category: doc.category,
      content: doc.content
    })),
    documentCount: docs.length,
    tokenEstimate: docs.reduce((sum, d) => sum + Math.ceil(d.content.length / 4), 0)
  };
}

async function exportAsLegacyPortrait(docs) {
  // Gather data from all identity domains in parallel
  const [stories, genomeSummary, tasteProfile, chronotype, longevity, goalsData, socialAccounts, traits] = await Promise.all([
    getStories().catch(() => []),
    getGenomeSummary().catch(() => ({ uploaded: false })),
    getTasteProfile().catch(() => ({ sections: [] })),
    getChronotype().catch(() => null),
    getLongevity().catch(() => null),
    getGoals().catch(() => ({ goals: [] })),
    getAllSocialAccounts().catch(() => []),
    getTraits()
  ]);

  const sections = [];
  const exportDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  sections.push(`# Legacy Portrait\n\n*Exported ${exportDate}*\n\nThis document is a comprehensive portrait of identity, values, knowledge, and life story — preserved as a human-readable record.\n`);

  // --- Digital Twin Documents ---
  if (docs.length > 0) {
    sections.push('---\n\n## Identity & Values\n');
    for (const doc of docs) {
      sections.push(doc.content);
    }
  }

  // --- Personality Traits ---
  if (traits?.dimensions) {
    sections.push('---\n\n## Personality Traits\n');
    const dims = traits.dimensions;
    const traitLines = Object.entries(dims)
      .filter(([, v]) => v?.score != null)
      .map(([key, v]) => `- **${formatTraitName(key)}**: ${v.score}/100${v.label ? ` (${v.label})` : ''}`);
    if (traitLines.length > 0) {
      sections.push(traitLines.join('\n'));
    }
    if (traits.summary) {
      sections.push(`\n${traits.summary}`);
    }
  }

  // --- Chronotype ---
  if (chronotype?.type) {
    sections.push('---\n\n## Chronotype\n');
    sections.push(`**Type**: ${chronotype.type}${chronotype.confidence ? ` (${Math.round(chronotype.confidence * 100)}% confidence)` : ''}`);
    if (chronotype.schedule) {
      const s = chronotype.schedule;
      sections.push(`- Wake: ${s.wakeTime || 'unknown'} | Sleep: ${s.sleepTime || 'unknown'}`);
      if (s.peakFocusStart && s.peakFocusEnd) {
        sections.push(`- Peak focus: ${s.peakFocusStart}–${s.peakFocusEnd}`);
      }
    }
  }

  // --- Taste Profile ---
  const completedSections = (tasteProfile.sections || tasteProfile)?.filter?.(s => s.status === 'complete') || [];
  if (completedSections.length > 0) {
    sections.push('---\n\n## Taste Profile\n');
    for (const section of completedSections) {
      sections.push(`### ${section.label}\n`);
      if (section.summary) {
        sections.push(section.summary);
      }
    }
  }

  // --- Genome ---
  if (genomeSummary?.uploaded) {
    sections.push('---\n\n## Genome\n');
    const lines = [`- **SNPs analyzed**: ${genomeSummary.snpCount?.toLocaleString() || 'unknown'}`];
    if (genomeSummary.markerCount) lines.push(`- **Markers tracked**: ${genomeSummary.markerCount}`);
    if (genomeSummary.statusCounts) {
      const c = genomeSummary.statusCounts;
      lines.push(`- Beneficial: ${c.beneficial || 0} | Typical: ${c.typical || 0} | Concern: ${c.concern || 0}`);
    }
    sections.push(lines.join('\n'));
  }

  // --- Longevity ---
  if (longevity?.estimatedLifeExpectancy) {
    sections.push('---\n\n## Longevity\n');
    sections.push(`- **Estimated life expectancy**: ${longevity.estimatedLifeExpectancy} years`);
    if (longevity.baselineLifeExpectancy) {
      sections.push(`- **Baseline**: ${longevity.baselineLifeExpectancy} years`);
    }
  }

  // --- Goals ---
  const goals = goalsData?.goals || [];
  if (goals.length > 0) {
    sections.push('---\n\n## Life Goals\n');
    const activeGoals = goals.filter(g => g.status !== 'abandoned');
    for (const goal of activeGoals) {
      const status = goal.status === 'completed' ? ' [completed]' : goal.progress ? ` (${goal.progress}%)` : '';
      sections.push(`- **${goal.title}**${status}${goal.description ? `: ${goal.description}` : ''}`);
    }
  }

  // --- Autobiography ---
  if (stories.length > 0) {
    sections.push('---\n\n## Life Stories\n');
    // Sort by theme, then chronologically
    const sortedStories = [...stories].sort((a, b) => (a.themeId || '').localeCompare(b.themeId || '') || new Date(a.createdAt) - new Date(b.createdAt));
    let currentTheme = null;
    for (const story of sortedStories) {
      if (story.themeId !== currentTheme) {
        currentTheme = story.themeId;
        const themeLabel = currentTheme ? currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1).replace(/_/g, ' ') : 'Miscellaneous';
        sections.push(`\n### ${themeLabel}\n`);
      }
      if (story.prompt) sections.push(`> *${story.prompt}*\n`);
      sections.push(story.content);
    }
  }

  // --- Social Presence ---
  if (socialAccounts.length > 0) {
    sections.push('---\n\n## Social Presence\n');
    for (const account of socialAccounts) {
      const url = account.url ? ` — ${account.url}` : '';
      sections.push(`- **${account.platform || account.name}**: ${account.username || account.handle || '(linked)'}${url}`);
    }
  }

  sections.push('\n---\n\n*This portrait was generated by PortOS as a durable record of identity, knowledge, and life story.*');

  const content = sections.join('\n\n');

  return {
    format: 'legacy_portrait',
    content,
    documentCount: docs.length,
    storyCount: stories.length,
    goalCount: goals.length,
    tokenEstimate: Math.ceil(content.length / 4)
  };
}

function formatTraitName(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
}

export const exportSoul = exportDigitalTwin; // Alias for backwards compatibility
