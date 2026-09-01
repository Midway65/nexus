import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  SchemaMigrator,
  type MigratableDatabase
} from '../../src/database/schema/SchemaMigrator';

interface ExecCall {
  sql: string;
  values: unknown[][];
}

interface RunCall {
  sql: string;
  params: unknown[] | undefined;
}

class FakeDatabase implements MigratableDatabase {
  readonly execCalls: ExecCall[] = [];
  readonly runCalls: RunCall[] = [];

  /** Map of normalized SQL prefix -> rows to return from exec(). */
  readonly execResponders: Array<{ match: RegExp; rows: unknown[][] }> = [];

  exec(sql: string): { values: unknown[][] }[] {
    const responder = this.execResponders.find(r => r.match.test(sql));
    const values = responder ? responder.rows : [];
    this.execCalls.push({ sql, values });
    return values.length > 0 ? [{ values }] : [{ values: [] }];
  }

  run(sql: string, params?: unknown[]): void {
    this.runCalls.push({ sql, params });
  }
}

// Fork-adjusted: upstream's migrations v12/v13/v14/v15/v16 were renumbered to
// v20/v21/v22/v23/v24 to satisfy the FORK MIGRATION NUMBERING CONVENTION (the
// fork's own stubs occupy v17-v19). Every numeric assertion here tracks the
// renumber; the DDL assertions are upstream's, unchanged. Upstream's own file
// is the same suite at their numbering, so a future merge conflicts on the
// numbers only -- take theirs, then reapply this mapping.
//
// The v23/v24 blocks (upstream v15/v16) were renumbered in the v5.18.2 merge.
// Note v24 is the first renumbered migration whose DDL is not pure
// `CREATE ... IF NOT EXISTS`: it carries a bare `ALTER TABLE ... ADD COLUMN`,
// so its additive-only assertion allows ADD COLUMN where the earlier ones do not.
describe('SchemaMigrator v19 -> v20 shard_cursors migration (upstream v12, renumbered for fork)', () => {
  it('declares CURRENT_SCHEMA_VERSION as 24', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(24);
  });

  it('includes a v20 migration with the shard_cursors DDL', () => {
    const v20 = MIGRATIONS.find(m => m.version === 20);
    expect(v20).toBeDefined();
    expect(v20!.description.toLowerCase()).toContain('shard_cursors');

    const joined = v20!.sql.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS shard_cursors');
    expect(joined).toContain('PRIMARY KEY (deviceId, shardPath)');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_shard_cursors_path');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_shard_cursors_kind');
  });

  it('uses additive-only DDL for v20 (no DROP / no RENAME / IF NOT EXISTS)', () => {
    const v20 = MIGRATIONS.find(m => m.version === 20)!;
    for (const sql of v20.sql) {
      const upper = sql.toUpperCase();
      expect(upper).not.toContain('DROP TABLE');
      expect(upper).not.toContain('DROP INDEX');
      expect(upper).not.toContain('ALTER TABLE');
      expect(upper).not.toContain('RENAME');
      expect(upper).toContain('IF NOT EXISTS');
    }
  });

  it('runs the v20 through v24 migrations when starting at v19', async () => {
    const db = new FakeDatabase();

    // Pretend schema_version table exists and currently reports v19.
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[19]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.fromVersion).toBe(19);
    expect(result.toVersion).toBe(24);
    expect(result.applied).toBe(5);

    const ddlRun = db.runCalls.map(c => c.sql).filter(s => /shard_cursors/.test(s));
    expect(ddlRun.some(s => /CREATE TABLE IF NOT EXISTS shard_cursors/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE INDEX IF NOT EXISTS idx_shard_cursors_path/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE INDEX IF NOT EXISTS idx_shard_cursors_kind/.test(s))).toBe(true);

    // Each applied version is stamped (setVersion runs per migration).
    for (const v of [20, 21, 22, 23, 24]) {
      const versionStamp = db.runCalls.find(
        c => /INSERT OR REPLACE INTO schema_version/.test(c.sql) &&
             Array.isArray(c.params) && c.params[0] === v
      );
      expect(versionStamp).toBeDefined();
    }
  });

  it('is a no-op when current version already equals CURRENT_SCHEMA_VERSION', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[24]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.applied).toBe(0);
    expect(result.fromVersion).toBe(24);
    expect(result.toVersion).toBe(24);
    expect(db.runCalls.find(c => /shard_cursors/.test(c.sql))).toBeUndefined();
  });
});

