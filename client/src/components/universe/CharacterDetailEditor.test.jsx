import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import CharacterDetailEditor from './CharacterDetailEditor';
import { MemoryRouter, useLocation } from 'react-router';

const render = (ui, options) => rtlRender(ui, { wrapper: MemoryRouter, ...options });

// Mock VoicePicker — it pulls in the voice API/socket layer the relationship
// tests don't care about.
vi.mock('../voice/VoicePicker', () => ({ default: () => null }));
vi.mock('../../services/apiVoice', () => ({
  listVoiceEngines: vi.fn().mockResolvedValue({ engines: [] }),
  listVoiceProfiles: vi.fn(),
  promoteVoicePreset: vi.fn(),
  renderVoiceProfileBenchmark: vi.fn(),
  createVoiceDesignCandidate: vi.fn(),
  createClonedVoiceCandidate: vi.fn(),
  promoteVoiceProfile: vi.fn(),
  benchmarkProfileInteractive: vi.fn(),
  startFineTuningJob: vi.fn(),
}));

import {
  listVoiceEngines,
  listVoiceProfiles,
  promoteVoicePreset,
  createVoiceDesignCandidate,
  benchmarkProfileInteractive,
} from '../../services/apiVoice';

const ARIA = { id: 'chr-aria', name: 'Aria' };
const BRAM = { id: 'chr-bram', name: 'Bram' };
const CASS = { id: 'chr-cass', name: 'Cass' };

// Story groups relationships, secrets, framework, and psychology on one sheet page.
const openRelationships = () => {
  fireEvent.click(screen.getByRole('tab', { name: 'Story' }));
};

