export class GoogleDatabase {
  constructor(sqlite, persist = () => {}) { this.sqlite = sqlite; this.persist = persist; this.batching = false; }
  prepare(sql) {
    const database = this;
    const execute = (params, mode, column) => {
      const statement = database.sqlite.prepare(sql);
      let rows;
      try {
        statement.bind(params.map(x => x === undefined ? null : x));
        rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
      } finally { statement.free(); }
      const changes = database.sqlite.getRowsModified();
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql) && !database.batching) database.persist(database.sqlite.export());
      if (mode === 'first') return column ? rows[0]?.[column] ?? null : rows[0] ?? null;
      return { results: rows, success: true, meta: { changes } };
    };
    const bound = params => ({
      sql, params,
      bind: (...values) => bound(values),
      first: column => execute(params, 'first', column),
      all: () => execute(params, 'all'),
      run: () => execute(params, 'run'),
    });
    return bound([]);
  }
  batch(statements) {
    if (this.batching) throw new Error('Nested transaction');
    this.sqlite.run('BEGIN');
    this.batching = true;
    let results;
    try {
      results = statements.map(s => s.run());
      this.sqlite.run('COMMIT');
    } catch (error) {
      this.sqlite.run('ROLLBACK');
      throw error;
    } finally { this.batching = false; }
    this.persist(this.sqlite.export());
    return results;
  }
}
