import * as Sentry from '@sentry/node';
import express, { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import db, {
  getAllTasks,
  createTask,
  updateTaskText,
  updateTaskQuadrant,
  deleteTask,
  completeTask,
  getArchivedTasksPaginated,
  deleteArchivedTask,
  restoreArchivedTask,
  findOrCreateUserByEmail,
  createMagicLink,
  consumeMagicLink,
  createSession,
  getSessionByHash,
  touchSession,
  deleteSessionByHash,
  deleteSessionById,
  getActiveSessionsByUser,
  revokeSessionById,
  revokeOtherSessions,
  cleanupExpiredAuth,
  normalizeEmail,
  getAllUsersWithTaskCount,
  getAdminStats,
  deleteUserById,
  getUserById,
  createEmailChangeRequest,
  consumeEmailChange,
} from './db.js';
import { sendMagicLinkEmail, sendEmailChangeVerification, sendEmailChangedNotice, isMailerConfigured } from './mailer.js';
import { sanitizeText } from '../shared/sanitize.js';
import {
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
  TaskIdSchema,
  UserIdSchema,
  MagicLinkRequestSchema,
  ChangeEmailRequestSchema,
  SessionIdSchema,
  TaskBatchRequestSchema,
  ArchivedTasksQuerySchema,
} from '../shared/validation.js';

export const app = express();

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

const PORT = process.env.PORT || 3080;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days absolute max
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const EMAIL_CHANGE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_COOKIE_NAME = isProduction ? '__Host-eisenhower_session' : 'eisenhower_session';
const CSRF_COOKIE_NAME = isProduction ? '__Host-eisenhower_csrf' : 'eisenhower_csrf';

const trustProxySetting = process.env.TRUST_PROXY?.trim();
if (trustProxySetting && trustProxySetting.toLowerCase() !== 'false') {
  if (trustProxySetting.toLowerCase() === 'true') {
    app.set('trust proxy', true);
  } else if (/^\d+$/.test(trustProxySetting)) {
    app.set('trust proxy', Number(trustProxySetting));
  } else {
    app.set('trust proxy', trustProxySetting);
  }
}

interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
}

// --- Admin configuration ---
const ADMIN_EMAILS: Set<string> = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
);

function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.has(email.toLowerCase());
}

const SUPPORTED_LANGUAGES = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'zh', 'hi', 'ar', 'bn'] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

const SIGN_IN_CONFIRM_COPY: Record<SupportedLanguage, {
  title: string;
  description: string;
  action: string;
}> = {
  en: {
    title: 'Confirm sign in',
    description: 'Click the button below to complete sign in.',
    action: 'Sign in',
  },
  fr: {
    title: 'Confirmer la connexion',
    description: 'Cliquez sur le bouton ci-dessous pour terminer la connexion.',
    action: 'Se connecter',
  },
  de: {
    title: 'Anmeldung bestätigen',
    description: 'Klicken Sie auf die Schaltfläche unten, um die Anmeldung abzuschließen.',
    action: 'Anmelden',
  },
  es: {
    title: 'Confirmar inicio de sesión',
    description: 'Haz clic en el botón de abajo para completar el inicio de sesión.',
    action: 'Iniciar sesión',
  },
  it: {
    title: 'Conferma accesso',
    description: 'Fai clic sul pulsante qui sotto per completare l’accesso.',
    action: 'Accedi',
  },
  pt: {
    title: 'Confirmar login',
    description: 'Clique no botão abaixo para concluir o login.',
    action: 'Entrar',
  },
  nl: {
    title: 'Inloggen bevestigen',
    description: 'Klik op de knop hieronder om het inloggen te voltooien.',
    action: 'Inloggen',
  },
  pl: {
    title: 'Potwierdź logowanie',
    description: 'Kliknij przycisk poniżej, aby dokończyć logowanie.',
    action: 'Zaloguj się',
  },
  ru: {
    title: 'Подтвердите вход',
    description: 'Нажмите кнопку ниже, чтобы завершить вход.',
    action: 'Войти',
  },
  uk: {
    title: 'Підтвердьте вхід',
    description: 'Натисніть кнопку нижче, щоб завершити вхід.',
    action: 'Увійти',
  },
  zh: {
    title: '确认登录',
    description: '点击下方按钮以完成登录。',
    action: '登录',
  },
  hi: {
    title: 'साइन इन की पुष्टि करें',
    description: 'साइन इन पूरा करने के लिए नीचे दिए गए बटन पर क्लिक करें।',
    action: 'साइन इन करें',
  },
  ar: {
    title: 'تأكيد تسجيل الدخول',
    description: 'اضغط على الزر أدناه لإكمال تسجيل الدخول.',
    action: 'تسجيل الدخول',
  },
  bn: {
    title: 'সাইন-ইন নিশ্চিত করুন',
    description: 'সাইন-ইন সম্পূর্ণ করতে নিচের বোতামে ক্লিক করুন।',
    action: 'সাইন ইন করুন',
  },
};

