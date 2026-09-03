/**
 * The SQL input.
 *
 * A plain textarea rather than an editor component: the subset is small, the
 * queries are short, and a syntax highlighter would be weight spent on the one
 * part of the screen that is not the subject.
 *
 * Errors name the limitation — "Window functions are not supported", not "syntax
 * error near OVER" (DESIGN.md §7).
 */
import { useEffect, useRef, useState } from 'react';
import type { EngineError } from '../state/engine.js';
import './SqlInput.css';

export interface SqlInputProps {
  sql: string;
  error: EngineError | null;
  onChange: (sql: string) => void;
}

export function SqlInput({ sql, error, onChange }: SqlInputProps) {
  const [draft, setDraft] = useState(sql);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // The store owns the query; the textarea holds a draft so a mid-edit state
  // never fights an external change (an example chosen, a link opened).
  useEffect(() => { setDraft(sql); }, [sql]);

  // Grow to fit. A fixed height has to guess how many lines the query wraps to
  // in a 380 px column, and it guesses wrong the moment someone opens an example
  // with a longer FROM clause: the last line ends up cut in half by the bottom
  // edge. Capped, so a hundred-line paste does not push the panel off-screen.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 520)}px`;
  }, [draft]);

  const commit = (value: string): void => {
    setDraft(value);
    onChange(value);
  };

  return (
    <div className="sql-input">
      <div className="panel-head">
        <span className="panel-head-title">
          <span className="eyebrow">Query</span>
          <h2 className="t-h2">The statement to plan</h2>
        </span>
      </div>

      <textarea
        ref={textarea}
        className="field sql-input-area"
        value={draft}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={8}
        aria-label="SQL query"
        aria-invalid={error !== null}
        aria-describedby={error ? 'sql-error' : undefined}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          // Tab indents rather than leaving the field, but shift-tab still
          // escapes, so the input never becomes a keyboard trap.
          if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: n } = el;
            const next = `${draft.slice(0, s)}  ${draft.slice(n)}`;
            commit(next);
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }
        }}
      />

      {error && (
        <p className="sql-input-error" id="sql-error" role="alert">
          {error.message}
          {error.line !== undefined && (
            <span className="sql-input-position"> · line {error.line}, column {error.column}</span>
          )}
        </p>
      )}
    </div>
  );
}
