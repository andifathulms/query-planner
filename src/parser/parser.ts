/**
 * Recursive descent parser for the subset in PRD §4.1.
 *
 * Hand-written rather than generated because the AST shape is a visualisation
 * input, and because rejections must name the limitation rather than report a
 * position (DESIGN.md §7).
 */
import { tokenize, SqlError, type Token } from './lexer.js';
import type {
  AggregateName, Expr, Join, OrderByItem, SelectItem, SelectStatement, TableRef,
} from './ast.js';

const AGGREGATES = new Set<string>(['count', 'sum', 'avg', 'min', 'max']);

/** Precedence climbing table. Higher binds tighter. */
const PRECEDENCE: Record<string, number> = {
  OR: 1, AND: 2,
  '=': 4, '<>': 4, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6,
};

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }
  private at(text: string): boolean {
    const t = this.peek();
    return (t.type === 'keyword' || t.type === 'operator' || t.type === 'punct') && t.text === text;
  }
  private take(): Token { return this.tokens[this.pos++]; }
  private accept(text: string): boolean { if (this.at(text)) { this.pos++; return true; } return false; }

  private expect(text: string, what?: string): Token {
    if (!this.at(text)) this.fail(`Expected ${what ?? `\`${text}\``}`);
    return this.take();
  }

  private fail(message: string): never {
    const t = this.peek();
    const got = t.type === 'eof' ? 'end of query' : `\`${t.text}\``;
    throw new SqlError(`${message}, found ${got}`, t.start, t.end, t.line, t.column);
  }

  parse(): SelectStatement {
    const stmt = this.parseSelect();
    this.accept(';');
    if (this.peek().type !== 'eof') this.fail('Expected end of query');
    return stmt;
  }

  private parseSelect(): SelectStatement {
    this.expect('SELECT', '`SELECT`');
    if (this.at('DISTINCT')) this.fail('DISTINCT is not supported');
    this.accept('ALL');

    let star = false;
    const select: SelectItem[] = [];
    if (this.at('*') && (this.peek(1).type === 'keyword' && this.peek(1).text === 'FROM')) {
      this.take();
      star = true;
    } else {
      do {
        const expr = this.parseExpr(0);
        let alias: string | null = null;
        if (this.accept('AS')) alias = this.expectIdent('an alias');
        else if (this.peek().type === 'ident') alias = this.take().text;
        select.push({ expr, alias });
      } while (this.accept(','));
    }

    this.expect('FROM', '`FROM`');
    const from = this.parseTableRef();

    const joins: Join[] = [];
    for (;;) {
      if (this.accept(',')) {
        joins.push({ type: 'inner', right: this.parseTableRef(), on: null });
        continue;
      }
      if (this.at('RIGHT')) this.fail('RIGHT JOIN is not supported; only INNER and LEFT');
      if (this.at('FULL')) this.fail('FULL JOIN is not supported; only INNER and LEFT');
      if (this.at('CROSS')) this.fail('CROSS JOIN is not supported; use a comma join');

      let type: Join['type'] | null = null;
      if (this.accept('INNER')) { this.expect('JOIN', '`JOIN`'); type = 'inner'; }
      else if (this.accept('LEFT')) { this.accept('OUTER'); this.expect('JOIN', '`JOIN`'); type = 'left'; }
      else if (this.accept('JOIN')) type = 'inner';
      if (type === null) break;

      const right = this.parseTableRef();
      this.expect('ON', '`ON`');
      joins.push({ type, right, on: this.parseExpr(0) });
    }

    if (joins.length + 1 > 8) {
      this.fail('At most 8 tables are supported; real planners switch to a genetic search around 12');
    }

    const where = this.accept('WHERE') ? this.parseExpr(0) : null;

    let groupBy: Expr[] = [];
    if (this.accept('GROUP')) {
      this.expect('BY', '`BY`');
      groupBy = [];
      do { groupBy.push(this.parseExpr(0)); } while (this.accept(','));
    }

    const having = this.accept('HAVING') ? this.parseExpr(0) : null;

    const orderBy: OrderByItem[] = [];
    if (this.accept('ORDER')) {
      this.expect('BY', '`BY`');
      do {
        const expr = this.parseExpr(0);
        let direction: 'asc' | 'desc' = 'asc';
        if (this.accept('DESC')) direction = 'desc';
        else this.accept('ASC');
        orderBy.push({ expr, direction });
      } while (this.accept(','));
    }

    let limit: number | null = null;
    if (this.accept('LIMIT')) {
      const t = this.take();
      if (t.type !== 'number') this.fail('Expected a row count after `LIMIT`');
      limit = Number(t.text);
    }

    return { kind: 'select', select, star, from, joins, where, groupBy, having, orderBy, limit };
  }

  private expectIdent(what: string): string {
    const t = this.peek();
    if (t.type !== 'ident') this.fail(`Expected ${what}`);
    this.pos++;
    return t.text;
  }

  private parseTableRef(): TableRef {
    if (this.at('(')) this.fail('Subqueries in FROM are not supported');
    const table = this.expectIdent('a table name');
    let alias = table;
    if (this.accept('AS')) alias = this.expectIdent('an alias');
    else if (this.peek().type === 'ident') alias = this.take().text;
    return { table, alias };
  }

  /** Precedence climbing, with the postfix predicates handled after each operand. */
  private parseExpr(minPrec: number): Expr {
    let left = this.parseUnary();
    left = this.parsePostfix(left);

    for (;;) {
      const t = this.peek();
      const op = (t.type === 'operator' || t.type === 'keyword') ? t.text : null;
      if (op === null) break;
      const prec = PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      this.pos++;
      let right = this.parseExpr(prec + 1);
      right = this.parsePostfix(right);
      left = { kind: 'binary', op: op as never, left, right };
    }
    return left;
  }

  private parsePostfix(operand: Expr): Expr {
    for (;;) {
      if (this.accept('IS')) {
        const negated = this.accept('NOT');
        this.expect('NULL', '`NULL`');
        operand = { kind: 'isnull', operand, negated };
        continue;
      }
      let negated = false;
      if (this.at('NOT') && (this.peek(1).text === 'IN' || this.peek(1).text === 'BETWEEN')) {
        this.pos++;
        negated = true;
      }
      if (this.accept('IN')) {
        this.expect('(', '`(`');
        if (this.at('SELECT')) this.fail('Subqueries are not supported');
        const values: Expr[] = [];
        do { values.push(this.parseExpr(3)); } while (this.accept(','));
        this.expect(')', '`)`');
        operand = { kind: 'in', operand, values, negated };
        continue;
      }
      if (this.accept('BETWEEN')) {
        const low = this.parseExpr(5);
        this.expect('AND', '`AND`');
        const high = this.parseExpr(5);
        operand = { kind: 'between', operand, low, high, negated };
        continue;
      }
      if (negated) this.fail('Expected `IN` or `BETWEEN` after `NOT`');
      return operand;
    }
  }

  private parseUnary(): Expr {
    if (this.accept('NOT')) return { kind: 'unary', op: 'NOT', operand: this.parseExpr(3) };
    if (this.accept('-')) return { kind: 'unary', op: '-', operand: this.parseUnary() };
    if (this.accept('+')) return this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.type === 'punct' && t.text === '(') {
      this.pos++;
      if (this.at('SELECT')) this.fail('Subqueries are not supported');
      const e = this.parseExpr(0);
      this.expect(')', '`)`');
      return e;
    }
    if (t.type === 'number') { this.pos++; return { kind: 'literal', value: Number(t.text) }; }
    if (t.type === 'string') { this.pos++; return { kind: 'literal', value: t.text }; }
    if (this.accept('NULL')) return { kind: 'literal', value: null };
    if (this.accept('TRUE')) return { kind: 'literal', value: true };
    if (this.accept('FALSE')) return { kind: 'literal', value: false };

    if (t.type === 'ident') {
      // Function call?
      if (this.peek(1).type === 'punct' && this.peek(1).text === '(') {
        const name = t.text.toLowerCase();
        if (!AGGREGATES.has(name)) {
          throw new SqlError(
            `Only the aggregates count, sum, avg, min and max are supported; \`${t.text}\` is not`,
            t.start, t.end, t.line, t.column,
          );
        }
        this.pos += 2;
        if (this.at('DISTINCT')) this.fail('DISTINCT inside an aggregate is not supported');
        let argument: Expr | null = null;
        if (this.accept('*')) {
          if (name !== 'count') this.fail(`\`*\` is only valid as an argument to count`);
        } else {
          argument = this.parseExpr(0);
        }
        this.expect(')', '`)`');
        if (this.at('OVER')) this.fail('Window functions are not supported');
        return { kind: 'aggregate', name: name as AggregateName, argument };
      }

      this.pos++;
      if (this.accept('.')) {
        if (this.accept('*')) {
          throw new SqlError(
            'Qualified star (`t.*`) is not supported; list the columns',
            t.start, t.end, t.line, t.column,
          );
        }
        return { kind: 'column', table: t.text, name: this.expectIdent('a column name') };
      }
      return { kind: 'column', table: null, name: t.text };
    }

    this.fail('Expected an expression');
  }
}

export function parse(sql: string): SelectStatement {
  const tokens = tokenize(sql);
  if (tokens.length === 1) {
    throw new SqlError('Empty query', 0, 0, 1, 1);
  }
  return new Parser(tokens).parse();
}

export { SqlError };