const EMAIL_CHANGE_CONFIRM_COPY: Record<SupportedLanguage, {
  title: string;
  description: string;
  action: string;
}> = {
  en: { title: 'Confirm email change', description: 'Click the button below to confirm your new email address.', action: 'Confirm' },
  fr: { title: 'Confirmer le changement d\u2019email', description: 'Cliquez sur le bouton ci-dessous pour confirmer votre nouvelle adresse email.', action: 'Confirmer' },
  de: { title: 'E-Mail-Änderung bestätigen', description: 'Klicken Sie auf die Schaltfläche unten, um Ihre neue E-Mail-Adresse zu bestätigen.', action: 'Bestätigen' },
  es: { title: 'Confirmar cambio de correo', description: 'Haz clic en el botón de abajo para confirmar tu nueva dirección de correo.', action: 'Confirmar' },
  it: { title: 'Conferma cambio email', description: 'Fai clic sul pulsante qui sotto per confermare il tuo nuovo indirizzo email.', action: 'Conferma' },
  pt: { title: 'Confirmar alteração de email', description: 'Clique no botão abaixo para confirmar seu novo endereço de email.', action: 'Confirmar' },
  nl: { title: 'E-mailwijziging bevestigen', description: 'Klik op de knop hieronder om uw nieuwe e-mailadres te bevestigen.', action: 'Bevestigen' },
  pl: { title: 'Potwierdź zmianę e-maila', description: 'Kliknij przycisk poniżej, aby potwierdzić nowy adres e-mail.', action: 'Potwierdź' },
  ru: { title: 'Подтвердите смену почты', description: 'Нажмите кнопку ниже, чтобы подтвердить новый адрес электронной почты.', action: 'Подтвердить' },
  uk: { title: 'Підтвердіть зміну пошти', description: 'Натисніть кнопку нижче, щоб підтвердити нову адресу електронної пошти.', action: 'Підтвердити' },
  zh: { title: '确认更改邮箱', description: '点击下方按钮以确认您的新邮箱地址。', action: '确认' },
  hi: { title: 'ईमेल परिवर्तन की पुष्टि करें', description: 'अपना नया ईमेल पता पुष्टि करने के लिए नीचे दिए गए बटन पर क्लिक करें।', action: 'पुष्टि करें' },
  ar: { title: 'تأكيد تغيير البريد الإلكتروني', description: 'اضغط على الزر أدناه لتأكيد عنوان بريدك الإلكتروني الجديد.', action: 'تأكيد' },
  bn: { title: 'ইমেল পরিবর্তন নিশ্চিত করুন', description: 'আপনার নতুন ইমেল ঠিকানা নিশ্চিত করতে নিচের বোতামে ক্লিক করুন।', action: 'নিশ্চিত করুন' },
};

