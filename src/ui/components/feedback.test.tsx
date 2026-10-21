import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AnimatedNumber,
  DeltaChip,
  ScoreBar,
  Skeleton,
  ToastStack,
} from './feedback.tsx';
import { useToasts } from '../toasts.ts';

describe('AnimatedNumber', () => {
  it('renders the formatted target on first paint', () => {
    render(<AnimatedNumber value={1234567.8} />);
    expect(screen.getByText('1,234,568')).toBeInTheDocument();
  });

  it('accepts a custom format', () => {
    render(<AnimatedNumber value={9.5} format={(n) => `${n.toFixed(1)}s`} />);
    expect(screen.getByText('9.5s')).toBeInTheDocument();
  });
});

describe('DeltaChip', () => {
  it('shows gains in tide and losses in ember', () => {
    const { rerender } = render(<DeltaChip current={110} previous={100} />);
    expect(screen.getByText(/10\.0%/)).toHaveClass('text-tide');
    rerender(<DeltaChip current={90} previous={100} />);
    expect(screen.getByText(/10\.0%/)).toHaveClass('text-ember');
  });

  it('hides flat, zero-base, and non-finite deltas', () => {
    const { container, rerender } = render(<DeltaChip current={100} previous={100} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DeltaChip current={50} previous={0} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DeltaChip current={NaN} previous={100} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ScoreBar', () => {
  it('clamps the fill to 0–100%', () => {
    const { container, rerender } = render(<ScoreBar share={140} />);
    expect(container.querySelector('.score-bar-fill')).toHaveStyle({ width: '100%' });
    rerender(<ScoreBar share={-20} />);
    expect(container.querySelector('.score-bar-fill')).toHaveStyle({ width: '0%' });
  });
});

describe('Skeleton', () => {
  it('announces loading with placeholder rows', () => {
    const { container } = render(<Skeleton lines={2} />);
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(2);
  });
});

describe('ToastStack', () => {
  it('renders the stack with dismiss buttons', async () => {
    const user = userEvent.setup();
    function Harness() {
      const { toasts, push, dismiss } = useToasts();
      return (
        <>
          <button type="button" onClick={() => push('Hello.')}>push</button>
          <ToastStack toasts={toasts} onDismiss={dismiss} />
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'push' }));
    expect(screen.getByText('Hello.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /dismiss: hello/i }));
    expect(screen.queryByText('Hello.')).not.toBeInTheDocument();
  });

  it('renders an action button that is keyboard-reachable and runs its handler', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    function Harness() {
      const { toasts, push, dismiss } = useToasts();
      return (
        <>
          <button type="button" onClick={() => push('Gone.', 'success', { action: { label: 'Undo', onAction } })}>
            push
          </button>
          <ToastStack toasts={toasts} onDismiss={dismiss} />
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'push' }));
    // Focus stays on the pushing control (it still exists), so Tab reaches Undo.
    expect(screen.getByRole('button', { name: 'push' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('moves stranded focus to the action button', () => {
    function Harness() {
      const { toasts, push, dismiss } = useToasts();
      return (
        <>
          <button type="button" onClick={() => push('Gone.', 'success', { action: { label: 'Undo', onAction: () => {} } })}>
            push
          </button>
          <ToastStack toasts={toasts} onDismiss={dismiss} />
        </>
      );
    }
    render(<Harness />);
    // fireEvent does not focus the clicked button, like a control that vanished with its action.
    fireEvent.click(screen.getByRole('button', { name: 'push' }));
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
  });

  describe('pausing auto-dismiss', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function Harness() {
      const { toasts, push, dismiss, hold } = useToasts();
      return (
        <>
          <button
            type="button"
            onClick={() => push('Gone.', 'success', { timeoutMs: 10_000, action: { label: 'Undo', onAction: () => {} } })}
          >
            push
          </button>
          <ToastStack toasts={toasts} onDismiss={dismiss} onHold={hold} />
        </>
      );
    }

    it('does not expire while hovered, then finishes the time left after leave', () => {
      vi.useFakeTimers();
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'push' }));
      const toast = screen.getByRole('status');
      // The stranded-focus rule put focus on Undo (which also holds); release it to test hover alone.
      act(() => screen.getByRole('button', { name: 'Undo' }).blur());
      act(() => void vi.advanceTimersByTime(6000));
      fireEvent.mouseEnter(toast);
      act(() => void vi.advanceTimersByTime(60_000));
      expect(screen.getByText('Gone.')).toBeInTheDocument();
      fireEvent.mouseLeave(toast);
      act(() => void vi.advanceTimersByTime(3999));
      expect(screen.getByText('Gone.')).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(1));
      expect(screen.queryByText('Gone.')).not.toBeInTheDocument();
    });

    it('does not expire while focus is inside, and moving focus within keeps it paused', () => {
      vi.useFakeTimers();
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'push' }));
      const undo = screen.getByRole('button', { name: 'Undo' });
      const dismiss = screen.getByRole('button', { name: /dismiss/i });
      act(() => undo.focus());
      act(() => void vi.advanceTimersByTime(60_000));
      expect(screen.getByText('Gone.')).toBeInTheDocument();
      act(() => dismiss.focus()); // blur from Undo lands inside the same toast
      act(() => void vi.advanceTimersByTime(60_000));
      expect(screen.getByText('Gone.')).toBeInTheDocument();
      act(() => dismiss.blur());
      act(() => void vi.advanceTimersByTime(10_000));
      expect(screen.queryByText('Gone.')).not.toBeInTheDocument();
    });
  });
});
