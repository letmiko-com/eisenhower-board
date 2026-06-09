# Focus by Eisenhower

Web application for the Eisenhower Matrix to organize tasks by priority and urgency.

**Production URL**: https://focus.letmiko.app

## Stack

- React 18 + TypeScript
- Vite
- Tailwind CSS v4
- shadcn/ui
- @dnd-kit (drag & drop)
- next-themes (dark mode)
- Express + SQLite (backend)
- Zod (validation)
- Vitest + Testing Library (tests)

## Commands

```bash
# Frontend development
npm run dev          # Start Vite dev server (port 3000)
npm run build        # Production frontend build

# Backend
npm run build:server # Compile server TypeScript to dist-server/
npm run start        # Start Express server (port 3080)

# Full production build (frontend + backend)
npm run build:all

# Testing
npm test             # Run tests in watch mode
npm run test:ui      # Run tests with UI
npm run test:coverage # Run tests with coverage

# Docker
docker compose up                      # Dev: local build
docker compose --profile prod up -d    # Prod: pre-built image
```

## Architecture

```
eisenhower-board/
├── .github/workflows/
│   ├── docker-publish.yml  # CI: build image on push to main
│   └── release.yml         # CD: release on tag v*
├── docker/                 # Docker support files
│   └── entrypoint.sh      # Container entrypoint (su-exec)
├── shared/                 # Shared code (frontend + backend)
│   ├── types.ts           # Task, QuadrantKey, QuadrantsState
│   ├── validation.ts      # Zod schemas
│   └── sanitize.ts        # Input sanitization
├── server/                 # Express + SQLite backend (source)
│   ├── index.ts           # Express server, API routes, auth, CSRF
│   ├── db.ts              # SQLite with better-sqlite3
│   ├── mailer.ts          # Magic-link email (Resend API or SMTP fallback)
│   ├── migrateAuthReset.ts # Auth migration script
│   └── tsconfig.json      # Server TypeScript config
├── dist-server/            # Compiled server (gitignored)
│   ├── server/            # Compiled server/*.ts
│   └── shared/            # Compiled shared/*.ts
├── src/
│   ├── auth/
│   │   └── AuthContext.tsx # Auth provider, session management
│   ├── components/
│   │   ├── ui/            # shadcn/ui + custom (alert-dialog, toast)
│   │   ├── ArchivePage.tsx       # Archived tasks (lazy-loaded)
│   │   ├── EisenhowerMatrix.tsx  # Main matrix layout
│   │   ├── QuadrantCard.tsx      # Quadrant container
│   │   ├── TaskItem.tsx          # Draggable task with delete confirm
│   │   ├── ErrorBoundary.tsx     # React error boundary
│   │   ├── Layout.tsx            # Glass-morphism layout wrapper
│   │   ├── LoginPage.tsx         # Magic-link login form
│   │   ├── ThemeToggle.tsx       # Dark mode toggle
│   │   └── LanguageSelector.tsx  # Language dropdown
│   ├── hooks/
│   │   ├── useApi.ts      # Hook for REST API calls + CSRF
│   │   ├── useCsrfFetch.ts # CSRF-aware fetch wrapper
│   │   └── useLocalStorage.ts
│   ├── i18n/
│   │   ├── index.ts       # Re-exports
│   │   ├── translations.ts # All language strings (14 languages)
│   │   └── LanguageContext.tsx # React context provider
│   ├── test/
│   │   ├── setup.ts       # Vitest setup + mocks
│   │   └── mocks/handlers.ts # MSW API handlers
│   ├── types/
│   │   └── index.ts       # Re-exports from shared + frontend types
│   └── lib/
│       └── utils.ts
├── Dockerfile             # Multi-stage: build frontend + Node.js
├── docker-compose.yml     # Docker Compose (dev + prod profile)
├── railway.toml           # Railway deployment config (Dockerfile builder + health check)
└── tsconfig.json          # Frontend TypeScript config
```

## REST API

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/magic-link | Request magic-link email `{ email, language? }` |
| GET | /api/auth/verify | Verify magic-link token `?token=...` |
| GET | /api/auth/me | Get current authenticated user |
| POST | /api/auth/logout | End session |

### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/csrf-token | Get CSRF token for mutations |
| GET | /api/tasks | Get all tasks grouped by quadrant |
| POST | /api/tasks | Create a task `{ text, quadrant }` |
| PATCH | /api/tasks/:id | Update `{ text }` or `{ quadrant }` |
| DELETE | /api/tasks/:id | Delete a task |
| POST | /api/tasks/:id/complete | Complete a task (moves to archive) |

### Archive

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/archived-tasks | Get all archived tasks |
| DELETE | /api/archived-tasks/:id | Permanently delete an archived task |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Health check |

**Note**: POST, PATCH, DELETE require `X-CSRF-Token` header. All task/archive endpoints require authentication.

## Authentication

Magic-link email authentication:
- User enters email, receives a link via Resend API (or SMTP fallback)
- Magic-link emails are localized based on the user's selected language
- Link contains a token that creates a server-side session
- Sessions stored in SQLite, cookie-based (`session_token`)
- Multi-user support: tasks are isolated per user
- Rate limiting on auth endpoints (IP + email-based)