function getPreferredLanguage(header?: string): SupportedLanguage {
  if (!header) {
    return 'en';
  }

  const languages = header.split(',');
  for (const entry of languages) {
    const [tag] = entry.trim().split(';');
    const base = tag.toLowerCase().split('-')[0];
    if ((SUPPORTED_LANGUAGES as readonly string[]).includes(base)) {
      return base as SupportedLanguage;
    }
  }

  return 'en';
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader.split(';').reduce<Record<string, string>>((acc, part) => {
    const [key, ...valueParts] = part.trim().split('=');
    if (!key || valueParts.length === 0) {
      return acc;
    }
    const rawValue = valueParts.join('=');
    try {
      acc[key] = decodeURIComponent(rawValue);
    } catch {
      acc[key] = rawValue;
    }
    return acc;
  }, {});
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
  });
  res.clearCookie(CSRF_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
  });
}

function getAppBaseUrl(): string {
  const configuredBaseUrl = process.env.APP_BASE_URL?.trim();
  if (!configuredBaseUrl) {
    throw new Error('APP_BASE_URL environment variable is required');
  }
  return configuredBaseUrl.replace(/\/+$/, '');
}

function logSecurityEvent(event: string, metadata: Record<string, unknown>): void {
  console.warn(`[security] ${event}`, metadata);
}

function setAuthCookies(res: Response, rawSessionToken: string): void {
  res.cookie(SESSION_COOKIE_NAME, rawSessionToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });

  const csrfToken = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

function makeEtag(payload: unknown): string {
  const digest = createHash('sha1').update(JSON.stringify(payload)).digest('base64url');
  return `"${digest}"`;
}

function hasMatchingEtag(req: Request, etag: string): boolean {
  const ifNoneMatch = req.headers['if-none-match'];
  if (!ifNoneMatch) {
    return false;
  }
  const values = ifNoneMatch.split(',').map((v) => v.trim());
  return values.includes(etag) || values.includes('*');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function authenticateSession(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const rawSessionToken = cookies[SESSION_COOKIE_NAME];
  if (!rawSessionToken) {
    next();
    return;
  }

  const sessionHash = hashToken(rawSessionToken);
  const now = Date.now();
  const session = getSessionByHash(sessionHash, now);
  if (!session) {
    deleteSessionByHash(sessionHash);
    clearAuthCookies(res);
    next();
    return;
  }

  if (now - session.createdAt > SESSION_ABSOLUTE_TTL_MS) {
    deleteSessionById(session.sessionId);
    clearAuthCookies(res);
    next();
    return;
  }

  const refreshedExpiry = now + SESSION_TTL_MS;
  touchSession(session.sessionId, now, refreshedExpiry);
  // Re-issue the session cookie so its maxAge follows the sliding server-side
  // expiry, capped by the absolute session lifetime
  res.cookie(SESSION_COOKIE_NAME, rawSessionToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.min(SESSION_TTL_MS, session.createdAt + SESSION_ABSOLUTE_TTL_MS - now),
  });
  req.auth = {
    sessionId: session.sessionId,
    userId: session.userId,
    email: session.email,
  };
  next();
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth || !isAdmin(req.auth.email)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

function validateCsrf(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-csrf-token'];
  const csrfHeader = Array.isArray(header) ? header[0] : header;
  const cookies = parseCookies(req.headers.cookie);
  const csrfCookie = cookies[CSRF_COOKIE_NAME];

  if (!csrfHeader || !csrfCookie || !safeTokenEquals(csrfHeader, csrfCookie)) {
    logSecurityEvent('csrf_validation_failed', {
      ip: req.ip ?? null,
      path: req.originalUrl,
      hasHeader: Boolean(csrfHeader),
      hasCookie: Boolean(csrfCookie),
      userId: req.auth?.userId ?? null,
    });
    res.status(403).json({ error: 'Invalid or missing CSRF token', code: 'CSRF' });
    return;
  }

  next();
}

// Validate that browser-issued requests come from the configured app origin.
// Applied to magic-link consumption routes, which cannot carry a CSRF token.
function requireTrustedOrigin(req: Request, res: Response, next: NextFunction): void {
  const baseUrl = process.env.APP_BASE_URL?.trim();
  if (!baseUrl) {
    next();
    return;
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(baseUrl).origin;
  } catch {
    next();
    return;
  }

  const originHeader = req.get('origin');
  const refererHeader = req.get('referer');
  let requestOrigin: string | null = null;
  if (originHeader) {
    requestOrigin = originHeader;
  } else if (refererHeader) {
    try {
      requestOrigin = new URL(refererHeader).origin;
    } catch {
      requestOrigin = null;
    }
  }

  if (requestOrigin !== expectedOrigin) {
    logSecurityEvent('origin_validation_failed', {
      ip: req.ip ?? null,
      path: req.originalUrl,
      origin: requestOrigin,
    });
    res.status(403).json({ error: 'Invalid request origin' });
    return;
  }

  next();
}

app.use(compression());
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
  );
  next();
});

