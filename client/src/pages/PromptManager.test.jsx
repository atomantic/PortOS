import { describe, it, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import {
  api, renderPage, currentSearch, currentPathname, promptTab, STAGES,
} from '../test/promptManagerPageMocks.jsx';
import { canonicalPromptsUrl } from '../components/prompts/promptTabs';

// The page shell: header, the routed tab bar, the legacy-URL redirect and the
// tab-switch discard guard. Each editor's own behavior lives beside it in
// components/prompts/*.test.jsx.

// The page hosts SettingsTabsHeader; before #5653 it also hand-rolled a
// `Settings` title bar above it, so every render stacked two h1s and pushed the
// first prompt group off a phone viewport.
describe('PromptManager page header', () => {
  it('renders exactly one h1, naming the page rather than the settings section', async () => {
    await renderPage();

    await screen.findByLabelText('Search prompt stages');
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveAccessibleName('Prompt Manager');
  });
});

// The tab is a route segment (#16384); `?tab=` links from before the move —
// bookmarks, other installs, palette history — must still land on their tab
// with the open record intact.
describe('PromptManager tab routes', () => {
  beforeEach(() => {
    api.getPromptVariables.mockResolvedValue({ variables: { x: { name: 'Example', category: 'rules', content: 'body' } } });
    api.getJobSkills.mockReset().mockResolvedValue({ skills: [{ name: 'code-fixer', jobId: 'job-code-fixer' }] });
    api.getJobSkill.mockReset().mockResolvedValue({ content: '# t', jobName: 'Job code-fixer', jobId: 'job-code-fixer' });
  });

  it('lands a legacy ?tab= link on the tab route, keeping the open record', async () => {
    await renderPage('/prompts?tab=variables&var=x');

    await screen.findByDisplayValue('body');
    expect(currentPathname()).toBe('/prompts/variables');
    expect(currentSearch()).toBe('?var=x');
    expect(promptTab(/variables/i).getAttribute('aria-selected')).toBe('true');
  });

  it('lands a legacy job-skills link on its route', async () => {
    await renderPage('/prompts?tab=job-skills&skill=code-fixer');

    await screen.findByText('Job code-fixer', { selector: 'h3' });
    expect(currentPathname()).toBe('/prompts/job-skills');
    expect(currentSearch()).toBe('?skill=code-fixer');
  });

  it('sends bare /prompts to the Stages tab, keeping a deep-linked stage', async () => {
    api.getPrompt.mockReset().mockResolvedValue({ name: 'Brain Classifier', template: 'body', variables: [] });
    await renderPage('/prompts?stage=brain-classifier');

    await screen.findByText('Brain Classifier', { selector: 'h3' });
    expect(currentPathname()).toBe('/prompts/stages');
    expect(currentSearch()).toBe('?stage=brain-classifier');
  });

  it('sends an unknown tab to Stages instead of rendering nothing', async () => {
    await renderPage('/prompts/nonsense');

    await screen.findByLabelText('Search prompt stages');
    expect(currentPathname()).toBe('/prompts/stages');
  });

  it('switches tabs through the route, carrying each tab\'s open record', async () => {
    await renderPage('/prompts/stages');
    await screen.findByLabelText('Search prompt stages');

    fireEvent.click(promptTab(/variables/i));
    await screen.findByText('Example');
    expect(currentPathname()).toBe('/prompts/variables');
    expect(screen.queryByLabelText('Search prompt stages')).toBeNull();
  });

  it('builds canonical URLs for every legacy and partial shape', () => {
    expect(canonicalPromptsUrl('variables', '?var=x')).toBeNull();
    expect(canonicalPromptsUrl(undefined, '?tab=variables&var=x')).toBe('/prompts/variables?var=x');
    expect(canonicalPromptsUrl(undefined, '?tab=bogus&stage=s')).toBe('/prompts/stages?stage=s');
    expect(canonicalPromptsUrl(undefined, '')).toBe('/prompts/stages');
    expect(canonicalPromptsUrl('bogus', '?tab=job-skills', '#h')).toBe('/prompts/job-skills#h');
    // A valid path tab wins over a stray query tab, which is then dropped.
    expect(canonicalPromptsUrl('stages', '?tab=variables&stage=s')).toBe('/prompts/stages?stage=s');
  });
});

// Each editor owns its state and unmounts when its tab closes, so leaving a
// tab with unsaved edits would silently throw them away. The same inline
// discard question that guards a record switch guards a tab switch.
describe('PromptManager tab-switch unsaved-edit guard', () => {
  beforeEach(() => {
    api.getPrompt.mockReset().mockImplementation((name) => Promise.resolve({
      name: STAGES[name]?.name || name, template: `${name} template`, variables: [],
    }));
    api.getPromptVariables.mockResolvedValue({ variables: { x: { name: 'Example', category: 'rules', content: 'body' } } });
  });

  const openDirtyStage = async () => {
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    await screen.findByDisplayValue('pipeline-prose-draft template');
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'edited by hand' } });
    await screen.findByText('Unsaved changes');
  };

  it('asks before another tab replaces a dirty editor', async () => {
    await openDirtyStage();

    fireEvent.click(promptTab(/variables/i));

    expect(screen.getByText('Discard unsaved changes to "Pipeline — Prose Draft" and open Variables?')).toBeTruthy();
    expect(currentPathname()).toBe('/prompts/stages');
    expect(screen.getByDisplayValue('edited by hand')).toBeTruthy();
  });

  it('keeps the edits when the tab switch is cancelled', async () => {
    await openDirtyStage();
    fireEvent.click(promptTab(/variables/i));

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    expect(currentPathname()).toBe('/prompts/stages');
    expect(screen.getByDisplayValue('edited by hand')).toBeTruthy();
  });

  it('switches tab once the discard is confirmed', async () => {
    await openDirtyStage();
    fireEvent.click(promptTab(/variables/i));

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await screen.findByText('Example');
    expect(currentPathname()).toBe('/prompts/variables');
    expect(currentSearch()).toContain('stage=pipeline-prose-draft');
  });

  it('drops the question when the edit is undone back to the saved text', async () => {
    await openDirtyStage();
    fireEvent.click(promptTab(/variables/i));

    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'pipeline-prose-draft template' } });

    await waitFor(() => expect(screen.queryByText(/Discard unsaved changes/)).toBeNull());
  });

  it('guards an unsaved variable draft the same way', async () => {
    await renderPage('/prompts/variables');
    await screen.findByText('Example');
    fireEvent.change(screen.getByPlaceholderText('Variable content...'), { target: { value: 'draft' } });

    fireEvent.click(promptTab(/stages/i));

    expect(screen.getByText('Discard unsaved changes to "New Variable" and open Stages?')).toBeTruthy();
    expect(currentPathname()).toBe('/prompts/variables');
  });

  it('does not ask when a clean editor switches tabs', async () => {
    await renderPage('/prompts/stages?stage=pipeline-prose-draft');
    await screen.findByDisplayValue('pipeline-prose-draft template');

    fireEvent.click(promptTab(/variables/i));

    expect(screen.queryByText(/Discard unsaved changes/)).toBeNull();
    await screen.findByText('Example');
    expect(currentPathname()).toBe('/prompts/variables');
  });
});
