import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import PromptEditor from './PromptEditor';

afterEach(cleanup);

describe('PromptEditor', () => {
  it('explains that hook-owned prompts are generated per run', () => {
    render(
      <PromptEditor
        config={{
          promptMode: 'runtime-generated',
          promptDescription: 'Generated from fresh forge activity.'
        }}
        promptValue=""
        setPromptValue={() => {}}
        editingPrompt={false}
        setEditingPrompt={() => {}}
        handleSavePrompt={() => {}}
        updating={false}
        activeApps={[]}
      />
    );

    expect(screen.getByText('Generated at run time')).toBeInTheDocument();
    expect(screen.getByText('Generated from fresh forge activity.')).toBeInTheDocument();
    expect(screen.getByText(/no stored prompt template to edit/i)).toBeInTheDocument();
    expect(screen.queryByText('No prompt configured')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('PromptEditor — programmatic tasks', () => {
  it('offers no prompt at all for work PortOS performs itself', () => {
    // Distinct from 'runtime-generated': there is no agent and no prompt, so
    // offering to show or edit one would describe execution that never happens.
    render(
      <PromptEditor
        config={{
          promptMode: 'programmatic',
          promptDescription: 'PortOS enqueues the renders itself.'
        }}
        promptValue=""
        setPromptValue={() => {}}
        editingPrompt={false}
        setEditingPrompt={() => {}}
        handleSavePrompt={() => {}}
        updating={false}
        activeApps={[]}
      />
    );

    expect(screen.getByText('No prompt — PortOS runs this itself')).toBeInTheDocument();
    expect(screen.getByText('PortOS enqueues the renders itself.')).toBeInTheDocument();
    expect(screen.queryByText('Generated at run time')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});