describe('SchemaMigrator v20 -> v21 skills migration (upstream v13, renumbered for fork)', () => {
  it('includes a v21 migration with the skills DDL', () => {
    const v21 = MIGRATIONS.find(m => m.version === 21);
    expect(v21).toBeDefined();
    expect(v21!.description.toLowerCase()).toContain('skills');

    const joined = v21!.sql.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS skills');
    expect(joined).toContain('UNIQUE(provider, name)');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_skills_name');
  });

  it('uses additive-only DDL for v21 (no DROP / no RENAME / IF NOT EXISTS)', () => {
    const v21 = MIGRATIONS.find(m => m.version === 21)!;
    for (const sql of v21.sql) {
      const upper = sql.toUpperCase();
      expect(upper).not.toContain('DROP TABLE');
      expect(upper).not.toContain('DROP INDEX');
      expect(upper).not.toContain('ALTER TABLE');
      expect(upper).not.toContain('RENAME');
      expect(upper).toContain('IF NOT EXISTS');
    }
  });

  it('runs the v21 migration and later migrations when starting at v20', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[20]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.fromVersion).toBe(20);
    expect(result.toVersion).toBe(24);
    expect(result.applied).toBe(4);

    const ddlRun = db.runCalls.map(c => c.sql).filter(s => /skills/.test(s));
    expect(ddlRun.some(s => /CREATE TABLE IF NOT EXISTS skills/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE INDEX IF NOT EXISTS idx_skills_name/.test(s))).toBe(true);
    // The earlier shard_cursors migration must NOT run when starting at v20.
    expect(db.runCalls.find(c => /shard_cursors/.test(c.sql))).toBeUndefined();

    const versionStamp = db.runCalls.find(
      c => /INSERT OR REPLACE INTO schema_version/.test(c.sql) &&
           Array.isArray(c.params) && c.params[0] === 21
    );
    expect(versionStamp).toBeDefined();
  });
});

describe('SchemaMigrator v21 -> v22 notes query index migration (upstream v14, renumbered for fork)', () => {
  it('includes a v22 migration with the notes + note_properties DDL', () => {
    const v22 = MIGRATIONS.find(m => m.version === 22);
    expect(v22).toBeDefined();
    expect(v22!.description.toLowerCase()).toContain('notes');

    const joined = v22!.sql.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS notes');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS note_properties');
    expect(joined).toContain('path TEXT NOT NULL UNIQUE');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_notes_folder');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_notes_mtime');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_np_key_text');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_np_key_num');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_np_note');
  });

  it('uses additive-only DDL for v22 (no DROP / no RENAME / IF NOT EXISTS)', () => {
    const v22 = MIGRATIONS.find(m => m.version === 22)!;
    for (const sql of v22.sql) {
      const upper = sql.toUpperCase();
      expect(upper).not.toContain('DROP TABLE');
      expect(upper).not.toContain('DROP INDEX');
      expect(upper).not.toContain('ALTER TABLE');
      expect(upper).not.toContain('RENAME');
      expect(upper).toContain('IF NOT EXISTS');
    }
  });

  it('runs the v22, v23 and v24 migrations when starting at v21', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[21]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.fromVersion).toBe(21);
    expect(result.toVersion).toBe(24);
    expect(result.applied).toBe(3);

    const ddlRun = db.runCalls.map(c => c.sql);
    expect(ddlRun.some(s => /CREATE TABLE IF NOT EXISTS notes\b/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE TABLE IF NOT EXISTS note_properties/.test(s))).toBe(true);
    expect(ddlRun.some(s => /ALTER TABLE states ADD COLUMN isArchived/.test(s))).toBe(true);
    // Earlier migrations must NOT re-run when starting at v21.
    expect(db.runCalls.find(c => /shard_cursors/.test(c.sql))).toBeUndefined();
    expect(db.runCalls.find(c => /CREATE TABLE IF NOT EXISTS skills/.test(c.sql))).toBeUndefined();
  });
});

