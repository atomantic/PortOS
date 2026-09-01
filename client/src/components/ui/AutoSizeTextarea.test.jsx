import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import AutoSizeTextarea from './AutoSizeTextarea.jsx';

describe('AutoSizeTextarea', () => {
  it('renders a textarea with auto-sizing classes and custom classes', () => {
    render(
      <AutoSizeTextarea
        value="Hello world"
        onChange={vi.fn()}
        className="custom-class min-h-[44px]"
        placeholder="Enter text..."
      />
    );

    const textarea = screen.getByPlaceholderText('Enter text...');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveClass('resize-none');
    expect(textarea).toHaveClass('overflow-hidden');
    expect(textarea).toHaveClass('break-words');
    expect(textarea).toHaveClass('custom-class');
    expect(textarea).toHaveClass('min-h-[44px]');
    expect(textarea).toHaveValue('Hello world');
  });

  it('forwards ref to the underlying textarea element', () => {
    let capturedRef = null;
    function TestComponent() {
      const ref = useRef(null);
      capturedRef = ref;
      return <AutoSizeTextarea ref={ref} value="" onChange={vi.fn()} placeholder="With ref" />;
    }

    render(<TestComponent />);
    const textarea = screen.getByPlaceholderText('With ref');
    expect(capturedRef.current).toBe(textarea);
  });

  it('forwards callback ref to the underlying textarea element', () => {
    const callbackRef = vi.fn();
    render(<AutoSizeTextarea ref={callbackRef} value="" onChange={vi.fn()} placeholder="Callback ref" />);
    const textarea = screen.getByPlaceholderText('Callback ref');
    expect(callbackRef).toHaveBeenCalledWith(textarea);
  });

  it('calls onChange handler and updates value on user input', () => {
    const onChange = vi.fn();
    render(<AutoSizeTextarea value="" onChange={onChange} placeholder="Type here" />);

    const textarea = screen.getByPlaceholderText('Type here');
    fireEvent.change(textarea, { target: { value: 'New text added' } });

    expect(onChange).toHaveBeenCalled();
  });

  it('forwards additional standard textarea props', () => {
    render(
      <AutoSizeTextarea
        id="test-id"
        aria-label="Accessible description"
        value="Readonly text"
        rows={4}
        disabled
        onChange={vi.fn()}
      />
    );

    const textarea = screen.getByLabelText('Accessible description');
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveAttribute('id', 'test-id');
    expect(textarea).toHaveAttribute('rows', '4');
  });
});
