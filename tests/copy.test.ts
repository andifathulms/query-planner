/**
 * Copy rules that are worth enforcing mechanically.
 *
 * The em-dash one is here because it is the rule a person cannot hold: it reads
 * as ordinary punctuation while writing and only becomes a tic when you count
 * it across a whole codebase. Sixteen had accumulated in shipped strings before
 * anyone counted. A test counts on every commit.
 *
 * Only shippable strings are checked. Prose in comments, DESIGN.md and PRD.md is
 * writing about the app rather than writing in it, and is left alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** The file with its comments removed, so only shippable text remains. */
function shippable(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const FILES = sourceFiles('src');

describe('shippable copy', () => {
  it('contains no em-dashes or en-dashes', () => {
    // A hyphen is the only dash the interface uses, including as the "no value"
    // glyph in a numeric column. Prose that wants an em-dash gets a colon, a
    // full stop or parentheses instead, which is always the clearer sentence.
    const offenders = FILES.flatMap((path) =>
      shippable(path)
        .split('\n')
        .map((line, i) => ({ path, line: i + 1, text: line.trim() }))
        .filter(({ text }) => /[—–]/.test(text)),
    );
    expect(offenders.map((o) => `${o.path}:${o.line} ${o.text}`)).toEqual([]);
  });

  it('carries no marketing filler', () => {
    const filler = /\b(elevate|seamless|unleash|next-gen|revolutioni[sz]e|supercharge|cutting-edge|game-chang)/i;
    const offenders = FILES.flatMap((path) =>
      shippable(path)
        .split('\n')
        .map((line, i) => ({ path, line: i + 1, text: line.trim() }))
        .filter(({ text }) => filler.test(text)),
    );
    expect(offenders.map((o) => `${o.path}:${o.line} ${o.text}`)).toEqual([]);
  });

  it('does not use the same eyebrow for two different things', () => {
    // Two panels both labelled COST, one being the breakdown and one being the
    // parameters, is worse than no label at all.
    const eyebrows = FILES.flatMap((path) =>
      [...shippable(path).matchAll(/eyebrow[^>]*>([A-Za-z ]+)</g)].map((m) => m[1]),
    );
    expect(eyebrows.length).toBe(new Set(eyebrows).size);
  });
});

describe('the type scale is applied by role', () => {
  const TSX = FILES.filter((f) => f.endsWith('.tsx'));

  it('sets running prose at the prose size, not the label size', () => {
    // DESIGN §3.1 splits the scale by role: prose that explains the app to
    // someone who does not know it is 16 px, data keeps the dense scale. A
    // paragraph carrying a sentence is prose wherever it appears.
    const offenders: string[] = [];
    for (const path of TSX) {
      shippable(path).split('\n').forEach((line, i) => {
        const m = /<p className="t-(small|micro)( [\w-]+)?"/.exec(line);
        // The six data readouts are numbers rather than sentences and are
        // listed by name, so adding a seventh has to be deliberate.
        const READOUTS = ['sample-fraction', 'histogram-summary'];
        if (!m) return;
        const cls = (m[2] ?? '').trim();
        if (READOUTS.includes(cls)) return;
        if (cls === '') return; // bare readouts: rows/ms, selectivity triples
        offenders.push(`${path}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