describe('SchemaMigrator v22 -> v23 durable operation receipts migration (upstream v15, renumbered for fork)', () => {
  it('includes additive receipt table and index DDL', () => {
    const v23 = MIGRATIONS.find(m => m.version === 23);
    expect(v23).toBeDefined();
    expect(v23!.description.toLowerCase()).toContain('operation receipts');

    const joined = v23!.sql.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS tool_operation_receipts');
    expect(joined).toContain('operationId TEXT PRIMARY KEY');
    expect(joined).toContain('signature TEXT NOT NULL');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_tool_operation_workspace');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_tool_operation_status');

    for (const sql of v23!.sql) {
      const upper = sql.toUpperCase();
      expect(upper).not.toContain('DROP TABLE');
      expect(upper).not.toContain('DROP INDEX');
      expect(upper).not.toContain('ALTER TABLE');
      expect(upper).not.toContain('RENAME');
      expect(upper).toContain('IF NOT EXISTS');
    }
  });

  it('runs v23 and v24 when starting at v22', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[22]] }
    );

    const result = await new SchemaMigrator(db).migrate();

    expect(result).toMatchObject({ fromVersion: 22, toVersion: 24, applied: 2 });
    expect(db.runCalls.some(call => /CREATE TABLE IF NOT EXISTS tool_operation_receipts/.test(call.sql))).toBe(true);
    expect(db.runCalls.some(call => /CREATE TABLE IF NOT EXISTS notes\b/.test(call.sql))).toBe(false);
  });
});

describe('SchemaMigrator v23 -> v24 state archive flag migration (upstream v16, renumbered for fork)', () => {
  it('includes a v24 migration that adds states.isArchived and its index', () => {
    const v24 = MIGRATIONS.find(m => m.version === 24);
    expect(v24).toBeDefined();
    expect(v24!.description.toLowerCase()).toContain('isarchived');

    const joined = v24!.sql.join('\n');
    expect(joined).toContain('ALTER TABLE states ADD COLUMN isArchived INTEGER');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_states_archived');
  });

  it('adds the column WITHOUT a default so migrated rows stay unknown, not "not archived"', () => {
    // A `DEFAULT 0` would tell every already-archived state it is visible
    // again — the archive-visibility regression #218 fixed. NULL means
    // "unknown, read the content", which the read path still honours.
    const v24 = MIGRATIONS.find(m => m.version === 24)!;
    const alter = v24.sql.find(s => /ALTER TABLE states ADD COLUMN isArchived/i.test(s))!;
    expect(alter.toUpperCase()).not.toContain('DEFAULT');
  });

  it('uses additive-only DDL for v24 (ADD COLUMN / IF NOT EXISTS, no DROP or RENAME)', () => {
    const v24 = MIGRATIONS.find(m => m.version === 24)!;
    for (const sql of v24.sql) {
      const upper = sql.toUpperCase();
      expect(upper).not.toContain('DROP TABLE');
      expect(upper).not.toContain('DROP INDEX');
      expect(upper).not.toContain('RENAME');
      expect(/ADD COLUMN|IF NOT EXISTS/.test(upper)).toBe(true);
    }
  });

  it('runs only the v24 migration when starting at v23', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[23]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.fromVersion).toBe(23);
    expect(result.toVersion).toBe(24);
    expect(result.applied).toBe(1);

    const ddlRun = db.runCalls.map(c => c.sql);
    expect(ddlRun.some(s => /ALTER TABLE states ADD COLUMN isArchived/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE INDEX IF NOT EXISTS idx_states_archived/.test(s))).toBe(true);
    // Earlier migrations must NOT re-run.
    expect(db.runCalls.find(c => /CREATE TABLE IF NOT EXISTS notes\b/.test(c.sql))).toBeUndefined();
    expect(db.runCalls.find(c => /shard_cursors/.test(c.sql))).toBeUndefined();
    expect(db.runCalls.find(c => /tool_operation_receipts/.test(c.sql))).toBeUndefined();
  });

  it('backfills isArchived and the description fallback from cached stateJson', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[23]] },
      {
        match: /SELECT id, description, stateJson FROM states/i,
        rows: [
          // archived, no explicit description -> description comes from activeTask
          ['s-archived', null, JSON.stringify({
            context: { activeTask: 'Ship the migration' },
            state: { metadata: { isArchived: true } }
          })],
          // not archived, explicit description wins over activeTask
          ['s-live', 'Explicit description', JSON.stringify({
            context: { activeTask: 'Something else' },
            state: { metadata: { isArchived: false } }
          })],
          // unparseable content is skipped entirely (row stays unknown)
          ['s-broken', null, '{not json']
        ]
      }
    );

    const migrator = new SchemaMigrator(db);
    await migrator.migrate();

    const backfills = db.runCalls.filter(c => /UPDATE states SET isArchived/.test(c.sql));
    expect(backfills).toHaveLength(2);
    expect(backfills[0].params).toEqual([1, 'Ship the migration', 's-archived']);
    expect(backfills[1].params).toEqual([0, 'Explicit description', 's-live']);
    expect(backfills.find(c => Array.isArray(c.params) && c.params[2] === 's-broken')).toBeUndefined();
  });
});
