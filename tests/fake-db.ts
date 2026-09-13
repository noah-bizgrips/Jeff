import { randomUUID } from "node:crypto";

/**
 * Tiny in-memory stand-in for the Supabase admin client, enough for the
 * store/runner code paths under test: filters (eq/neq/in/gte/lte/gt/lt/is/not),
 * order, limit, insert/update/delete/upsert, select+count, single/maybeSingle.
 * Every write is recorded in `writes` so tests can assert "no writes except X".
 */
type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export interface Write {
  table: string;
  op: "insert" | "update" | "delete" | "upsert";
  payload: unknown;
}

export class FakeDb {
  tables = new Map<string, Row[]>();
  writes: Write[] = [];

  seed(table: string, rows: Row[]) {
    this.tables.set(table, rows.map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r })));
    return this;
  }
  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }
  writesTo(table: string, op?: Write["op"]) {
    return this.writes.filter((w) => w.table === table && (!op || w.op === op));
  }

  client() {
    return { from: (table: string) => new Query(this, table) };
  }
}

class Query implements PromiseLike<{ data: unknown; error: null; count: number | null }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: unknown = null;
  private ordering: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private countOnly = false;
  private wantSelect = false;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") this.wantSelect = true;
    else this.wantSelect = true;
    if (opts?.head) this.countOnly = true;
    return this;
  }
  insert(payload: unknown) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: unknown) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  upsert(payload: unknown) {
    this.op = "upsert";
    this.payload = payload;
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  neq(col: string, v: unknown) {
    this.filters.push((r) => r[col] !== v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  gte(col: string, v: string | number) {
    this.filters.push((r) => r[col] != null && (r[col] as string | number) >= v);
    return this;
  }
  lte(col: string, v: string | number) {
    this.filters.push((r) => r[col] != null && (r[col] as string | number) <= v);
    return this;
  }
  gt(col: string, v: string | number) {
    this.filters.push((r) => r[col] != null && (r[col] as string | number) > v);
    return this;
  }
  lt(col: string, v: string | number) {
    this.filters.push((r) => r[col] != null && (r[col] as string | number) < v);
    return this;
  }
  is(col: string, v: unknown) {
    this.filters.push((r) => (v === null ? r[col] == null : r[col] === v));
    return this;
  }
  not(col: string, _op: string, v: unknown) {
    this.filters.push((r) => (v === null ? r[col] != null : r[col] !== v));
    return this;
  }
  or() {
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.ordering = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  range(from: number, to: number) {
    this.max = to - from + 1;
    return this;
  }

  private matching(): Row[] {
    return this.db.rows(this.table).filter((r) => this.filters.every((f) => f(r)));
  }

  private exec(): { data: unknown; error: null; count: number | null } {
    const rows = this.db.rows(this.table);
    if (this.op === "insert" || this.op === "upsert") {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const out: Row[] = [];
      for (const it of items) {
        const existing = this.op === "upsert" ? rows.find((r) => (it.id && r.id === it.id) || (it.fingerprint && r.fingerprint === it.fingerprint && r.owner_id === it.owner_id)) : undefined;
        if (existing) {
          Object.assign(existing, it, { updated_at: new Date().toISOString() });
          out.push(existing);
        } else {
          const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...it };
          rows.push(row);
          out.push(row);
        }
      }
      this.db.writes.push({ table: this.table, op: this.op, payload: this.payload });
      return { data: this.wantSelect ? out : null, error: null, count: null };
    }
    if (this.op === "update") {
      const hit = this.matching();
      for (const r of hit) Object.assign(r, this.payload as Row, { updated_at: new Date().toISOString() });
      this.db.writes.push({ table: this.table, op: "update", payload: { patch: this.payload, matched: hit.length } });
      return { data: this.wantSelect ? hit : null, error: null, count: null };
    }
    if (this.op === "delete") {
      const hit = this.matching();
      this.db.tables.set(
        this.table,
        rows.filter((r) => !hit.includes(r)),
      );
      this.db.writes.push({ table: this.table, op: "delete", payload: { matched: hit.length } });
      return { data: null, error: null, count: null };
    }
    let hit = this.matching();
    if (this.ordering) {
      const { col, asc } = this.ordering;
      hit = [...hit].sort((a, b) => {
        const x = a[col] as string | number | null;
        const y = b[col] as string | number | null;
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (this.max != null) hit = hit.slice(0, this.max);
    return { data: this.countOnly ? null : hit.map((r) => ({ ...r })), error: null, count: hit.length };
  }

  async maybeSingle() {
    const res = this.exec();
    const arr = (res.data as Row[] | null) ?? [];
    return { data: arr[0] ?? null, error: null };
  }
  async single() {
    const res = this.exec();
    const arr = (res.data as Row[] | null) ?? [];
    return arr[0] ? { data: arr[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
  }
  then<T1 = unknown, T2 = never>(onfulfilled?: ((v: { data: unknown; error: null; count: number | null }) => T1 | PromiseLike<T1>) | null, onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null): PromiseLike<T1 | T2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected);
  }
}