// Middleware
// The batch route accepts up to 100 operations, which can exceed the global
// 10kb JSON limit, so it gets a dedicated parser with a higher limit.
const jsonParser = express.json({ limit: '10kb' });
const batchJsonParser = express.json({ limit: '64kb' });
app.use((req: Request, res: Response, next: NextFunction) => {
  const parser = req.path === '/api/tasks/batch' ? batchJsonParser : jsonParser;
  parser(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', authenticateSession);

// Cleanup expired auth artifacts every 15 minutes
setInterval(() => {
  cleanupExpiredAuth(Date.now());
}, 15 * 60 * 1000).unref();

function createRateLimiter(
  name: string,
  max: number,
  windowMs = 60 * 1000,
  keyGenerator?: (req: Request) => string,
) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: (req, res) => {
      logSecurityEvent('rate_limit_exceeded', {
        limiter: name,
        ip: req.ip ?? null,
        path: req.originalUrl,
        userId: req.auth?.userId ?? null,
      });
      res.status(429).json({ error: 'Too many requests, please try again later' });
    },
  });
}

const mutationLimiter = createRateLimiter('mutation', 30);
const readLimiter = createRateLimiter('read', 60);
const csrfLimiter = createRateLimiter('csrf', 20);
const magicLinkIpLimiter = createRateLimiter('magic_link_ip', 5);
const magicLinkEmailLimiter = createRateLimiter('magic_link_email', 3, 60 * 1000, (req) => {
  const ip = ipKeyGenerator(req.ip ?? '');
  const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
  return `${ip}:${email || 'unknown'}`;
});
// Keyed on the email alone: blocks distributed attempts that rotate IPs
const magicLinkEmailOnlyLimiter = createRateLimiter('magic_link_email_only', 5, 60 * 60 * 1000, (req) => {
  const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
  return email ? `email:${email}` : ipKeyGenerator(req.ip ?? '');
});
const verifyLimiter = createRateLimiter('verify', 10);
const adminReadLimiter = createRateLimiter('admin_read', 30);
const adminMutationLimiter = createRateLimiter('admin_mutation', 10);
const accountMutationLimiter = createRateLimiter('account_mutation', 5);
const emailChangeLimiter = createRateLimiter('email_change', 3, 15 * 60 * 1000);

// Serve static files from the dist directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, '..', '..', 'dist');
app.use('/assets', express.static(path.join(distPath, 'assets'), {
  maxAge: '1y',
  immutable: true,
}));
app.use(express.static(distPath));

app.get('/api/health', readLimiter, (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/magic-link', magicLinkIpLimiter, magicLinkEmailLimiter, magicLinkEmailOnlyLimiter, async (req: Request, res: Response) => {
  const genericResponse = { success: true };

  try {
    const parsed = MagicLinkRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.json(genericResponse);
      return;
    }

    if (!isMailerConfigured()) {
      logSecurityEvent('magic_link_request_ignored_mailer_not_configured', {
        ip: req.ip ?? null,
      });
      res.json(genericResponse);
      return;
    }

    const now = Date.now();
    const user = findOrCreateUserByEmail(parsed.data.email, now);
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(rawToken);
    const expiresAt = now + MAGIC_LINK_TTL_MS;

    createMagicLink({
      id: randomUUID(),
      userId: user.id,
      tokenHash,
      expiresAt,
      createdAt: now,
      createdIp: req.ip || null,
    });

    const verifyUrl = `${getAppBaseUrl()}/api/auth/verify?token=${encodeURIComponent(rawToken)}`;
    await sendMagicLinkEmail({
      to: user.email,
      link: verifyUrl,
      expiresInMinutes: Math.floor(MAGIC_LINK_TTL_MS / 60000),
      language: parsed.data.language,
    });
  } catch (err) {
    console.error('POST /api/auth/magic-link error:', err);
  }

  res.json(genericResponse);
});

