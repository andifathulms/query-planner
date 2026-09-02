/** Hand-written lexer for the accepted SQL subset. */

export type TokenType =
  | 'ident' | 'keyword' | 'number' | 'string' | 'operator' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  /** Original text. Keywords are upper-cased here; identifiers are not. */
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

/**
 * Every word the parser recognises. Words in `UNSUPPORTED` are lexed as keywords
 * too, so the parser can reject them by name rather than as a stray identifier
 * (DESIGN.md §7: errors name the limitation).
 */
export const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'AS',
  'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'BETWEEN', 'ASC', 'DESC',
  'TRUE', 'FALSE', 'DISTINCT', 'ALL',
]);

export const UNSUPPORTED = new Map<string, string>([
  ['WITH', 'Common table expressions (WITH) are not supported'],
  ['RECURSIVE', 'Recursive queries are not supported'],
  ['UNION', 'UNION is not supported'],
  ['INTERSECT', 'INTERSECT is not supported'],
  ['EXCEPT', 'EXCEPT is not supported'],
  ['OVER', 'Window functions are not supported'],
  ['PARTITION', 'Window functions are not supported'],
  ['LATERAL', 'Lateral joins are not supported'],
  ['EXISTS', 'Subqueries are not supported'],
  ['INSERT', 'Only SELECT is supported'],
  ['UPDATE', 'Only SELECT is supported'],
  ['DELETE', 'Only SELECT is supported'],
  ['CREATE', 'Only SELECT is supported'],
  ['VALUES', 'VALUES lists are not supported'],
  ['CASE', 'CASE expressions are not supported'],
]);

export class SqlError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = 'SqlError';
  }
}

const TWO_CHAR = new Set(['<=', '>=', '<>', '!=']);
const ONE_CHAR_OP = new Set(['=', '<', '>', '+', '-', '*', '/']);
const PUNCT = new Set(['(', ')', ',', '.', ';']);

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const push = (type: TokenType, text: string, start: number): void => {
    tokens.push({ type, text, start, end: i, line, column: start - lineStart + 1 });
  };
  const fail = (message: string, start: number): never => {
    throw new SqlError(message, start, i + 1, line, start - lineStart + 1);
  };

  while (i < sql.length) {
    const c = sql[i];

    if (c === '\n') { i++; line++; lineStart = i; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    // Line comment.
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    // Block comment.
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') { line++; lineStart = i + 1; }
        i++;
      }
      if (i >= sql.length) fail('Unterminated block comment', start);
      i += 2;
      continue;
    }

    // Single-quoted string, '' as the escape.
    if (c === "'") {
      const start = i;
      i++;
      let text = '';
      for (;;) {
        if (i >= sql.length || sql[i] === '\n') fail('Unterminated string literal', start);
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { text += "'"; i += 2; continue; }
          i++;
          break;
        }
        text += sql[i++];
      }
      push('string', text, start);
      continue;
    }

    // Double-quoted identifier.
    if (c === '"') {
      const start = i;
      i++;
      let text = '';
      while (i < sql.length && sql[i] !== '"') text += sql[i++];
      if (i >= sql.length) fail('Unterminated quoted identifier', start);
      i++;
      push('ident', text, start);
      continue;
    }

    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < sql.length && /[0-9]/.test(sql[i])) i++;
      if (sql[i] === '.' && /[0-9]/.test(sql[i + 1] ?? '')) {
        i++;
        while (i < sql.length && /[0-9]/.test(sql[i])) i++;
      }
      if (sql[i] === 'e' || sql[i] === 'E') {
        const save = i;
        i++;
        if (sql[i] === '+' || sql[i] === '-') i++;
        if (/[0-9]/.test(sql[i] ?? '')) { while (i < sql.length && /[0-9]/.test(sql[i])) i++; }
        else i = save;
      }
      push('number', sql.slice(start, i), start);
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      const word = sql.slice(start, i);
      const upper = word.toUpperCase();
      if (UNSUPPORTED.has(upper)) {
        throw new SqlError(UNSUPPORTED.get(upper)!, start, i, line, start - lineStart + 1);
      }
      if (KEYWORDS.has(upper)) push('keyword', upper, start);
      else push('ident', word, start);
      continue;
    }

    const two = sql.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      const start = i;
      i += 2;
      push('operator', two === '!=' ? '<>' : two, start);
      continue;
    }
    if (ONE_CHAR_OP.has(c)) { const start = i; i++; push('operator', c, start); continue; }
    if (PUNCT.has(c)) { const start = i; i++; push('punct', c, start); continue; }

    const start = i;
    i++;
    fail(`Unexpected character ${JSON.stringify(c)}`, start);
  }

  tokens.push({ type: 'eof', text: '', start: i, end: i, line, column: i - lineStart + 1 });
  return tokens;
}
