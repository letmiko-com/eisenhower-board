import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Captured magic links and notifications from the mocked mailer
const mailbox = vi.hoisted(() => ({
  sent: [] as { to: string; link: string }[],
  notices: [] as { to: string }[],
}));

vi.mock('./mailer.js', () => ({
  isMailerConfigured: () => true,
  sendMagicLinkEmail: vi.fn(async (params: { to: string; link: string }) => {
    mailbox.sent.push({ to: params.to, link: params.link });
  }),
  sendEmailChangeVerification: vi.fn(async (params: { to: string; link: string }) => {
    mailbox.sent.push({ to: params.to, link: params.link });
  }),
  sendEmailChangedNotice: vi.fn(async (params: { to: string }) => {
    mailbox.notices.push({ to: params.to });
  }),
}));

// Environment must be set before the app module (and its db) is imported
const APP_ORIGIN = 'http://localhost:3080';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'eisenhower-api-test-'));
process.env.APP_BASE_URL = APP_ORIGIN;
process.env.TRUST_PROXY = '1';
process.env.ADMIN_EMAILS = 'admin@example.com';

let app: Express;

beforeAll(async () => {
  ({ app } = await import('./index.js'));
});

// Each request gets a distinct client IP so per-IP rate limiters never interfere
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function getSetCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown as string | string[] | undefined;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function cookiePair(res: request.Response, name: string): string {
  const cookie = getSetCookies(res).find((c) => c.startsWith(`${name}=`));
  expect(cookie, `expected Set-Cookie for ${name}`).toBeDefined();
  return cookie!.split(';')[0];
}

async function requestMagicLink(email: string): Promise<string> {
  const before = mailbox.sent.length;
  const res = await request(app)
    .post('/api/auth/magic-link')
    .set('X-Forwarded-For', nextIp())
    .send({ email });
  expect(res.status).toBe(200);
  expect(mailbox.sent.length).toBe(before + 1);
  return mailbox.sent[mailbox.sent.length - 1].link;
}

function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get('token') ?? '';
}

async function signIn(email: string): Promise<string> {
  const token = tokenFromLink(await requestMagicLink(email));
  const res = await request(app)
    .post('/api/auth/verify/consume')
    .set('X-Forwarded-For', nextIp())
    .set('Origin', APP_ORIGIN)
    .type('form')
    .send({ token });
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/');
  return cookiePair(res, 'eisenhower_session');
}

async function getCsrf(sessionCookie: string): Promise<{ cookies: string; token: string }> {
  const res = await request(app)
    .get('/api/csrf-token')
    .set('X-Forwarded-For', nextIp())
    .set('Cookie', sessionCookie);
  expect(res.status).toBe(200);
  const csrfCookie = cookiePair(res, 'eisenhower_csrf');
  return { cookies: `${sessionCookie}; ${csrfCookie}`, token: res.body.token as string };
}

interface AuthedClient {
  cookies: string;
  token: string;
}

async function signInWithCsrf(email: string): Promise<AuthedClient> {
  const sessionCookie = await signIn(email);
  return getCsrf(sessionCookie);
}

