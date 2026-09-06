/**
 * Contrast, measured against the token file rather than asserted in a comment.
 *
 * DESIGN.md §8 claims 4.5:1 for text and 3:1 for graphical objects in both
 * themes. It was not true: --ink-faint sat at 2.34:1 on the sunken ground while
 * being the colour of the app's explanatory prose, so the text that explains the
 * app was its least readable text. This file is the claim made checkable.
 *
 * Every ratio is taken against --surface-sunken as well as --surface, because a
 * diagram, a table and an input all sit on the sunken ground and that is the
 * harder of the two.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS = readFileSync('src/styles/tokens.css', 'utf8');

/** The light palette is on bare `:root`; the dark one on [data-theme='dark']. */
function palette(theme: 'light' | 'dark'): Record<string, string> {
  const block = theme === 'light'
    ? CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('@media (prefers-color-scheme: dark)'))
    : CSS.slice(CSS.indexOf(":root[data-theme='dark']"));
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    if (!(name in out)) out[name] = value;
  }
  return out;
}

function luminance(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255)
    + 0.7152 * channel((n >> 8) & 255)
    + 0.0722 * channel(n & 255);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = ['light', 'dark'] as const;

/** Text tokens, and the floor each must clear on both grounds. */
const TEXT = ['ink', 'ink-mid', 'ink-faint', 'believed-ink', 'true-ink', 'order-ink', 'warn-ink'];

/** Lines that carry meaning rather than decorate. */
const GRAPHICAL = ['line-strong', 'believed', 'true', 'order', 'warn'];

describe.each(THEMES)('%s theme', (theme) => {
  const p = palette(theme);
  const grounds = [['surface', p.surface], ['surface-sunken', p['surface-sunken']]] as const;

  it.each(TEXT)('%s clears 4.5:1 as text on both grounds', (token) => {
    expect(p[token]).toBeDefined();
    for (const [name, ground] of grounds) {
      const r = ratio(p[token], ground);
      expect(`${token} on ${name}: ${r.toFixed(2)}`).toBe(
        `${token} on ${name}: ${Math.max(r, 4.5).toFixed(2)}`,
      );
    }
  });

  it.each(GRAPHICAL)('%s clears 3:1 as a graphical object on both grounds', (token) => {
    for (const [name, ground] of grounds) {
      const r = ratio(p[token], ground);
      expect(`${token} on ${name}: ${r.toFixed(2)}`).toBe(
        `${token} on ${name}: ${Math.max(r, 3).toFixed(2)}`,
      );
    }
  });

  it('keeps the ink ramp in three visibly separate steps', () => {
    // Fixing --ink-faint by pushing it to the 4.5 floor collapses it into
    // --ink-mid, which trades one defect for another. Each step is at least 1.3x
    // the next against the harder ground.
    const on = (t: string) => ratio(p[t], p['surface-sunken']);
    expect(on('ink') / on('ink-mid')).toBeGreaterThan(1.3);
    expect(on('ink-mid') / on('ink-faint')).toBeGreaterThan(1.3);
  });
});

describe('the type scale scales with the reader', () => {
  it('is declared in rem, not px', () => {
    // Declared in px, the scale ignored a reader who had set a larger default
    // text size, and ignored text-only zoom entirely (WCAG 1.4.4).
    const sizes = [...CSS.matchAll(/--t-[\w-]+-size:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(sizes.length).toBeGreaterThan(5);
    expect(sizes.filter((v) => v.endsWith('px'))).toEqual([]);
    expect(sizes.every((v) => v.endsWith('rem'))).toBe(true);
  });

  it('converts exactly at a 16px root, so nothing moves at default zoom', () => {
    const expected: Record<string, number> = {
      display: 40, figure: 24, h2: 15, prose: 16, body: 14,
      data: 12.5, label: 11.5, micro: 10, sql: 13.5,
    };
    for (const [name, px] of Object.entries(expected)) {
      const m = new RegExp(`--t-${name}-size:\\s*([\\d.]+)rem`).exec(CSS);
      expect(m, `--t-${name}-size should be declared in rem`).toBeTruthy();
      expect(Number(m![1]) * 16).toBeCloseTo(px, 6);
    }
  });
});

describe('pointer targets', () => {
  it('declares a minimum target size as a token, not per control', () => {
    // WCAG 2.5.8 is a rule, so it is a token. Sliders declared 16 px and did not
    // qualify for the user-agent exception, which covers only controls the
    // author has not sized.
    const m = /--target-min:\s*(\d+)px/.exec(CSS);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(24);
  });

  it('sizes every author-sized control from it', () => {
    const controls = readFileSync('src/styles/controls.css', 'utf8');
    // No control may re-declare its own height in pixels.
    const heights = [...controls.matchAll(/(?:min-)?height:\s*(\d+)px/g)].map((x) => x[1]);
    expect(heights).toEqual([]);
    expect(controls).toMatch(/height: var\(--target-min\)/);
  });
});
