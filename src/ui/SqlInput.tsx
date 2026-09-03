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
import { EXAMPLES } from '../state/types.js';
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

      {/* The examples menu sits below the field rather than in the head. In a
          380 px column a select wide enough to show "grouping over correlated
          columns" leaves the heading four words on three lines. */}
      <label className="sql-input-examples">
        <span className="visually-hidden">Example queries</span>
        <select
          className="field"
          value=""
          onChange={(e) => {
            const example = EXAMPLES.find((x) => x.label === e.target.value);
            if (example) commit(example.sql);
          }}
        >
          <option value="">examples…</option>
          {EXAMPLES.map((x) => <option key={x.label} value={x.label}>{x.label}</option>)}
        </select>
      </label>

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