async function createTaskFor(client: AuthedClient, text: string): Promise<string> {
  const res = await request(app)
    .post('/api/tasks')
    .set('X-Forwarded-For', nextIp())
    .set('Cookie', client.cookies)
    .set('X-CSRF-Token', client.token)
    .send({ text, quadrant: 'urgentImportant' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('API: authentication required', () => {
  it('returns 401 on task routes without a session', async () => {
    const reads = [
      request(app).get('/api/tasks').set('X-Forwarded-For', nextIp()),
      request(app).get('/api/archived-tasks').set('X-Forwarded-For', nextIp()),
    ];
    for (const req of reads) {
      const res = await req;
      expect(res.status).toBe(401);
    }

    const post = await request(app)
      .post('/api/tasks')
      .set('X-Forwarded-For', nextIp())
      .send({ text: 'nope', quadrant: 'urgentImportant' });
    expect(post.status).toBe(401);

    const del = await request(app)
      .delete(`/api/tasks/${randomUUID()}`)
      .set('X-Forwarded-For', nextIp());
    expect(del.status).toBe(401);
  });
});

describe('API: magic link flow', () => {
  it('signs in end to end and creates a working session', async () => {
    const sessionCookie = await signIn('flow@example.com');

    const me = await request(app)
      .get('/api/auth/me')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', sessionCookie);
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.user.email).toBe('flow@example.com');
  });

  it('rejects reuse of a consumed magic-link token', async () => {
    const token = tokenFromLink(await requestMagicLink('reuse@example.com'));

    const first = await request(app)
      .post('/api/auth/verify/consume')
      .set('X-Forwarded-For', nextIp())
      .set('Origin', APP_ORIGIN)
      .type('form')
      .send({ token });
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/');

    const second = await request(app)
      .post('/api/auth/verify/consume')
      .set('X-Forwarded-For', nextIp())
      .set('Origin', APP_ORIGIN)
      .type('form')
      .send({ token });
    expect(second.status).toBe(302);
    expect(second.headers.location).toBe('/?auth=invalid');
  });

  it('re-issues the session cookie on authenticated requests (sliding maxAge)', async () => {
    const sessionCookie = await signIn('sliding@example.com');

    const res = await request(app)
      .get('/api/tasks')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    const reissued = getSetCookies(res).find((c) => c.startsWith('eisenhower_session='));
    expect(reissued).toBeDefined();
    expect(reissued).toMatch(/Max-Age=\d+/);
  });
});

describe('API: origin check on consume routes', () => {
  it('rejects magic-link consumption without Origin or Referer', async () => {
    const token = tokenFromLink(await requestMagicLink('no-origin@example.com'));
    const res = await request(app)
      .post('/api/auth/verify/consume')
      .set('X-Forwarded-For', nextIp())
      .type('form')
      .send({ token });
    expect(res.status).toBe(403);
  });

  it('rejects magic-link consumption from a foreign origin', async () => {
    const token = tokenFromLink(await requestMagicLink('bad-origin@example.com'));
    const res = await request(app)
      .post('/api/auth/verify/consume')
      .set('X-Forwarded-For', nextIp())
      .set('Origin', 'https://evil.example.com')
      .type('form')
      .send({ token });
    expect(res.status).toBe(403);

    // The token is still valid afterwards: the rejected attempt must not consume it
    const ok = await request(app)
      .post('/api/auth/verify/consume')
      .set('X-Forwarded-For', nextIp())
      .set('Origin', APP_ORIGIN)
      .type('form')
      .send({ token });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/');
  });

  it('accepts a matching Referer when Origin is absent', async () => {
    const token = tokenFromLink(await requestMagicLink('referer@example.com'));
    const res = await request(app)
      .post('/api/auth/verify/consume')
      .set('X-Forwarded-For', nextIp())
      .set('Referer', `${APP_ORIGIN}/api/auth/verify?token=x`)
      .type('form')
      .send({ token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('rejects email-change consumption from a foreign origin', async () => {
    const res = await request(app)
      .post('/api/account/verify-email/consume')
      .set('X-Forwarded-For', nextIp())
      .set('Origin', 'https://evil.example.com')
      .type('form')
      .send({ token: 'whatever' });
    expect(res.status).toBe(403);
  });
});

describe('API: CSRF protection', () => {
  it('rejects a mutation without CSRF token with code CSRF', async () => {
    const sessionCookie = await signIn('csrf@example.com');
    const res = await request(app)
      .post('/api/tasks')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', sessionCookie)
      .send({ text: 'no csrf', quadrant: 'urgentImportant' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF');
  });

  it('accepts a mutation with a valid CSRF token', async () => {
    const client = await signInWithCsrf('csrf-ok@example.com');
    const res = await request(app)
      .post('/api/tasks')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', client.cookies)
      .set('X-CSRF-Token', client.token)
      .send({ text: 'with csrf', quadrant: 'urgentImportant' });
    expect(res.status).toBe(201);
    expect(res.body.text).toBe('with csrf');
  });
});

describe('API: multi-user isolation', () => {
  it('prevents a user from reading or mutating tasks of another user', async () => {
    const alice = await signInWithCsrf('alice-iso@example.com');
    const bob = await signInWithCsrf('bob-iso@example.com');
    const aliceTaskId = await createTaskFor(alice, 'alice secret task');

    const bobRead = await request(app)
      .get('/api/tasks')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', bob.cookies);
    expect(bobRead.status).toBe(200);
    expect(JSON.stringify(bobRead.body)).not.toContain('alice secret task');

    const bobPatch = await request(app)
      .patch(`/api/tasks/${aliceTaskId}`)
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', bob.cookies)
      .set('X-CSRF-Token', bob.token)
      .send({ text: 'hijacked' });
    expect(bobPatch.status).toBe(404);

    const bobComplete = await request(app)
      .post(`/api/tasks/${aliceTaskId}/complete`)
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', bob.cookies)
      .set('X-CSRF-Token', bob.token);
    expect(bobComplete.status).toBe(404);

    const bobDelete = await request(app)
      .delete(`/api/tasks/${aliceTaskId}`)
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', bob.cookies)
      .set('X-CSRF-Token', bob.token);
    expect(bobDelete.status).toBe(404);

    // Alice still owns her intact task
    const aliceRead = await request(app)
      .get('/api/tasks')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', alice.cookies);
    expect(aliceRead.status).toBe(200);
    expect(JSON.stringify(aliceRead.body)).toContain('alice secret task');
  });
});

describe('API: session revocation validation', () => {
  it('rejects a non-UUID session id with 400', async () => {
    const client = await signInWithCsrf('sessions-uuid@example.com');
    const res = await request(app)
      .delete('/api/auth/sessions/not-a-uuid')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', client.cookies)
      .set('X-CSRF-Token', client.token);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid session ID');
  });
});

describe('API: email-only rate limit on magic links', () => {
  it('blocks the 6th request for the same email even from rotating IPs', async () => {
    const email = 'flood@example.com';

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/magic-link')
        .set('X-Forwarded-For', nextIp())
        .send({ email });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app)
      .post('/api/auth/magic-link')
      .set('X-Forwarded-For', nextIp())
      .send({ email });
    expect(blocked.status).toBe(429);

    // Another email from yet another IP is not affected
    const other = await request(app)
      .post('/api/auth/magic-link')
      .set('X-Forwarded-For', nextIp())
      .send({ email: 'not-flooded@example.com' });
    expect(other.status).toBe(200);
  });
});

describe('API: email change notification', () => {
  it('notifies the old address once the change is confirmed', async () => {
    const client = await signInWithCsrf('old-address@example.com');

    const ask = await request(app)
      .post('/api/account/change-email')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', client.cookies)
      .set('X-CSRF-Token', client.token)
      .send({ email: 'new-address@example.com' });
    expect(ask.status).toBe(200);

    const link = mailbox.sent[mailbox.sent.length - 1].link;
    expect(mailbox.sent[mailbox.sent.length - 1].to).toBe('new-address@example.com');

    const consume = await request(app)
      .post('/api/account/verify-email/consume')
      .set('X-Forwarded-For', nextIp())
      .set('Origin', APP_ORIGIN)
      .type('form')
      .send({ token: tokenFromLink(link) });
    expect(consume.status).toBe(302);
    expect(consume.headers.location).toBe('/?email-changed=true');

    expect(mailbox.notices).toContainEqual({ to: 'old-address@example.com' });
  });
});

describe('API: admin guard', () => {
  it('returns 403 for a non-admin user', async () => {
    const sessionCookie = await signIn('plain-user@example.com');
    const res = await request(app)
      .get('/api/admin/users')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(403);
  });

  it('allows an admin user', async () => {
    const sessionCookie = await signIn('admin@example.com');
    const res = await request(app)
      .get('/api/admin/users')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('users');
  });
});
