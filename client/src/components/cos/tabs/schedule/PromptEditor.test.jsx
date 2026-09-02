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
