import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import type { Task, QuadrantKey, QuadrantsState, ArchivedTask, ArchivedTasksFilters } from '../shared/types.js';
import { configureSqlitePragmas } from './sqliteConfig.js';

const DEFAULT_DATA_DIR = process.env.NODE_ENV === 'production'
  ? '/app/data'
  : path.join(process.cwd(), 'data');
const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
const DB_PATH = path.join(DATA_DIR, 'tasks.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db = new Database(DB_PATH);

const { reopenedDb } = configureSqlitePragmas(db, {
  onWalCleanup() {
    db.close();
    for (const suffix of ['-wal', '-shm']) {
      const filePath = DB_PATH + suffix;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.warn(`[db] Removed stale ${filePath}`);
      }
    }
    return new Database(DB_PATH);
  },
});
if (reopenedDb) {
  db = reopenedDb as InstanceType<typeof Database>;
}

function tableExists(name: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name) as { name: string } | undefined;
  return !!row;
}

function tableHasColumns(name: string, expected: string[]): boolean {
  if (!tableExists(name)) {
    return false;
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name: ${name}`);
  }
  const columns = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
  const existing = new Set(columns.map(col => col.name));
  return expected.every(col => existing.has(col));
}

export function initializeSchema(): void {
  // Reset old single-user tasks table (no user_id) to align with new auth model.
  if (tableExists('tasks') && !tableHasColumns('tasks', [
    'id',
    'user_id',
    'text',
    'quadrant',
    'created_at',
    'completed_at',
  ])) {
    db.exec('DROP TABLE IF EXISTS tasks');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL,
      created_ip TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      quadrant TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_user_active ON tasks(user_id, completed_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_archived_user_completed ON tasks(user_id, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(session_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_magic_links_hash ON magic_links(token_hash);
    CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_change_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      new_email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_email_change_token ON email_change_requests(token_hash);
    CREATE INDEX IF NOT EXISTS idx_email_change_expires ON email_change_requests(expires_at);
  `);
}

export function resetDatabaseSchema(): void {
  db.exec(`
    DROP TABLE IF EXISTS email_change_requests;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS magic_links;
    DROP TABLE IF EXISTS users;
  `);
  initializeSchema();
}

initializeSchema();