describe('CharacterDetailEditor — Relationships (#1287)', () => {
  it('prompts to add more cast when there are no other characters', () => {
    render(<CharacterDetailEditor entry={ARIA} characters={[ARIA]} onPatch={() => {}} />);
    openRelationships();
    expect(screen.getByText(/Add another character to the cast/i)).toBeInTheDocument();
  });

  it('adds a link defaulting to the first other character + custom type', () => {
    const onPatch = vi.fn();
    render(<CharacterDetailEditor entry={ARIA} characters={[ARIA, BRAM, CASS]} onPatch={onPatch} />);
    openRelationships();
    fireEvent.click(screen.getByRole('button', { name: /Add relationship/i }));
    expect(onPatch).toHaveBeenCalledWith({
      relationshipLinks: [{ targetCharacterId: 'chr-bram', type: 'custom', description: '' }],
    });
  });

  it('renders an existing link with target + type selects', () => {
    const entry = {
      ...ARIA,
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-bram', type: 'ally' }],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA, BRAM]} onPatch={() => {}} />);
    openRelationships();
    const target = screen.getByRole('combobox', { name: /relationship 1 target character/i });
    expect(target).toHaveValue('chr-bram');
    const type = screen.getByRole('combobox', { name: /relationship 1 type/i });
    expect(type).toHaveValue('ally');
  });

  it('patches the type when the type select changes', () => {
    const onPatch = vi.fn();
    const entry = {
      ...ARIA,
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-bram', type: 'ally' }],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA, BRAM]} onPatch={onPatch} />);
    openRelationships();
    fireEvent.change(screen.getByRole('combobox', { name: /relationship 1 type/i }), {
      target: { value: 'rival' },
    });
    expect(onPatch).toHaveBeenCalledWith({
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-bram', type: 'rival' }],
    });
  });

  it('tags an opposing force, surfacing the axis editor', () => {
    const onPatch = vi.fn();
    const entry = {
      ...ARIA,
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-bram', type: 'antagonist' }],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA, BRAM]} onPatch={onPatch} />);
    openRelationships();
    fireEvent.click(screen.getByRole('button', { name: /Tag opposing force/i }));
    expect(onPatch).toHaveBeenCalledWith({
      relationshipLinks: [{
        id: 'rel-1',
        targetCharacterId: 'chr-bram',
        type: 'antagonist',
        opposition: { axis: 'custom', thisRole: '', targetRole: '', note: '' },
      }],
    });
  });

  it('keeps an existing link removable even when there is no other cast', () => {
    // Target was deleted, leaving Aria the only character. The link must still
    // render (with a delete button) instead of being hidden behind the
    // add-more-cast prompt — otherwise the dangling-target check flags a
    // problem the UI won't let the user fix.
    const onPatch = vi.fn();
    const entry = {
      ...ARIA,
      relationshipLinks: [{ id: 'rel-1', targetCharacterId: 'chr-deleted', type: 'rival' }],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    openRelationships();
    // Dangling target is surfaced as a "(missing: …)" option.
    expect(screen.getByText(/missing: chr-deleted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove relationship 1/i }));
    expect(onPatch).toHaveBeenCalledWith({ relationshipLinks: [] });
  });

  it('shows the opposition count in the collapsed summary', () => {
    const entry = {
      ...ARIA,
      relationshipLinks: [
        { id: 'rel-1', targetCharacterId: 'chr-bram', opposition: { axis: 'hunter/prey' } },
        { id: 'rel-2', targetCharacterId: 'chr-cass' },
      ],
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA, BRAM, CASS]} onPatch={() => {}} />);
    openRelationships();
    expect(screen.getByText(/2 links · 1 opposing/i)).toBeInTheDocument();
  });
});

describe('CharacterDetailEditor — character framework (#2175)', () => {
  const openArc = () => expect(screen.getByRole('heading', { name: /Arc type & sliders/i })).toBeInTheDocument();

  it('renders the arc-type select seeded from the entry and patches on change', () => {
    const onPatch = vi.fn();
    render(<CharacterDetailEditor entry={{ ...ARIA, arcType: 'positive' }} characters={[ARIA]} onPatch={onPatch} />);
    openArc();
    const select = screen.getByRole('combobox', { name: /^Arc type$/i });
    expect(select).toHaveValue('positive');
    fireEvent.change(select, { target: { value: 'negative' } });
    expect(onPatch).toHaveBeenCalledWith({ arcType: 'negative' });
  });

  it('patches a slider value, merging with existing sliders', () => {
    const onPatch = vi.fn();
    const entry = { ...ARIA, sliders: { proactivity: 8, likability: null, competence: null } };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    openArc();
    fireEvent.change(screen.getByLabelText(/likability rating 1 to 10/i), { target: { value: '6' } });
    expect(onPatch).toHaveBeenCalledWith({ sliders: { proactivity: 8, likability: 6, competence: null } });
  });

  it('clears a set slider back to unset (null)', () => {
    const onPatch = vi.fn();
    const entry = { ...ARIA, sliders: { proactivity: 9, likability: null, competence: null } };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    openArc();
    fireEvent.click(screen.getByRole('button', { name: /Clear proactivity/i }));
    expect(onPatch).toHaveBeenCalledWith({ sliders: { proactivity: null, likability: null, competence: null } });
  });

  it('marshals the secrets string list to/from row objects', () => {
    const onPatch = vi.fn();
    const entry = { ...ARIA, secrets: ['forged the charter'] };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Story' }));
    // Existing secret is rendered in its row input.
    const input = screen.getByDisplayValue('forged the charter');
    fireEvent.change(input, { target: { value: 'forged the charter and the seal' } });
    fireEvent.blur(input);
    // Commits back as a plain string[] (not row objects).
    expect(onPatch).toHaveBeenCalledWith({ secrets: ['forged the charter and the seal'] });
  });

  it('exposes the Ghost→Wound→Lie→Want→Need prose fields', () => {
    render(<CharacterDetailEditor entry={{ ...ARIA, lie: 'I only matter if I win' }} characters={[ARIA]} onPatch={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Story' }));
    expect(screen.getByDisplayValue('I only matter if I win')).toBeInTheDocument();
  });
});

describe('CharacterDetailEditor — production package (#5378)', () => {
  it('keeps the empty local-profile state distinct and promotes a portable preset locally', async () => {
    listVoiceEngines.mockResolvedValue({ engines: [] });
    listVoiceProfiles.mockResolvedValue({ profiles: [] });
    promoteVoicePreset.mockResolvedValueOnce({
      profile: {
        id: 'voice-profile-1', version: 1, voiceId: 'kokoro:af_heart', modelRevision: 'kokoro-test:q8',
        delivery: { rate: 1 }, approval: { status: 'approved' }, benchmark: null,
      },
    });
    render(<CharacterDetailEditor
      entry={{ ...ARIA, voiceId: 'kokoro:af_heart' }} universeId="uni-1" characters={[ARIA]} onPatch={() => {}}
    />);
    fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
    expect(await screen.findByText(/Promote the selected Kokoro or Piper preset/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Promote selected preset/i }));
    await waitFor(() => expect(promoteVoicePreset).toHaveBeenCalledWith({
      universeId: 'uni-1', characterId: 'chr-aria', characterName: 'Aria', voiceId: 'kokoro:af_heart',
    }, { silent: true }));
    expect(await screen.findByRole('button', { name: /Re-promote selected preset/i })).toBeInTheDocument();
  });

  it('plays persisted local benchmark renders through the voice-profile asset mount', async () => {
    listVoiceEngines.mockResolvedValue({ engines: [] });
    listVoiceProfiles.mockResolvedValue({
      profiles: [{
        id: 'voice-profile-1', version: 1, voiceId: 'kokoro:af_heart', modelRevision: 'kokoro-test:q8',
        delivery: { rate: 1 }, approval: { status: 'approved' },
        benchmark: { lines: [{ key: 'identity', filename: 'voice-profiles/voice-profile-1/benchmarks/v1/01-identity.wav' }] },
      }],
    });
    render(<CharacterDetailEditor
      entry={{ ...ARIA, voiceId: 'kokoro:af_heart' }} universeId="uni-1" characters={[ARIA]} onPatch={() => {}}
    />);
    fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
    expect(await screen.findByLabelText(/Voice benchmark identity/i)).toHaveAttribute(
      'src', '/data/voice-profiles/voice-profile-1/benchmarks/v1/01-identity.wav',
    );
  });

  it('generates a voice design candidate via Voice Lab', async () => {
    listVoiceEngines.mockResolvedValue({ engines: [] });
    listVoiceProfiles.mockResolvedValue({ profiles: [] });
    createVoiceDesignCandidate.mockResolvedValueOnce({
      profile: {
        id: 'voice-profile-des-1', version: 1, kind: 'designed', engine: 'qwen3-tts',
        approval: { status: 'draft' },
      },
    });

    render(<CharacterDetailEditor
      entry={ARIA} universeId="uni-1" characters={[ARIA]} onPatch={() => {}}
    />);
    fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));

    // Switch to Design tab
    fireEvent.click(screen.getByRole('button', { name: /Design/i }));
    fireEvent.change(screen.getByPlaceholderText(/warm low alto/i), {
      target: { value: 'calm, measured alto' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Design Candidate Voice/i }));

    await waitFor(() => expect(createVoiceDesignCandidate).toHaveBeenCalledWith({
      universeId: 'uni-1',
      characterId: 'chr-aria',
      characterName: 'Aria',
      instructions: 'calm, measured alto',
      seed: 42,
      rate: 1,
    }, { silent: true }));
  });

  it('gates consented voice cloning on explicit performer consent confirmation', async () => {
    listVoiceEngines.mockResolvedValue({ engines: [] });
    listVoiceProfiles.mockResolvedValue({ profiles: [] });

    render(<CharacterDetailEditor
      entry={ARIA} universeId="uni-1" characters={[ARIA]} onPatch={() => {}}
    />);
    fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
    expect(await screen.findByText(/Machine-local voice design/i)).toBeInTheDocument();

    // Switch to Clone tab
    fireEvent.click(screen.getByRole('button', { name: /Clone/i }));
    const cloneBtn = screen.getByRole('button', { name: /Create Cloned Candidate/i });
    expect(cloneBtn).toBeDisabled();

    // Check consent box
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm the performer consented/i }));
    // Still disabled because no file is selected yet
    expect(cloneBtn).toBeDisabled();
  });

  it('qualifies interactive route via host latency benchmark', async () => {
    listVoiceEngines.mockResolvedValue({ engines: [] });
    listVoiceProfiles.mockResolvedValue({
      profiles: [{
        id: 'voice-profile-1', version: 1, voiceId: 'qwen3:test', modelRevision: 'qwen3-1.7b',
        delivery: { rate: 1 }, approval: { status: 'approved' },
        routes: { studio: { enabled: true }, interactive: { enabled: false, maxFirstAudioMs: 900 } },
      }],
    });
    benchmarkProfileInteractive.mockResolvedValueOnce({
      profile: {
        id: 'voice-profile-1', version: 1, approval: { status: 'approved' },
        routes: { studio: { enabled: true }, interactive: { enabled: true, maxFirstAudioMs: 900 } },
        benchmark: { interactiveLatencyMs: 120 },
      },
    });

    render(<CharacterDetailEditor
      entry={ARIA} universeId="uni-1" characters={[ARIA]} onPatch={() => {}}
    />);
    fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
    fireEvent.click(await screen.findByRole('button', { name: /Qualify interactive route/i }));

    await waitFor(() => expect(benchmarkProfileInteractive).toHaveBeenCalledWith(
      'voice-profile-1', { maxFirstAudioMs: 900 }, { silent: true },
    ));
  });

  it('marks a voice-canon revision as approved', () => {
    const onPatch = vi.fn();
    render(<CharacterDetailEditor entry={ARIA} characters={[ARIA]} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Candidate revision/i }));
    expect(onPatch).toHaveBeenCalledWith({
      voiceCanon: { version: 1, approved: true },
    });
  });

  it('adds an identity reference as a candidate and surfaces missing required roles', () => {
    const onPatch = vi.fn();
    render(<CharacterDetailEditor entry={{ ...ARIA, imageRefs: ['neutral.png'] }} characters={[ARIA]} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByText(/Missing: neutral, profile, full-body/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add reference/i }));
    expect(onPatch).toHaveBeenCalledWith({
      identityPack: { assets: [{ imageRef: 'neutral.png', role: 'neutral', approved: false }] },
    });
  });

  it('revokes approval when an approved voice revision changes', () => {
    const onPatch = vi.fn();
    render(<CharacterDetailEditor entry={{
      ...ARIA,
      voiceCanon: { version: 2, description: 'measured', approved: true },
    }} characters={[ARIA]} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
    const description = screen.getByRole('textbox', { name: /voice canon description/i });
    fireEvent.change(description, { target: { value: 'more urgent' } });
    fireEvent.blur(description);
    expect(onPatch).toHaveBeenCalledWith({
      voiceCanon: { version: 2, description: 'more urgent', approved: false },
    });
  });

  it('returns a replacement identity asset to candidate state', () => {
    const onPatch = vi.fn();
    render(<CharacterDetailEditor entry={{
      ...ARIA,
      imageRefs: ['neutral.png', 'replacement.png'],
      identityPack: { assets: [{ imageRef: 'neutral.png', role: 'neutral', approved: true }] },
    }} characters={[ARIA]} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    fireEvent.change(screen.getByRole('combobox', { name: /identity asset 1 image/i }), {
      target: { value: 'replacement.png' },
    });
    expect(onPatch).toHaveBeenCalledWith({
      identityPack: { assets: [{ imageRef: 'replacement.png', role: 'neutral', approved: false }] },
    });
  });

  it('adds only a complete pronunciation row', () => {
    const onPatch = vi.fn();
    render(<CharacterDetailEditor entry={ARIA} characters={[ARIA]} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));

    const addButton = screen.getByRole('button', { name: /Add pronunciation/i });
    fireEvent.change(screen.getByRole('textbox', { name: /new pronunciation term/i }), {
      target: { value: 'Aster' },
    });
    expect(addButton).toBeDisabled();
    expect(onPatch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: /new pronunciation value/i }), {
      target: { value: 'AS-ter' },
    });
    fireEvent.click(addButton);
    expect(onPatch).toHaveBeenCalledWith({
      voiceCanon: {
        version: 1,
        approved: false,
        pronunciations: [{ term: 'Aster', pronunciation: 'AS-ter' }],
      },
    });
  });
});

