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

// Fork-adjusted: upstream's v12 shard_cursors migration was renumbered to v20,
// their v13 skills migration to v21, and their v14 notes-query-index migration
// to v22, to satisfy the FORK MIGRATION NUMBERING CONVENTION (fork's local stubs
// occupy v17–v19). Numeric assertions here track the renumber. To isolate the
// renumbered migration in the "starting from prior version" tests we seed at the
// prior fork version instead of upstream's baseline.
describe('SchemaMigrator v19 -> v20 shard_cursors migration (upstream v12, renumbered for fork)', () => {
  it('declares CURRENT_SCHEMA_VERSION as 22', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(22);
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

  it('runs v20 + v21 + v22 migrations when starting at v19', async () => {
    const db = new FakeDatabase();

    // Pretend schema_version table exists and currently reports v19.
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[19]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.fromVersion).toBe(19);
    expect(result.toVersion).toBe(22);
    expect(result.applied).toBe(3);

    const ddlRun = db.runCalls.map(c => c.sql).filter(s => /shard_cursors/.test(s));
    expect(ddlRun.some(s => /CREATE TABLE IF NOT EXISTS shard_cursors/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE INDEX IF NOT EXISTS idx_shard_cursors_path/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE INDEX IF NOT EXISTS idx_shard_cursors_kind/.test(s))).toBe(true);

    // Each applied version is stamped (setVersion runs per migration).
    for (const v of [20, 21, 22]) {
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
      { match: /MAX\(version\)/i, rows: [[22]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.applied).toBe(0);
    expect(result.fromVersion).toBe(22);
    expect(result.toVersion).toBe(22);
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

  it('runs the v21 migration (and the later v22) when starting at v20', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[20]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.fromVersion).toBe(20);
    expect(result.toVersion).toBe(22);
    expect(result.applied).toBe(2);

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

  it('runs only the v22 migration when starting at v21', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[21]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.fromVersion).toBe(21);
    expect(result.toVersion).toBe(22);
    expect(result.applied).toBe(1);

    const ddlRun = db.runCalls.map(c => c.sql);
    expect(ddlRun.some(s => /CREATE TABLE IF NOT EXISTS notes\b/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE TABLE IF NOT EXISTS note_properties/.test(s))).toBe(true);
    // Earlier migrations must NOT re-run when starting at v21.
    expect(db.runCalls.find(c => /shard_cursors/.test(c.sql))).toBeUndefined();
    expect(db.runCalls.find(c => /CREATE TABLE IF NOT EXISTS skills/.test(c.sql))).toBeUndefined();
  });
});