app.get('/api/auth/verify', verifyLimiter, (req: Request, res: Response) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
      res.redirect('/?auth=invalid');
      return;
    }

    const language = getPreferredLanguage(req.get('accept-language'));
    const copy = SIGN_IN_CONFIRM_COPY[language];
    const dir = language === 'ar' ? 'rtl' : 'ltr';

    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html>
<html lang="${language}" dir="${dir}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(copy.title)}</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f8fafc;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        color: #0f172a;
      }
      .card {
        width: min(420px, 92vw);
        background: white;
        border-radius: 12px;
        border: 1px solid #e2e8f0;
        padding: 24px;
        box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
      }
      h1 { font-size: 1.2rem; margin: 0 0 8px; }
      p { margin: 0 0 20px; color: #334155; }
      button {
        border: 0;
        border-radius: 10px;
        background: #0f172a;
        color: white;
        font-size: 0.95rem;
        padding: 10px 14px;
        cursor: pointer;
      }
      button:hover { background: #1e293b; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${escapeHtml(copy.title)}</h1>
      <p>${escapeHtml(copy.description)}</p>
      <form method="post" action="/api/auth/verify/consume">
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <button type="submit">${escapeHtml(copy.action)}</button>
      </form>
    </main>
  </body>
</html>`);
  } catch (err) {
    console.error('GET /api/auth/verify error:', err);
    res.redirect('/?auth=invalid');
  }
});

app.post('/api/auth/verify/consume', verifyLimiter, requireTrustedOrigin, (req: Request, res: Response) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!token) {
      logSecurityEvent('magic_link_consume_failed_missing_token', {
        ip: req.ip ?? null,
      });
      res.redirect('/?auth=invalid');
      return;
    }

    const now = Date.now();
    const consumed = consumeMagicLink(hashToken(token), now);
    if (!consumed) {
      logSecurityEvent('magic_link_consume_failed_invalid_or_expired', {
        ip: req.ip ?? null,
      });
      res.redirect('/?auth=invalid');
      return;
    }

    const rawSessionToken = randomBytes(32).toString('base64url');
    const sessionHash = hashToken(rawSessionToken);
    const sessionExpiresAt = now + SESSION_TTL_MS;

    createSession({
      sessionId: randomUUID(),
      userId: consumed.userId,
      sessionHash,
      expiresAt: sessionExpiresAt,
      createdAt: now,
      ip: req.ip || null,
      userAgent: req.get('user-agent') || null,
    });

    setAuthCookies(res, rawSessionToken);
    res.redirect('/');
  } catch (err) {
    console.error('POST /api/auth/verify/consume error:', err);
    res.redirect('/?auth=invalid');
  }
});

app.get('/api/auth/me', readLimiter, (req: Request, res: Response) => {
  if (!req.auth) {
    res.json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    user: {
      email: req.auth.email,
      isAdmin: isAdmin(req.auth.email),
    },
  });
});

app.post('/api/auth/logout', mutationLimiter, validateCsrf, (req: Request, res: Response) => {
  try {
    if (req.auth) {
      deleteSessionById(req.auth.sessionId);
    }
    clearAuthCookies(res);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/auth/logout error:', err);
    res.status(500).json({ error: 'Failed to log out' });
  }
});

app.get('/api/auth/sessions', readLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const sessions = getActiveSessionsByUser(req.auth!.userId, Date.now());
    res.json({
      sessions: sessions.map(s => ({
        id: s.id,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        ip: s.ip,
        userAgent: s.userAgent,
        current: s.id === req.auth!.sessionId,
      })),
    });
  } catch (err) {
    console.error('GET /api/auth/sessions error:', err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.delete('/api/auth/sessions/:id', mutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    const idResult = SessionIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }
    const sessionId = idResult.data;
    if (sessionId === req.auth!.sessionId) {
      res.status(400).json({ error: 'Cannot revoke current session, use logout instead' });
      return;
    }
    const revoked = revokeSessionById(req.auth!.userId, sessionId);
    if (!revoked) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    logSecurityEvent('session_revoked', {
      userId: req.auth!.userId,
      revokedSessionId: sessionId,
      bySessionId: req.auth!.sessionId,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/auth/sessions error:', err);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

app.post('/api/auth/sessions/revoke-others', mutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    const revokedCount = revokeOtherSessions(req.auth!.userId, req.auth!.sessionId);
    logSecurityEvent('sessions_revoked_others', {
      userId: req.auth!.userId,
      currentSessionId: req.auth!.sessionId,
      revokedCount,
    });
    res.json({ success: true, revokedCount });
  } catch (err) {
    console.error('POST /api/auth/sessions/revoke-others error:', err);
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

// CSRF Token endpoint for authenticated users
app.get('/api/csrf-token', csrfLimiter, requireAuth, (_req: Request, res: Response) => {
  const token = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
  res.json({ token });
});

// API Routes
app.get('/api/tasks', readLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const tasks = getAllTasks(req.auth!.userId);
    const etag = makeEtag(tasks);
    res.setHeader('ETag', etag);
    if (hasMatchingEtag(req, etag)) {
      res.status(304).end();
      return;
    }
    res.json(tasks);
  } catch (err) {
    console.error('GET /api/tasks error:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

app.post('/api/tasks', mutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    const parsed = CreateTaskRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const sanitizedText = sanitizeText(parsed.data.text);
    if (sanitizedText.length === 0) {
      res.status(400).json({ error: 'Invalid task text' });
      return;
    }

    const id = randomUUID();
    const createdAt = Date.now();
    const task = createTask(req.auth!.userId, id, sanitizedText, parsed.data.quadrant, createdAt);

    res.status(201).json(task);
  } catch (err) {
    console.error('POST /api/tasks error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.patch('/api/tasks/:id', mutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    const idResult = TaskIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json({ error: 'Invalid task ID' });
      return;
    }
    const id = idResult.data;
    const parsed = UpdateTaskRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { text, quadrant } = parsed.data;

    const updateTask = db.transaction(() => {
      if (text !== undefined) {
        const sanitizedText = sanitizeText(text);
        if (sanitizedText.length === 0) {
          return { error: 'Invalid task text', status: 400 };
        }
        const updated = updateTaskText(req.auth!.userId, id, sanitizedText);
        if (!updated) {
          return { error: 'Task not found', status: 404 };
        }
      }

      if (quadrant !== undefined) {
        const updated = updateTaskQuadrant(req.auth!.userId, id, quadrant);
        if (!updated) {
          return { error: 'Task not found', status: 404 };
        }
      }

      return null;
    });

    const result = updateTask();
    if (result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/tasks error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

app.delete('/api/tasks/:id', mutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    const idResult = TaskIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json({ error: 'Invalid task ID' });
      return;
    }
    const id = idResult.data;
    const deleted = deleteTask(req.auth!.userId, id);

    if (!deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/tasks error:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

app.post('/api/tasks/:id/complete', mutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    const idResult = TaskIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json({ error: 'Invalid task ID' });
      return;
    }
    const id = idResult.data;
    const completed = completeTask(req.auth!.userId, id);

    if (!completed) {
      res.status(404).json({ error: 'Task not found or already completed' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/tasks/:id/complete error:', err);
    res.status(500).json({ error: 'Failed to complete task' });
  }
});

app.post('/api/tasks/batch', mutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    const parsed = TaskBatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const runBatch = db.transaction(() => {
      for (const op of parsed.data.operations) {
        if (op.type === 'move') {
          const updated = updateTaskQuadrant(req.auth!.userId, op.id, op.quadrant);
          if (!updated) {
            return { status: 404, error: `Task not found: ${op.id}` };
          }
          continue;
        }

        if (op.type === 'edit') {
          const sanitizedText = sanitizeText(op.text);
          if (!sanitizedText) {
            return { status: 400, error: 'Invalid task text' };
          }
          const updated = updateTaskText(req.auth!.userId, op.id, sanitizedText);
          if (!updated) {
            return { status: 404, error: `Task not found: ${op.id}` };
          }
          continue;
        }

        if (op.type === 'delete') {
          const deleted = deleteTask(req.auth!.userId, op.id);
          if (!deleted) {
            return { status: 404, error: `Task not found: ${op.id}` };
          }
          continue;
        }

        const completed = completeTask(req.auth!.userId, op.id);
        if (!completed) {
          return { status: 404, error: `Task not found or already completed: ${op.id}` };
        }
      }

      return null;
    });

    const result = runBatch();
    if (result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/tasks/batch error:', err);
    res.status(500).json({ error: 'Failed to apply batch operations' });
  }
});

app.get('/api/archived-tasks', readLimiter, requireAuth, (req: Request, res: Response) => {
  try {
    const parsed = ArchivedTasksQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { page, pageSize, q, quadrant, from, to } = parsed.data;
    const result = getArchivedTasksPaginated(req.auth!.userId, page, pageSize, {
      q: q || undefined,
      quadrant,
      from,
      to,
    });
    const etag = makeEtag(result);
    res.setHeader('ETag', etag);
    if (hasMatchingEtag(req, etag)) {
      res.status(304).end();
      return;
    }
    res.json(result);
  } catch (err) {
    console.error('GET /api/archived-tasks error:', err);
    res.status(500).json({ error: 'Failed to fetch archived tasks' });
  }
});

app.delete('/api/archived-tasks/:id', mutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    const idResult = TaskIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json({ error: 'Invalid task ID' });
      return;
    }
    const id = idResult.data;
    const deleted = deleteArchivedTask(req.auth!.userId, id);

    if (!deleted) {
      res.status(404).json({ error: 'Archived task not found' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/archived-tasks error:', err);
    res.status(500).json({ error: 'Failed to delete archived task' });
  }
});

app.post('/api/archived-tasks/:id/restore', mutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    const idResult = TaskIdSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json({ error: 'Invalid task ID' });
      return;
    }
    const restored = restoreArchivedTask(req.auth!.userId, idResult.data);
    if (!restored) {
      res.status(404).json({ error: 'Archived task not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/archived-tasks/:id/restore error:', err);
    res.status(500).json({ error: 'Failed to restore archived task' });
  }
});

// --- Admin routes ---

app.get('/api/admin/users', adminReadLimiter, requireAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const result = getAllUsersWithTaskCount(page, pageSize);
    res.json(result);
  } catch (err) {
    console.error('GET /api/admin/users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/admin/stats', adminReadLimiter, requireAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const threshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const stats = getAdminStats(threshold);
    res.json(stats);
  } catch (err) {
    console.error('GET /api/admin/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.delete('/api/admin/users/:id', adminMutationLimiter, requireAuth, requireAdmin, validateCsrf, (req: Request, res: Response) => {
  try {
    const parsed = UserIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    if (parsed.data === req.auth!.userId) {
      res.status(400).json({ error: 'Cannot delete your own account from admin' });
      return;
    }

    const deleted = deleteUserById(parsed.data);
    if (!deleted) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    logSecurityEvent('admin_delete_user', {
      adminId: req.auth!.userId,
      deletedUserId: parsed.data,
      ip: req.ip ?? null,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/users/:id error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// --- Account routes ---

app.delete('/api/account', accountMutationLimiter, requireAuth, validateCsrf, (req: Request, res: Response) => {
  try {
    deleteUserById(req.auth!.userId);
    clearAuthCookies(res);

    logSecurityEvent('account_self_delete', {
      userId: req.auth!.userId,
      ip: req.ip ?? null,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

app.post('/api/account/change-email', emailChangeLimiter, requireAuth, validateCsrf, async (req: Request, res: Response) => {
  const genericResponse = { success: true };

  try {
    const parsed = ChangeEmailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.json(genericResponse);
      return;
    }

    if (!isMailerConfigured()) {
      res.json(genericResponse);
      return;
    }

    const newEmail = normalizeEmail(parsed.data.email);
    if (newEmail === req.auth!.email) {
      res.json(genericResponse);
      return;
    }

    const now = Date.now();
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(rawToken);

    createEmailChangeRequest({
      id: randomUUID(),
      userId: req.auth!.userId,
      newEmail,
      tokenHash,
      expiresAt: now + EMAIL_CHANGE_TTL_MS,
      createdAt: now,
    });

    const verifyUrl = `${getAppBaseUrl()}/api/account/verify-email?token=${encodeURIComponent(rawToken)}`;
    await sendEmailChangeVerification({
      to: newEmail,
      link: verifyUrl,
      expiresInMinutes: Math.floor(EMAIL_CHANGE_TTL_MS / 60000),
      language: parsed.data.language,
    });
  } catch (err) {
    console.error('POST /api/account/change-email error:', err);
  }

  res.json(genericResponse);
});

app.get('/api/account/verify-email', verifyLimiter, (req: Request, res: Response) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
      res.redirect('/?email-change=invalid');
      return;
    }

    const language = getPreferredLanguage(req.get('accept-language'));
    const copy = EMAIL_CHANGE_CONFIRM_COPY[language];
    const dir = language === 'ar' ? 'rtl' : 'ltr';

    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html>
<html lang="${language}" dir="${dir}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(copy.title)}</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f8fafc;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        color: #0f172a;
      }
      .card {
        width: min(420px, 92vw);
        background: white;
        border-radius: 12px;
        border: 1px solid #e2e8f0;
        padding: 24px;
        box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
      }
      h1 { font-size: 1.2rem; margin: 0 0 8px; }
      p { margin: 0 0 20px; color: #334155; }
      button {
        border: 0;
        border-radius: 10px;
        background: #0f172a;
        color: white;
        font-size: 0.95rem;
        padding: 10px 14px;
        cursor: pointer;
      }
      button:hover { background: #1e293b; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${escapeHtml(copy.title)}</h1>
      <p>${escapeHtml(copy.description)}</p>
      <form method="post" action="/api/account/verify-email/consume">
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <button type="submit">${escapeHtml(copy.action)}</button>
      </form>
    </main>
  </body>
</html>`);
  } catch (err) {
    console.error('GET /api/account/verify-email error:', err);
    res.redirect('/?email-change=invalid');
  }
});

