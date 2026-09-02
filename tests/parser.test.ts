import { describe, it, expect } from 'vitest';
import { parse, SqlError } from '../src/parser/parser.js';
import { conjuncts, formatExpr } from '../src/parser/ast.js';

describe('the accepted subset', () => {
  it('parses a star select', () => {
    const q = parse('SELECT * FROM kelurahan k');
    expect(q.star).toBe(true);
    expect(q.from).toEqual({ table: 'kelurahan', alias: 'k' });
  });

  it('parses projections with and without aliases', () => {
    const q = parse('SELECT k.nama, count(*) AS n, sum(k.penduduk) total FROM kelurahan k');
    expect(q.select).toHaveLength(3);
    expect(q.select[1].alias).toBe('n');
    expect(q.select[2].alias).toBe('total');
    expect(formatExpr(q.select[2].expr)).toBe('sum(k.penduduk)');
  });

  it('parses inner and left joins', () => {
    const q = parse(`
      SELECT * FROM kelurahan k
      JOIN kecamatan c ON k.kecamatan_id = c.id
      LEFT OUTER JOIN kabupaten b ON c.kabupaten_id = b.id
    `);
    expect(q.joins.map((j) => j.type)).toEqual(['inner', 'left']);
    expect(q.joins[1].right.alias).toBe('b');
  });

  it('parses a comma join as an inner join with no condition', () => {
    const q = parse('SELECT * FROM a x, b y');
    expect(q.joins[0]).toMatchObject({ type: 'inner', on: null });
  });

  it('gives AND lower precedence than comparison, and OR lower still', () => {
    const q = parse("SELECT * FROM t WHERE a = 1 AND b = 2 OR c = 3");
    expect(formatExpr(q.where!)).toBe('a = 1 AND b = 2 OR c = 3');
    expect(q.where).toMatchObject({ kind: 'binary', op: 'OR' });
  });

  it('flattens conjuncts', () => {
    const q = parse("SELECT * FROM t WHERE a = 1 AND b = 2 AND c = 3");
    expect(conjuncts(q.where).map(formatExpr)).toEqual(['a = 1', 'b = 2', 'c = 3']);
  });

  it('parses BETWEEN, IN, IS NULL and their negations', () => {
    const q = parse(`SELECT * FROM t
      WHERE a BETWEEN 1 AND 10 AND b IN (1, 2, 3) AND c IS NOT NULL AND d NOT IN ('x')`);
    const cs = conjuncts(q.where);
    expect(cs.map((c) => c.kind)).toEqual(['between', 'in', 'isnull', 'in']);
    expect(cs[2]).toMatchObject({ negated: true });
    expect(cs[3]).toMatchObject({ negated: true });
  });

  it('does not let BETWEEN swallow the trailing AND clause', () => {
    const q = parse('SELECT * FROM t WHERE a BETWEEN 1 AND 10 AND b = 2');
    expect(conjuncts(q.where)).toHaveLength(2);
  });

  it('parses GROUP BY, HAVING, ORDER BY and LIMIT', () => {
    const q = parse(`SELECT p.nama, count(*) FROM penduduk p
      GROUP BY p.nama HAVING count(*) > 10 ORDER BY p.nama DESC, count(*) LIMIT 10`);
    expect(q.groupBy).toHaveLength(1);
    expect(formatExpr(q.having!)).toBe('count(*) > 10');
    expect(q.orderBy.map((o) => o.direction)).toEqual(['desc', 'asc']);
    expect(q.limit).toBe(10);
  });

  it('accepts !=' , () => {
    expect(formatExpr(parse('SELECT * FROM t WHERE a != 1').where!)).toBe('a <> 1');
  });

  it('handles comments and quoted strings with doubled quotes', () => {
    const q = parse(`-- leading comment
      SELECT * FROM t /* inline */ WHERE nama = 'O''Brien'`);
    expect(formatExpr(q.where!)).toBe("nama = 'O'Brien'");
  });
});

describe('rejections name the limitation', () => {
  const cases: Array<[string, string]> = [
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'Common table expressions'],
    ['SELECT row_number() OVER () FROM t', 'Window functions'],
    ['SELECT * FROM a UNION SELECT * FROM b', 'UNION'],
    ['SELECT * FROM a RIGHT JOIN b ON a.i = b.i', 'RIGHT JOIN is not supported'],
    ['SELECT * FROM a FULL JOIN b ON a.i = b.i', 'FULL JOIN is not supported'],
    ['SELECT DISTINCT a FROM t', 'DISTINCT is not supported'],
    ['SELECT * FROM (SELECT 1) x', 'Subqueries in FROM'],
    ['SELECT * FROM t WHERE a IN (SELECT 1)', 'Subqueries are not supported'],
    ['SELECT median(a) FROM t', 'Only the aggregates count, sum, avg, min and max'],
    ['DELETE FROM t', 'Only SELECT is supported'],
    ['SELECT CASE WHEN a THEN 1 END FROM t', 'CASE expressions'],
    ['SELECT * FROM a, b, c, d, e, f, g, h, i', 'At most 8 tables'],
  ];
  for (const [sql, fragment] of cases) {
    it(`rejects ${sql.slice(0, 40)}`, () => {
      expect(() => parse(sql)).toThrow(new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  }

  it('reports position on a plain syntax error', () => {
    try {
      parse('SELECT * FROM');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SqlError);
      expect((e as SqlError).message).toMatch(/Expected a table name, found end of query/);
    }
  });

  it('rejects an unterminated string', () => {
    expect(() => parse("SELECT * FROM t WHERE a = 'x")).toThrow(/Unterminated string/);
  });
});