describe('CharacterDetailEditor — Psychology (#6414)', () => {
  const openPsychology = () => fireEvent.click(screen.getByRole('tab', { name: 'Story' }));

  it('reads as unassessed on a legacy character and offers no clear action', () => {
    render(<CharacterDetailEditor entry={ARIA} characters={[ARIA]} onPatch={() => {}} />);
    openPsychology();
    expect(screen.getByText('unassessed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clear psychology profile/i })).toBeDisabled();
  });

  it('commits an authored theory of control without disturbing the rest of the profile', () => {
    const onPatch = vi.fn();
    const entry = { ...ARIA, psychology: { strategy: 'Takes every shift nobody wants.' } };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    openPsychology();
    const field = screen.getByRole('textbox', { name: /Theory of control/i });
    fireEvent.change(field, { target: { value: 'If I stay useful, nobody leaves.' } });
    fireEvent.blur(field);
    expect(onPatch).toHaveBeenCalledWith({
      psychology: {
        strategy: 'Takes every shift nobody wants.',
        theoryOfControl: 'If I stay useful, nobody leaves.',
      },
    });
  });

  it('writes a drive leaf into the nested axis it belongs to', () => {
    const onPatch = vi.fn();
    const entry = {
      ...ARIA,
      psychology: { drives: { status: { desire: 'to be counted on' } } },
    };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    openPsychology();
    const fear = screen.getByRole('textbox', { name: /status fear/i });
    fireEvent.change(fear, { target: { value: 'being read as surplus' } });
    fireEvent.blur(fear);
    expect(onPatch).toHaveBeenCalledWith({
      psychology: {
        drives: { status: { desire: 'to be counted on', fear: 'being read as surplus' } },
      },
    });
  });

  it('offers an existing Lie as legacy context, explicitly NOT as the same statement', () => {
    const entry = { ...ARIA, lie: 'I only matter if I win.' };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={() => {}} />);
    openPsychology();
    expect(screen.getByText(/I only matter if I win\./, { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/suggested starting point only/i)).toBeInTheDocument();
    expect(screen.getByText(/not the same sentence/i)).toBeInTheDocument();
    // The theory of control is NOT pre-filled from the Lie.
    expect(screen.getByRole('textbox', { name: /Theory of control/i })).toHaveValue('');
  });

  it('asks for an explanation only once the author rules the profile unknown', () => {
    const onPatch = vi.fn();
    const { rerender } = render(
      <CharacterDetailEditor entry={ARIA} characters={[ARIA]} onPatch={onPatch} />,
    );
    openPsychology();
    expect(screen.queryByRole('textbox', { name: /^Why$/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: /Assessment/i }), {
      target: { value: 'not-applicable' },
    });
    expect(onPatch).toHaveBeenCalledWith({ psychology: { assessment: 'not-applicable' } });
    rerender(
      <CharacterDetailEditor
        entry={{ ...ARIA, psychology: { assessment: 'not-applicable' } }}
        characters={[ARIA]}
        onPatch={onPatch}
      />,
    );
    expect(screen.getByRole('textbox', { name: /^Why$/i })).toBeInTheDocument();
    // A ruling with no prose leaves is still an authored profile — the section
    // must not fall back to "unassessed" and lock the clear action behind it.
    expect(screen.getByRole('button', { name: /Clear psychology profile/i })).toBeEnabled();
  });

  it('clears the whole profile through a single explicit null patch', () => {
    const onPatch = vi.fn();
    const entry = { ...ARIA, psychology: { theoryOfControl: 'Only the work is safe.' } };
    render(<CharacterDetailEditor entry={entry} characters={[ARIA]} onPatch={onPatch} />);
    openPsychology();
    fireEvent.click(screen.getByRole('button', { name: /Clear psychology profile/i }));
    expect(onPatch).toHaveBeenCalledWith({ psychology: null });
  });
});


describe('CharacterDetailEditor — sheet navigation', () => {
  it('keeps identity visible, retains pending rows across pages, and writes the page to the URL', () => {
    function LocationProbe() {
      return <output aria-label="Location">{useLocation().search}</output>;
    }
    const onPatch = vi.fn();
    render(<><CharacterDetailEditor entry={ARIA} onPatch={onPatch} /><LocationProbe /></>);
    expect(screen.getByRole('textbox', { name: 'Pronouns' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Personality & motivations' })).toBeVisible();
    expect(listVoiceEngines).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add prop' }));
    const purpose = screen.getByRole('textbox', { name: 'row 1 purpose' });
    fireEvent.change(purpose, { target: { value: 'navigation' } });
    fireEvent.blur(purpose);
    fireEvent.click(screen.getByRole('tab', { name: 'Story' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('castSheet-chr-aria=story');
    expect(screen.getByRole('textbox', { name: 'Pronouns' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByRole('textbox', { name: 'row 1 purpose' })).toHaveValue('navigation');
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('opens a linked page with locked fields and disables generation', () => {
    render(<CharacterDetailEditor entry={ARIA} disabled onPatch={vi.fn()} onExpand={vi.fn()} />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?castSheet-chr-aria=appearance']}>{children}</MemoryRouter>,
    });
    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Silhouette notes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add prop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'AI: expand character' })).toBeDisabled();
  });
});