app.post('/api/account/verify-email/consume', verifyLimiter, requireTrustedOrigin, (req: Request, res: Response) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!token) {
      res.redirect('/?email-change=invalid');
      return;
    }

    const tokenHash = hashToken(token);
    const result = consumeEmailChange(tokenHash, Date.now());
    if (!result) {
      res.redirect('/?email-change=invalid');
      return;
    }

    logSecurityEvent('email_changed', {
      userId: result.userId,
    });

    // Notify the previous address; a failed notification must not block the change
    sendEmailChangedNotice({
      to: result.oldEmail,
      language: getPreferredLanguage(req.get('accept-language')),
    }).catch((noticeErr) => {
      console.error('Failed to send email change notice:', noticeErr);
    });

    res.redirect('/?email-changed=true');
  } catch (err) {
    console.error('POST /api/account/verify-email/consume error:', err);
    res.redirect('/?email-change=invalid');
  }
});

// Return 404 JSON for unknown API routes (prevent SPA fallback serving HTML)
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Fallback: serve index.html for SPA routing
app.get('/{*splat}', (_req: Request, res: Response) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// Error handler: registered after all routes so it catches errors from any of them
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  Sentry.captureException(err);
  console.error('Unhandled server error:', err);
  if (req.path.startsWith('/api/')) {
    res.status(500).json({ error: 'Internal server error' });
    return;
  }
  res.status(500).send('Internal server error');
});

// In tests the app is exercised through supertest without binding a port
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const gracefulShutdown = (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => {
      db.close();
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