Required environment variables for auth:
- `APP_BASE_URL` - Base URL for magic-link URLs
- `MAIL_FROM` - Sender email address

Email provider (one of):
- **Resend (recommended)**: `RESEND_API_KEY` - works on all Railway plans (HTTPS API)
- **SMTP (fallback)**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` - requires Railway Pro or self-hosted

## Security

- **Authentication**: Magic-link email auth with session cookies
- **CSRF Protection**: All mutating endpoints require a valid CSRF token
- **Input Sanitization**: Task text is sanitized server-side (HTML stripped, length limited)
- **Request Size Limit**: 10KB body size limit on API requests
- **Rate Limiting**: Per-endpoint rate limits (IP and email-based)
- **Helmet**: Security headers via helmet middleware
- **UUID Validation**: Route params validated as UUIDs
- **Error Boundary**: React errors are caught and displayed gracefully

## Internationalization (i18n)

Supported languages:
- English (en)
- French (fr)
- German (de)
- Spanish (es)
- Italian (it)
- Portuguese (pt)
- Dutch (nl)
- Polish (pl)
- Russian (ru)
- Ukrainian (uk)
- Chinese (zh)
- Hindi (hi)
- Arabic (ar)
- Bengali (bn)

Language is auto-detected from browser settings. Users can change it via the dropdown in the header.

Translations are in `src/i18n/translations.ts`. Email translations are in `server/mailer.ts` (`EMAIL_COPY`). To add a new language:
1. Add the language code to the `Language` type
2. Add translations object following the `Translations` interface
3. Add email translations in `server/mailer.ts`

## UI Design

### Layout
- Unified 2x2 grid for quadrants
- Vertical axis labels (IMPORTANT / NOT IMPORTANT) at 25% and 75%
- Horizontal axis labels (URGENT / NOT URGENT) above the grid
- Glass-morphism effects (backdrop-blur, semi-transparent backgrounds)

### Task Interactions
- Entire task card is draggable
- Hover to reveal action buttons (complete ✓, delete ×)
- Delete shows confirmation dialog
- Complete button triggers fade-out animation before archiving
- Optimistic drag & drop with rollback on network errors

## Testing

Tests use Vitest with jsdom environment and MSW for API mocking.

```bash
npm test                    # Watch mode
npm run test:coverage       # With coverage report
```

Test files:
- `src/hooks/useLocalStorage.test.ts` - LocalStorage hook tests
- `src/hooks/useApi.test.ts` - API hook tests
- `src/components/TaskItem.test.tsx` - Task component tests
- `src/components/EisenhowerMatrix.test.tsx` - Matrix component tests

## Conventions

- Functional components with hooks
- Explicit TypeScript types (no `any`)
- Tailwind for styling (no CSS modules)
- PascalCase filenames for components
- UI text uses translations, code in English
- Shared types in `shared/` directory

## Quadrants

| Quadrant | Color | Action |
|----------|-------|--------|
| Urgent & Important | Red | Do immediately |
| Important not urgent | Blue | Schedule |
| Urgent not important | Yellow | Delegate |
| Neither urgent nor important | Gray | Eliminate |

## Persistence

In production, data is stored in SQLite:
- Database: `/app/data/tasks.db`
- Docker volume: `eisenhower-data` (Docker) or Railway volume mounted at `/app/data`
- Data persists between container restarts and redeploys

## CI/CD

GitHub Actions workflows in `.github/workflows/`:

| Workflow | Trigger | Action |
|----------|---------|--------|
| `docker-publish.yml` | Push to `main` | Build and push Docker image |
| `release.yml` | Tag `v*` | Create GitHub release + Docker image |

## Deployment

### Railway (primary)

Deployed on Railway with auto-deploy from GitHub (`main` branch).

- **URL**: https://focus.letmiko.app
- **Config**: `railway.toml` (Dockerfile builder, health check on `/api/health`)
- **Volume**: `/app/data` for SQLite persistence
- **Email**: Resend API (HTTPS, works on all Railway plans)

Environment variables on Railway:
- `NODE_ENV=production`
- `PORT=3080`
- `DATA_DIR=/app/data`
- `TRUST_PROXY=1`
- `APP_BASE_URL=https://focus.letmiko.app`
- `RESEND_API_KEY` - Resend API key
- `MAIL_FROM` - Sender email address

### Docker (alternative)

Image published on GitHub Container Registry:
```
ghcr.io/gitcroque/eisenhower-board:latest
ghcr.io/gitcroque/eisenhower-board:v1.5.0
```

Supported architectures: `linux/amd64`, `linux/arm64`

```yaml
services:
  eisenhower-board:
    image: ghcr.io/gitcroque/eisenhower-board:latest
    container_name: eisenhower-board
    ports:
      - "3080:3080"
    volumes:
      - eisenhower-data:/app/data
    environment:
      - NODE_ENV=production
      - APP_BASE_URL=https://focus.letmiko.app
      - RESEND_API_KEY=${RESEND_API_KEY}
      - MAIL_FROM=${MAIL_FROM}
    restart: unless-stopped

volumes:
  eisenhower-data:
```
