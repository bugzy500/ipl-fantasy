# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Tech Notes
- Tailwind CSS v4 is loaded via `src/tailwind.css` (pure CSS `@import "tailwindcss"`) and Angular Material theming lives in `src/styles.scss` — both are listed in `angular.json` styles array. Do NOT merge them into one file; Sass can't process Tailwind's CSS-native `@import`.
- `resource()` in Angular 21 requires explicit return type on the loader function for correct inference: `loader: (): Promise<MyType> => ...`
- `provideZonelessChangeDetection()` is the stable API (not `Experimental`) in Angular 21.

## Dev Commands

### Backend
```bash
cd backend
npm run dev          # nodemon auto-reload
npm start            # production
npm run seed         # seed ~90 IPL 2026 players into MongoDB
```

### Frontend
```bash
cd frontend
ng serve             # dev server at http://localhost:4200
ng build             # production build → dist/frontend/browser/
ng generate component features/foo/foo --standalone   # new component
```

## Architecture

```
ipl-ng/
├── backend/src/
│   ├── app.js                   # Express app + MongoDB connect
│   ├── models/                  # Mongoose schemas (6 collections)
│   ├── routes/                  # One file per resource
│   ├── controllers/             # Business logic, one per route file
│   ├── middleware/              # auth.middleware.js (JWT), admin.middleware.js
│   ├── services/scoring.service.js   # Fantasy points engine
│   └── seed.js                  # Player data seeder
└── frontend/src/app/
    ├── app.ts                   # Root component (just <router-outlet>)
    ├── app.config.ts            # Zoneless CD, HttpClient, router, animations
    ├── app.routes.ts            # Lazy-loaded routes; MainLayoutComponent wraps protected routes
    ├── core/
    │   ├── models/api.models.ts      # All TypeScript interfaces
    │   ├── services/auth.service.ts  # Signal-based auth state + localStorage
    │   ├── services/api.service.ts   # Typed HttpClient wrapper for all endpoints
    │   ├── interceptors/auth.interceptor.ts   # Attaches JWT to every request
    │   └── guards/auth.guard.ts / admin.guard.ts
    ├── features/
    │   ├── auth/                # login, register, join (invite code)
    │   ├── dashboard/           # season stats + upcoming matches + mini leaderboard
    │   ├── matches/             # match list + match-detail
    │   │   └── match-detail/
    │   │       ├── match-detail.component.ts   # Tabs wrapper, live countdown
    │   │       ├── team-builder.component.ts   # Main team selection (signals-heavy)
    │   │       └── leaderboard-tab.component.ts # Polls every 30s when live
    │   ├── leaderboard/         # Season + per-match leaderboard tabs
    │   └── admin/               # players CRUD, match management, score entry
    └── shared/components/
        ├── navbar/main-layout.component.ts  # Sidenav + top toolbar shell
        └── match-card/match-card.component.ts
```

## Key Patterns

**Angular 21 features in use:**
- `signal()` / `computed()` — all reactive state (no Subject/BehaviorSubject needed)
- `resource()` — async data loading with `.isLoading()`, `.value()`, `.error()`, `.reload()`
- `input()` — signal-based component inputs (no `@Input()` decorator)
- `@if` / `@for` / `@switch` / `@defer` — new control flow (no `*ngIf`/`*ngFor`)
- `inject()` — constructor-less DI
- Zoneless change detection via `provideExperimentalZonelessChangeDetection()`
- Route params auto-bound to `input()` via `withComponentInputBinding()`

**Auth flow:** JWT stored in `localStorage`. `AuthService` exposes `token` signal read by `authInterceptor`. First registered user becomes admin automatically.

**Team deadline:** Auto-computed as `scheduledAt + 30 minutes` in the Match Mongoose pre-save hook. Backend rejects team submissions after this time.

**Scoring engine:** `backend/src/services/scoring.service.js` — pure function, no side effects. Admin POSTs raw stats → engine calculates → updates all FantasyTeam totalPoints.

**Abandoned matches:** Backend returns 400 on score submission; no points added to season total (filtered out in season leaderboard aggregation).

## Environment Setup

Backend needs `backend/.env` (copy from `.env.example`):
```
MONGO_URI=mongodb+srv://...    # from MongoDB Atlas
JWT_SECRET=<long random string>
PORT=5000
CLIENT_URL=http://localhost:4200
```

Frontend reads from `src/environments/environment.ts` (dev) / `environment.prod.ts` (prod).

## Deployment

- **Frontend → Vercel:** Root dir = `frontend`, build command = `ng build`, output = `dist/frontend/browser`. The `vercel.json` handles SPA routing.
- **Backend → Render:** Root dir = `backend`, start command = `node src/app.js`. Add env vars in Render dashboard. Free tier spins down after inactivity — first request may be slow.
- After deploying backend, update `frontend/src/environments/environment.prod.ts` with the Render URL.