// Pre-compile prepared statements for better performance
const stmts = {
  // Tasks
  getAllActive: db.prepare(
    'SELECT id, text, quadrant, created_at FROM tasks WHERE user_id = ? AND completed_at IS NULL ORDER BY created_at ASC'
  ),
  getArchived: db.prepare(
    'SELECT id, text, quadrant, created_at, completed_at FROM tasks WHERE user_id = ? AND completed_at IS NOT NULL ORDER BY completed_at DESC'
  ),
  getArchivedPaginated: db.prepare(
    'SELECT id, text, quadrant, created_at, completed_at FROM tasks WHERE user_id = ? AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT ? OFFSET ?'
  ),
  countArchived: db.prepare(
    'SELECT COUNT(*) as total FROM tasks WHERE user_id = ? AND completed_at IS NOT NULL'
  ),
  getById: db.prepare('SELECT id, user_id, text, quadrant, created_at, completed_at FROM tasks WHERE user_id = ? AND id = ?'),
  insert: db.prepare(
    'INSERT INTO tasks (id, user_id, text, quadrant, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  updateText: db.prepare(
    'UPDATE tasks SET text = ? WHERE user_id = ? AND id = ? AND completed_at IS NULL'
  ),
  updateQuadrant: db.prepare(
    'UPDATE tasks SET quadrant = ? WHERE user_id = ? AND id = ? AND completed_at IS NULL'
  ),
  complete: db.prepare(
    'UPDATE tasks SET completed_at = ? WHERE user_id = ? AND id = ? AND completed_at IS NULL'
  ),
  deleteById: db.prepare(
    'DELETE FROM tasks WHERE user_id = ? AND id = ? AND completed_at IS NULL'
  ),
  deleteArchived: db.prepare(
    'DELETE FROM tasks WHERE user_id = ? AND id = ? AND completed_at IS NOT NULL'
  ),
  restoreArchived: db.prepare(
    'UPDATE tasks SET completed_at = NULL WHERE user_id = ? AND id = ? AND completed_at IS NOT NULL'
  ),

  // Users
  getUserByEmail: db.prepare('SELECT id, email, created_at, last_login_at FROM users WHERE email = ?'),
  insertUser: db.prepare(
    'INSERT INTO users (id, email, created_at, last_login_at) VALUES (?, ?, ?, ?)'
  ),
  updateUserLastLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),

  // Magic links
  insertMagicLink: db.prepare(
    'INSERT INTO magic_links (id, user_id, token_hash, expires_at, used_at, created_at, created_ip) VALUES (?, ?, ?, ?, NULL, ?, ?)'
  ),
  getValidMagicLinkByHash: db.prepare(`
    SELECT ml.id, ml.user_id, u.email
    FROM magic_links ml
    JOIN users u ON u.id = ml.user_id
    WHERE ml.token_hash = ?
      AND ml.used_at IS NULL
      AND ml.expires_at > ?
  `),
  markMagicLinkUsed: db.prepare(
    'UPDATE magic_links SET used_at = ? WHERE id = ? AND used_at IS NULL'
  ),
  deleteExpiredMagicLinks: db.prepare(
    'DELETE FROM magic_links WHERE expires_at <= ? OR used_at IS NOT NULL'
  ),

  // Sessions
  insertSession: db.prepare(
    'INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  getActiveSessionByHash: db.prepare(`
    SELECT s.id AS session_id, s.user_id, s.expires_at, s.created_at, u.email
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.session_hash = ?
      AND s.expires_at > ?
  `),
  touchSession: db.prepare(
    'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?'
  ),
  deleteSessionById: db.prepare('DELETE FROM sessions WHERE id = ?'),
  deleteSessionByHash: db.prepare('DELETE FROM sessions WHERE session_hash = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  countSessionsByUser: db.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ?'),
  getOldestSessionsByUser: db.prepare(
    'SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at ASC LIMIT ?'
  ),
  getSessionsByUser: db.prepare(
    'SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC'
  ),
  deleteSessionsByIds: db.prepare(
    'DELETE FROM sessions WHERE id IN (SELECT value FROM json_each(?))'
  ),
  deleteOtherSessions: db.prepare(
    'DELETE FROM sessions WHERE user_id = ? AND id != ?'
  ),
  insertUserIgnore: db.prepare(
    'INSERT OR IGNORE INTO users (id, email, created_at, last_login_at) VALUES (?, ?, ?, ?)'
  ),

  // Admin
  getAllUsersWithTaskCount: db.prepare(`
    SELECT u.id, u.email, u.created_at, u.last_login_at, COUNT(t.id) as task_count
    FROM users u
    LEFT JOIN tasks t ON t.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `),
  countUsers: db.prepare('SELECT COUNT(*) as total FROM users'),
  getAdminStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM users WHERE last_login_at > ?) as active_users_30d
  `),
  getUserById: db.prepare('SELECT id, email, created_at, last_login_at FROM users WHERE id = ?'),
  deleteUserById: db.prepare('DELETE FROM users WHERE id = ?'),

  // Purge inactive users
  purgeInactiveUsers: db.prepare(
    'DELETE FROM users WHERE (last_login_at IS NOT NULL AND last_login_at < ?) OR (last_login_at IS NULL AND created_at < ?)'
  ),

  // Email change requests
  insertEmailChangeRequest: db.prepare(
    'INSERT INTO email_change_requests (id, user_id, new_email, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getValidEmailChangeByHash: db.prepare(`
    SELECT id, user_id, new_email
    FROM email_change_requests
    WHERE token_hash = ? AND expires_at > ?
  `),
  deleteEmailChangeRequest: db.prepare('DELETE FROM email_change_requests WHERE id = ?'),
  deleteEmailChangesByUser: db.prepare('DELETE FROM email_change_requests WHERE user_id = ?'),
  deleteExpiredEmailChangeRequests: db.prepare('DELETE FROM email_change_requests WHERE expires_at <= ?'),
  updateUserEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
} as const;

export interface DbTask {
  id: string;
  user_id: string;
  text: string;
  quadrant: string;
  created_at: number;
  completed_at: number | null;
}

export interface DbUser {
  id: string;
  email: string;
  created_at: number;
  last_login_at: number | null;
}

interface ValidMagicLinkRow {
  id: string;
  user_id: string;
  email: string;
}

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  expiresAt: number;
  createdAt: number;
}

export interface CleanupResult {
  deletedMagicLinks: number;
  deletedSessions: number;
  deletedEmailChanges: number;
  purgedUsers: number;
}

export interface CreateSessionParams {
  sessionId: string;
  userId: string;
  sessionHash: string;
  expiresAt: number;
  createdAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface CreateMagicLinkParams {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
  createdIp: string | null;
}

export interface ConsumedMagicLink {
  userId: string;
  email: string;
}

const consumeMagicLinkTx = db.transaction((tokenHash: string, now: number): ConsumedMagicLink | null => {
  const magicLink = stmts.getValidMagicLinkByHash.get(tokenHash, now) as ValidMagicLinkRow | undefined;
  if (!magicLink) {
    return null;
  }

  const updateResult = stmts.markMagicLinkUsed.run(now, magicLink.id);
  if (updateResult.changes === 0) {
    return null;
  }

  stmts.updateUserLastLogin.run(now, magicLink.user_id);
  return {
    userId: magicLink.user_id,
    email: magicLink.email,
  };
});

// Re-export types for convenience
export type { Task, QuadrantKey, QuadrantsState, ArchivedTask, ArchivedTasksFilters };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const findOrCreateUserTx = db.transaction((email: string, now: number): { id: string; email: string } => {
  const normalized = normalizeEmail(email);
  const existing = stmts.getUserByEmail.get(normalized) as DbUser | undefined;
  if (existing) {
    return { id: existing.id, email: existing.email };
  }

  const id = randomUUID();
  stmts.insertUserIgnore.run(id, normalized, now, null);
  const created = stmts.getUserByEmail.get(normalized) as DbUser | undefined;
  if (!created) {
    throw new Error('Failed to create user');
  }
  return { id: created.id, email: created.email };
});

export function findOrCreateUserByEmail(email: string, now: number): { id: string; email: string } {
  return findOrCreateUserTx(email, now);
}

export function createMagicLink(params: CreateMagicLinkParams): void {
  stmts.insertMagicLink.run(
    params.id,
    params.userId,
    params.tokenHash,
    params.expiresAt,
    params.createdAt,
    params.createdIp
  );
}

export function consumeMagicLink(tokenHash: string, now: number): ConsumedMagicLink | null {
  return consumeMagicLinkTx(tokenHash, now);
}

const MAX_SESSIONS_PER_USER = 10;

const createSessionTx = db.transaction((params: CreateSessionParams): void => {
  const { count } = stmts.countSessionsByUser.get(params.userId) as { count: number };
  if (count >= MAX_SESSIONS_PER_USER) {
    const excess = count - MAX_SESSIONS_PER_USER + 1;
    const oldSessions = stmts.getOldestSessionsByUser.all(params.userId, excess) as { id: string }[];
    const ids = oldSessions.map(s => s.id);
    stmts.deleteSessionsByIds.run(JSON.stringify(ids));
  }
  stmts.insertSession.run(
    params.sessionId,
    params.userId,
    params.sessionHash,
    params.expiresAt,
    params.createdAt,
    params.createdAt,
    params.ip,
    params.userAgent
  );
});

export function createSession(params: CreateSessionParams): void {
  createSessionTx(params);
}

export function getSessionByHash(sessionHash: string, now: number): SessionUser | null {
  const row = stmts.getActiveSessionByHash.get(sessionHash, now) as {
    session_id: string;
    user_id: string;
    email: string;
    expires_at: number;
    created_at: number;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function touchSession(sessionId: string, lastSeenAt: number, expiresAt: number): void {
  stmts.touchSession.run(lastSeenAt, expiresAt, sessionId);
}

export function deleteSessionById(sessionId: string): void {
  stmts.deleteSessionById.run(sessionId);
}

export function deleteSessionByHash(sessionHash: string): void {
  stmts.deleteSessionByHash.run(sessionHash);
}

export interface ActiveSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
}

export function getActiveSessionsByUser(userId: string, now: number): ActiveSession[] {
  const rows = stmts.getSessionsByUser.all(userId, now) as {
    id: string;
    created_at: number;
    last_seen_at: number;
    ip: string | null;
    user_agent: string | null;
  }[];
  return rows.map(r => ({
    id: r.id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    ip: r.ip,
    userAgent: r.user_agent,
  }));
}

export function revokeSessionById(userId: string, sessionId: string): boolean {
  const sessions = stmts.getSessionsByUser.all(userId, 0) as { id: string }[];
  if (!sessions.some(s => s.id === sessionId)) {
    return false;
  }
  stmts.deleteSessionById.run(sessionId);
  return true;
}

export function revokeOtherSessions(userId: string, currentSessionId: string): number {
  return stmts.deleteOtherSessions.run(userId, currentSessionId).changes;
}

const INACTIVE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function cleanupExpiredAuth(now: number): CleanupResult {
  const deletedMagicLinks = stmts.deleteExpiredMagicLinks.run(now).changes;
  const deletedSessions = stmts.deleteExpiredSessions.run(now).changes;
  const deletedEmailChanges = stmts.deleteExpiredEmailChangeRequests.run(now).changes;

  const threshold = now - INACTIVE_THRESHOLD_MS;
  const purgedUsers = stmts.purgeInactiveUsers.run(threshold, threshold).changes;
  if (purgedUsers > 0) {
    console.log(`[cleanup] Purged ${purgedUsers} inactive user(s)`);
  }

  return { deletedMagicLinks, deletedSessions, deletedEmailChanges, purgedUsers };
}

// --- Admin ---

export interface AdminUser {
  id: string;
  email: string;
  createdAt: number;
  lastLoginAt: number | null;
  taskCount: number;
}

export interface PaginatedAdminUsers {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export function getAllUsersWithTaskCount(page: number = 1, pageSize: number = 50): PaginatedAdminUsers {
  const offset = (page - 1) * pageSize;
  const rows = stmts.getAllUsersWithTaskCount.all(pageSize, offset) as {
    id: string;
    email: string;
    created_at: number;
    last_login_at: number | null;
    task_count: number;
  }[];
  const { total } = stmts.countUsers.get() as { total: number };
  return {
    users: rows.map(r => ({
      id: r.id,
      email: r.email,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      taskCount: r.task_count,
    })),
    total,
    page,
    pageSize,
  };
}

export function getAdminStats(activeThreshold: number): { totalUsers: number; activeUsers30d: number } {
  const row = stmts.getAdminStats.get(activeThreshold) as {
    total_users: number;
    active_users_30d: number;
  };
  return { totalUsers: row.total_users, activeUsers30d: row.active_users_30d };
}

export function getUserById(userId: string): DbUser | undefined {
  return stmts.getUserById.get(userId) as DbUser | undefined;
}

export function deleteUserById(userId: string): boolean {
  return stmts.deleteUserById.run(userId).changes > 0;
}

// --- Email change ---

export interface CreateEmailChangeParams {
  id: string;
  userId: string;
  newEmail: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
}

export interface ConsumedEmailChange {
  userId: string;
  oldEmail: string;
  newEmail: string;
}

export function createEmailChangeRequest(params: CreateEmailChangeParams): void {
  stmts.deleteEmailChangesByUser.run(params.userId);
  stmts.insertEmailChangeRequest.run(
    params.id,
    params.userId,
    params.newEmail,
    params.tokenHash,
    params.expiresAt,
    params.createdAt
  );
}

const consumeEmailChangeTx = db.transaction((tokenHash: string, now: number): ConsumedEmailChange | null => {
  const row = stmts.getValidEmailChangeByHash.get(tokenHash, now) as {
    id: string;
    user_id: string;
    new_email: string;
  } | undefined;
  if (!row) return null;

  const existing = stmts.getUserByEmail.get(row.new_email) as DbUser | undefined;
  if (existing && existing.id !== row.user_id) return null;

  const currentUser = stmts.getUserById.get(row.user_id) as DbUser | undefined;
  if (!currentUser) return null;

  stmts.updateUserEmail.run(row.new_email, row.user_id);
  stmts.deleteEmailChangesByUser.run(row.user_id);

  return { userId: row.user_id, oldEmail: currentUser.email, newEmail: row.new_email };
});

export function consumeEmailChange(tokenHash: string, now: number): ConsumedEmailChange | null {
  return consumeEmailChangeTx(tokenHash, now);
}

// Get all active tasks (not completed) grouped by quadrant
export function getAllTasks(userId: string): QuadrantsState {
  const rows = stmts.getAllActive.all(userId) as DbTask[];

  const result: QuadrantsState = {
    urgentImportant: [],
    notUrgentImportant: [],
    urgentNotImportant: [],
    notUrgentNotImportant: [],
  };

  for (const row of rows) {
    const quadrant = row.quadrant as QuadrantKey;
    if (result[quadrant]) {
      result[quadrant].push({
        id: row.id,
        text: row.text,
        createdAt: row.created_at,
      });
    }
  }

  return result;
}

export function getArchivedTasks(userId: string): ArchivedTask[] {
  const rows = stmts.getArchived.all(userId) as DbTask[];

  return rows.map(row => ({
    id: row.id,
    text: row.text,
    createdAt: row.created_at,
    completedAt: row.completed_at!,
    quadrant: row.quadrant as QuadrantKey,
  }));
}

export interface PaginatedArchivedTasks {
  tasks: ArchivedTask[];
  total: number;
  page: number;
  pageSize: number;
}

function buildArchivedFilters(filters: ArchivedTasksFilters): {
  whereSql: string;
  params: (string | number)[];
} {
  const conditions = ['user_id = ?', 'completed_at IS NOT NULL'];
  const params: (string | number)[] = [];

  if (filters.q) {
    // Escape LIKE wildcards so user input is matched literally
    const escaped = filters.q.replace(/[\\%_]/g, '\\$&');
    conditions.push("text LIKE ? ESCAPE '\\'");
    params.push(`%${escaped}%`);
  }
  if (filters.quadrant) {
    conditions.push('quadrant = ?');
    params.push(filters.quadrant);
  }
  if (filters.from !== undefined) {
    conditions.push('completed_at >= ?');
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    conditions.push('completed_at <= ?');
    params.push(filters.to);
  }

  return {
    whereSql: conditions.join(' AND '),
    params,
  };
}

export function getArchivedTasksPaginated(
  userId: string,
  page: number,
  pageSize: number,
  filters: ArchivedTasksFilters = {},
): PaginatedArchivedTasks {
  const offset = (page - 1) * pageSize;
  const { whereSql, params } = buildArchivedFilters(filters);

  const rows = db
    .prepare(
      `SELECT id, text, quadrant, created_at, completed_at
       FROM tasks
       WHERE ${whereSql}
       ORDER BY completed_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(userId, ...params, pageSize, offset) as DbTask[];

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM tasks WHERE ${whereSql}`)
    .get(userId, ...params) as { total: number };

  return {
    tasks: rows.map(row => ({
      id: row.id,
      text: row.text,
      createdAt: row.created_at,
      completedAt: row.completed_at!,
      quadrant: row.quadrant as QuadrantKey,
    })),
    total: countRow.total,
    page,
    pageSize,
  };
}

// Complete a task (archive it)
export function completeTask(userId: string, id: string): boolean {
  const result = stmts.complete.run(Date.now(), userId, id);
  return result.changes > 0;
}

// Delete an archived task permanently
export function deleteArchivedTask(userId: string, id: string): boolean {
  const result = stmts.deleteArchived.run(userId, id);
  return result.changes > 0;
}

export function restoreArchivedTask(userId: string, id: string): boolean {
  const result = stmts.restoreArchived.run(userId, id);
  return result.changes > 0;
}

// Create a new task
export function createTask(userId: string, id: string, text: string, quadrant: QuadrantKey, createdAt: number): Task {
  stmts.insert.run(id, userId, text, quadrant, createdAt);
  return { id, text, createdAt };
}

// Update task text
export function updateTaskText(userId: string, id: string, text: string): boolean {
  const result = stmts.updateText.run(text, userId, id);
  return result.changes > 0;
}

// Update task quadrant (move task)
export function updateTaskQuadrant(userId: string, id: string, quadrant: QuadrantKey): boolean {
  const result = stmts.updateQuadrant.run(quadrant, userId, id);
  return result.changes > 0;
}

// Delete a task
export function deleteTask(userId: string, id: string): boolean {
  const result = stmts.deleteById.run(userId, id);
  return result.changes > 0;
}

// Get a single task
export function getTask(userId: string, id: string): DbTask | undefined {
  return stmts.getById.get(userId, id) as DbTask | undefined;
}

export default db;
