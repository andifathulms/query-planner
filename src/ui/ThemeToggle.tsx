/**
 * The theme control (DESIGN.md §2.4).
 *
 * Three states, as the platform actually models them: follow the system, force
 * light, force dark. The choice persists to localStorage and is deliberately not
 * in the URL — a shared link carries a plan, and forcing a colleague into your
 * theme to show them a plan would be rude. Theme is a property of the reader,
 * not of the finding.
 */
import { useEffect, useState } from 'react';
import './ThemeToggle.css';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'query-planner:theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

const GLYPH: Record<ThemeChoice, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};

const TITLE: Record<ThemeChoice, string> = {
  system: 'Theme: follows the system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(read);

  useEffect(() => {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    write(choice);
  }, [choice]);

  const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];

  return (
    <button
      type="button"
      className="control control-quiet theme-toggle"
      // The title said less than the label and was announced alongside it.
      title={`${TITLE[choice]}. Switch to ${next}.`}
      aria-label={`${TITLE[choice]}. Switch to ${next}.`}
      onClick={() => setChoice(next)}
    >
      <span aria-hidden="true">{GLYPH[choice]}</span>
    </button>
  );
}

/* Storage can throw outright in a private window or with site data blocked, so
 * both directions are guarded and the app renders correctly with no stored
 * value. */
function read(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch { /* no stored preference; follow the system */ }
  return 'system';
}

function write(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch { /* the preference simply does not persist */ }
}
