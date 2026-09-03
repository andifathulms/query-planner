/**
 * The select control.
 *
 * A bare `<select>` keeps its native platform chrome no matter what background
 * and border you give it, so on macOS the dataset menu rendered as a light grey
 * system pill with blue stepper arrows sitting inside a dark instrument panel.
 * `appearance: none` is the whole fix, and once it is off the caret has to be
 * drawn back.
 *
 * The caret is hand-drawn rather than pulled from an icon library because it is
 * a two-line chevron and this project carries no icon dependency by design. The
 * option list itself stays native and unstyleable, which is correct: it follows
 * `color-scheme`, so it is already dark when the app is.
 */
import type { SelectHTMLAttributes } from 'react';
import './Select.css';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Fills the space it is given rather than sizing to its longest option. */
  block?: boolean;
}

export function Select({ block, className, children, ...props }: SelectProps) {
  return (
    <span className={`select${block ? ' is-block' : ''}${className ? ` ${className}` : ''}`}>
      <select {...props}>{children}</select>
      <svg className="select-caret" width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
        <path d="M1 1.5 4.5 5 8 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </span>
  );
}
