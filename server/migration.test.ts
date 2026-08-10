import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Verifies the additive tasks migration: a database created before due dates
// existed gains due_at and updated_at, with updated_at backfilled from
// created_at, and no rows lost.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'eisenhower-migration-test-'));
process.env.DATA_DIR = DATA_DIR;

const CREATED_AT = 1_700_000_000_000;

beforeAll(async () => {
  const legacy = new Database(path.join(DATA_DIR, 'tasks.db'));
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      quadrant TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  legacy.prepare('INSERT INTO users (id, email, created_at, last_login_at) VALUES (?, ?, ?, ?)')
    .run('user-1', 'legacy@example.com', CREATED_AT, CREATED_AT);
  legacy.prepare('INSERT INTO tasks (id, user_id, text, quadrant, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('11111111-1111-4111-8111-111111111111', 'user-1', 'legacy task', 'urgentImportant', CREATED_AT);
  legacy.close();

  // Importing db.js runs initializeSchema, and with it the migration
  await import('./db.js');
});

describe('tasks schema migration', () => {
  it('adds due_at and updated_at and backfills updated_at from created_at', () => {
    const db = new Database(path.join(DATA_DIR, 'tasks.db'), { readonly: true });
    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[])
      .map(c => c.name);
    expect(columns).toContain('due_at');
    expect(columns).toContain('updated_at');

    const row = db.prepare('SELECT text, created_at, updated_at, due_at FROM tasks WHERE id = ?')
      .get('11111111-1111-4111-8111-111111111111') as {
        text: string; created_at: number; updated_at: number; due_at: number | null;
      };
    expect(row.text).toBe('legacy task');
    expect(row.updated_at).toBe(CREATED_AT);
    expect(row.due_at).toBeNull();
    db.close();
  });
});
