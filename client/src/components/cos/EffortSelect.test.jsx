import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EffortSelect from './EffortSelect';

const CLAUDE = { id: 'claude-code', command: 'claude' };
const AGY = { id: 'antigravity-cli', command: 'agy' };
const CODEX = { id: 'codex', command: 'codex' };
const GROK = { id: 'grok-cli', command: 'grok' };
const KIMI = { id: 'kimi-cli', command: 'kimi' };

describe('EffortSelect', () => {
  it('renders nothing for a provider with no effort control', () => {
    const { container } = render(<EffortSelect provider={KIMI} value="" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers grok its low|medium|high|xhigh ladder — no max, which grok rejects', () => {
    render(<EffortSelect provider={GROK} value="" onChange={() => {}} />);
    expect(screen.getAllByRole('option').map(o => o.textContent))
      .toEqual(['Default effort', 'low', 'medium', 'high', 'xhigh']);
  });

  it('offers agy its narrower low|medium|high ladder', () => {
    render(<EffortSelect provider={AGY} value="" onChange={() => {}} />);
    expect(screen.getAllByRole('option').map(o => o.textContent))
      .toEqual(['Default effort', 'low', 'medium', 'high']);
  });

  it('offers Ultra when Codex runs a model that supports automatic delegation', () => {
    render(<EffortSelect provider={CODEX} model="gpt-5.6-sol" value="" onChange={() => {}} />);
    expect(screen.getAllByRole('option').map(o => o.textContent))
      .toEqual(['Default effort', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('uses a server-published ladder for a renamed custom CLI', () => {
    const custom = {
      id: 'custom-agent',
      effortLevels: ['low', 'medium', 'high'],
      effortLevelsByModel: { 'custom-model': ['low', 'high'] },
    };
    render(<EffortSelect provider={custom} model="custom-model" value="" onChange={() => {}} />);
    expect(screen.getAllByRole('option').map(o => o.textContent))
      .toEqual(['Default effort', 'low', 'high']);
  });

  // The server clamps an out-of-ladder effort rather than dropping it, so the
  // run still gets an `--effort`. Without an option matching the stored value
  // the select renders blank — indistinguishable from "Default effort" — while
  // the run silently uses the clamped level.
  it('surfaces a stored effort outside the provider ladder, naming what it runs as', () => {
    render(<EffortSelect provider={AGY} value="max" onChange={() => {}} />);
    expect(screen.getByRole('combobox')).toHaveValue('max');
    expect(screen.getByRole('option', { name: 'max (runs as high)' })).toBeInTheDocument();
  });

  it('clamps down to the nearest supported level, not the nearest by name', () => {
    render(<EffortSelect provider={AGY} value="minimal" onChange={() => {}} />);
    // Nothing sits below `minimal`, so it falls back to the weakest level.
    expect(screen.getByRole('option', { name: 'minimal (runs as low)' })).toBeInTheDocument();
  });

  it('says an unrecognized effort is ignored rather than implying it runs', () => {
    render(<EffortSelect provider={AGY} value="bogus" onChange={() => {}} />);
    expect(screen.getByRole('option', { name: 'bogus (not supported — ignored)' })).toBeInTheDocument();
  });

  it('keeps a policy-disallowed saved effort visible so it can be cleared', () => {
    render(<EffortSelect
      provider={CLAUDE}
      value="max"
      onChange={() => {}}
      optionFilter={(level) => level === 'low'}
    />);
    const select = screen.getByRole('combobox');
    expect(select).toHaveValue('max');
    expect(screen.getByRole('option', { name: 'max (runs as max) (not permitted here)' })).toBeDisabled();
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Default effort',
      'max (runs as max) (not permitted here)',
      'low',
    ]);
  });

  it('does not add the extra option when the stored value is in the ladder', () => {
    render(<EffortSelect provider={CLAUDE} value="xhigh" onChange={() => {}} />);
    const options = screen.getAllByRole('option').map(o => o.textContent);
    expect(options).toEqual(['Default effort', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(screen.getByRole('combobox')).toHaveValue('xhigh');
  });

  it('reports the raw selection so the caller stores what the user picked', async () => {
    const onChange = vi.fn();
    render(<EffortSelect provider={AGY} value="" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), 'medium');
    expect(onChange).toHaveBeenCalledWith('medium');
  });
});
