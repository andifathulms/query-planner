// @vitest-environment jsdom
/**
 * The theme control (DESIGN.md §2.4).
 *
 * Three states, as the platform models them: follow the system, force light,
 * force dark. What is asserted here is the contract the token file depends on —
 * that "follow the system" leaves `data-theme` off entirely, so
 * `prefers-color-scheme` decides, and that an explicit choice stamps the
 * attribute and survives a reload.
 *
 * The theme is deliberately not in the URL, and that is asserted too: a shared
 * link carries a plan, not a colour scheme.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ThemeToggle } from '../src/ui/ThemeToggle.js';

/**
 * jsdom serves a plain object in place of `Storage` here, so the real thing is
 * stubbed. That the component survives a `localStorage` with no methods at all
 * is itself worth knowing, and the last case asserts the harsher version of it.
 */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    },
  });
  return store;
}

let store: Map<string, string>;

beforeEach(() => {
  store = stubStorage();
  document.documentElement.removeAttribute('data-theme');
  window.location.hash = '';
});
afterEach(cleanup);

const toggle = () => screen.getByRole('button');

describe('the theme control', () => {
  it('follows the system until asked not to', () => {
    render(<ThemeToggle />);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(toggle().getAttribute('aria-label')).toMatch(/follows the system/);
  });

  it('cycles system, light, dark, and back', () => {
    render(<ThemeToggle />);
    fireEvent.click(toggle());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    fireEvent.click(toggle());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(toggle());
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('says where the next click goes, so the control is not a mystery glyph', () => {
    render(<ThemeToggle />);
    expect(toggle().getAttribute('aria-label')).toMatch(/Switch to light/);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-label')).toMatch(/Theme: light\. Switch to dark\./);
  });

  it('restores the choice on the next visit', () => {
    render(<ThemeToggle />);
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(store.get('query-planner:theme')).toBe('dark');

    cleanup();
    document.documentElement.removeAttribute('data-theme');
    render(<ThemeToggle />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('keeps the theme out of the address bar', () => {
    render(<ThemeToggle />);
    fireEvent.click(toggle());
    expect(window.location.hash).toBe('');
  });

  it('renders when storage throws, rather than taking the page down with it', () => {
    // A private window, or a browser set to block site data: the accessor itself
    // throws rather than returning null.
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('site data blocked'); },
    });
    try {
      render(<ThemeToggle />);
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
      fireEvent.click(toggle());
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    } finally {
      Object.defineProperty(window, 'localStorage', original);
    }
  });
});
