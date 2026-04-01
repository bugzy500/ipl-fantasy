# IPL Fantasy League — MEAN Stack App Plan

## Context
Building a private, invite-only IPL 2026 fantasy cricket app from scratch in `c:\ipl-ng\`. The user is new to databases and wants to learn Angular 21 modern features + Node.js API patterns. Stack: Angular 21 + Angular Material + Tailwind CSS (frontend), Node.js + Express (backend), MongoDB Atlas (database). Live scores update via 30-second polling. Deploy: Vercel (frontend) + Render (backend).

---

## Project Structure
```
ipl-ng/
├── frontend/          # Angular 21 app (ng new)
├── backend/           # Node.js + Express API
├── REQUIREMENTS.MD
└── CLAUDE.md
```

---

## Phase 1 — Project Scaffolding

### Steps
1. Install Angular CLI globally: `npm install -g @angular/cli`
2. Scaffold frontend: `ng new frontend --standalone --routing --style=scss --ssr=false`
3. Add Angular Material: `ng add @angular/material`
4. Install Tailwind CSS in frontend
5. Scaffold backend: `mkdir backend && cd backend && npm init -y`
6. Install backend deps: `express mongoose jsonwebtoken bcryptjs dotenv cors express-validator helmet morgan`
7. Create `CLAUDE.md` at repo root

---

## Phase 2 — Backend Architecture

### File Structure
```
backend/
├── src/
│   ├── models/
│   │   ├── User.model.js
│   │   ├── Player.model.js
│   │   ├── Match.model.js
│   │   ├── FantasyTeam.model.js
│   │   ├── PlayerPerformance.model.js
│   │   └── League.model.js
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── players.routes.js
│   │   ├── matches.routes.js
│   │   ├── teams.routes.js
│   │   ├── scores.routes.js
│   │   └── leaderboard.routes.js
│   ├── controllers/       (one per route file)
│   ├── middleware/
│   │   ├── auth.middleware.js    (JWT verify)
│   │   └── admin.middleware.js   (role check)
│   ├── services/
│   │   └── scoring.service.js   (points calculation engine)
│   └── app.js
├── .env                   (never committed)
├── .env.example
└── package.json
```

### MongoDB Schemas

**User**
```js
{ name, email (unique), password (bcrypt), role: enum['admin','user'],
  createdAt }
```

**Player**
```js
{ name, franchise (CSK/MI/RCB/…), role: enum['WK','BAT','AR','BOWL'],
  credits: Number, isActive: Boolean, imageUrl: String }
```

**Match**
```js
{ team1, team2, venue,
  scheduledAt: Date,   // actual start time (supports 3 PM + 7 PM on weekends)
  deadline: Date,      // scheduledAt + 25 min (auto-computed on save)
  status: enum['upcoming','toss_done','live','completed','abandoned'],
  playingXI: { team1: [ObjectId], team2: [ObjectId] },  // set after toss
  result: String }
```

**FantasyTeam**
```js
{ userId, matchId, players: [ObjectId] (11),
  captain: ObjectId, viceCaptain: ObjectId,
  totalPoints: Number, isLocked: Boolean,
  createdAt, updatedAt }
```

**PlayerPerformance**
```js
{ playerId, matchId,
  // batting
  runs, ballsFaced, fours, sixes, isDismissed, runsAtDismissal,
  // bowling
  oversBowled, runsConceded, wickets, maidens, lbwBowledWickets,
  // fielding
  catches, stumpings, runOutDirect, runOutIndirectThrow, runOutIndirectCatch,
  fantasyPoints: Number (computed by scoring service) }
```

**League**
```js
{ name, inviteCode (6-char unique), adminId, members: [ObjectId],
  season: 'IPL_2026' }
```

### API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/register | — | First user becomes admin |
| POST | /api/auth/login | — | Returns JWT |
| POST | /api/auth/join | — | Join league via invite code |
| GET | /api/players | user | List all players |
| POST | /api/players | admin | Create player |
| PUT | /api/players/:id | admin | Update player/credits |
| GET | /api/matches | user | All matches (sorted by date) |
| GET | /api/matches/:id | user | Match details + playingXI status |
| PATCH | /api/matches/:id | admin | Update status / announce XI |
| POST | /api/teams | user | Create/update fantasy team (before deadline) |
| GET | /api/teams/my/:matchId | user | Own team for a match |
| GET | /api/teams/all/:matchId | user | All teams (only after deadline) |
| POST | /api/scores/:matchId | admin | Submit raw performance → engine calculates points |
| GET | /api/leaderboard/match/:matchId | user | Match leaderboard |
| GET | /api/leaderboard/season | user | Season overall (sum of all match points) |

### Scoring Service (`scoring.service.js`)
Pure function `calculateFantasyPoints(performance, playerRole)` implementing all rules from REQUIREMENTS.MD Section 3:
- Batting (runs, boundaries, sixes, milestones, duck penalty)
- Bowling (wickets, LBW/bowled bonus, hauls, maidens)
- Fielding (catches, 3-catch bonus, stumping, run-outs)
- Economy rate modifiers (min 2 overs)
- Strike rate modifiers (min 10 balls)
After points computed: multiply by 2 (C) or 1.5 (VC) on the FantasyTeam.

---

## Phase 3 — Frontend Architecture

### Angular 21 Modern Features Used
| Feature | Where Used |
|---------|-----------|
| Standalone components | All components (no NgModules) |
| `signal()` / `computed()` / `effect()` | Team builder state, budget tracking |
| `input()` / `output()` signal-based | Reusable player card, match card |
| `@if` / `@for` / `@switch` / `@defer` | All templates (no *ngIf/*ngFor) |
| `inject()` function | All services injected in constructor-less style |
| `toSignal()` RxJS interop | HTTP responses → signals |
| `resource()` API | Async data loading with loading/error states |
| Functional guards | Route protection |
| Zoneless change detection | `provideExperimentalZonelessChangeDetection()` |
| `@defer` with `@placeholder`/`@loading` | Lazy-load leaderboard + admin panel |

### Route Structure
```
/auth/login
/auth/register
/dashboard              (default after login)
/matches                (schedule list)
/matches/:id            (team builder / live / results depending on match status)
/leaderboard            (season + match tabs)
/admin                  (canActivate: adminGuard)
  /admin/players        (CRUD players)
  /admin/matches        (manage schedule, announce XI)
  /admin/scores/:matchId (enter live scores)
/profile
```

### Key Components
- `TeamBuilderComponent` — most complex; uses signals for:
  - `budget = signal(100)`, `remaining = computed(() => budget() - selectedTotal())`
  - Role count validation (WK: 1-4, BAT: 3-6, AR: 1-4, BOWL: 3-6)
  - Max 7 from one franchise
  - Captain/VC selection
  - Submit disabled until deadline not passed and team is valid
- `MatchCardComponent` — signal inputs, shows countdown to deadline
- `PlayerCardComponent` — shows playing status dot (green/red) once XI announced
- `LeaderboardComponent` — polls GET /api/leaderboard every 30s during live match using `interval()` + `switchMap`
- `ScoreEntryComponent` (admin) — form to enter raw stats per player

### HTTP Layer
- `HttpClient` with typed generics everywhere
- `AuthInterceptor` (functional) — attaches JWT to every request
- Environment files for base URL (`environment.ts` / `environment.prod.ts`)

---

## Phase 4 — MongoDB Setup (What User Needs to Do)

User needs to provide their MongoDB Atlas connection string. It looks like:
```
mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/ipl-fantasy?retryWrites=true&w=majority
```

This goes in `backend/.env`:
```
MONGO_URI=mongodb+srv://...
JWT_SECRET=some_random_long_string_here
PORT=5000
CLIENT_URL=http://localhost:4200
```

No manual DB setup needed — Mongoose creates collections automatically on first write.

---

## Phase 5 — Deployment Config

### Backend → Render
- `backend/package.json` start script: `node src/app.js`
- Set env vars in Render dashboard (MONGO_URI, JWT_SECRET, CLIENT_URL)
- Health check route: `GET /api/health`

### Frontend → Vercel
- Set `API_BASE_URL` to Render backend URL in `environment.prod.ts`
- `vercel.json` with SPA rewrite rules (all routes → index.html)

---

## Critical Files to Create
1. `CLAUDE.md` — project guide
2. `backend/.env.example` — template for env vars
3. `backend/src/services/scoring.service.js` — points engine (all REQUIREMENTS.MD Section 3 rules)
4. `backend/src/models/*.js` — all 6 Mongoose models
5. `frontend/src/app/features/team-builder/` — most complex Angular feature
6. `frontend/src/app/core/interceptors/auth.interceptor.ts` — JWT interceptor

---

## Implementation Order
1. Scaffolding (CLI commands, folder creation)
2. CLAUDE.md
3. Backend: models → auth routes → player routes → match routes → team routes → scoring service → score routes → leaderboard routes
4. Backend: test all routes with sample data seed script
5. Frontend: app shell (routing, material theme, tailwind) → auth pages → dashboard → matches list → team builder → leaderboard → admin panel
6. Wire frontend to backend, test end-to-end
7. Deployment configuration

---

## Verification
- Backend: `cd backend && node src/app.js` — server starts, `GET /api/health` returns 200
- Run `POST /api/auth/register` → `POST /api/auth/login` → get JWT → test protected routes
- Scoring engine: unit test `calculateFantasyPoints()` with known inputs from REQUIREMENTS.MD
- Frontend: `cd frontend && ng serve` — app loads, can register, join league, build a team
- Team builder: cannot submit with invalid composition; budget enforced; locks after deadline
- Leaderboard: updates every 30s during live match
- Full flow: Admin creates match → announces XI → users build teams → admin enters scores → leaderboard updates


# CricAPI Integration Plan

## Context
The IPL Fantasy app currently requires the admin to manually enter all player stats after each match. This is tedious and error-prone. We're integrating CricketData.org (CricAPI) to auto-ingest live scorecards during matches, calculate fantasy points in real-time, and pull player images for the UI. The free tier allows 100 API calls/day — enough for 10-minute polling across single and double-header days.

---

## Phase 1 — Extract Shared Scoring Pipeline

**Why:** Both manual entry and CricAPI polling need to run the same scoring logic. Currently it's embedded in `scores.controller.js`. Extract it so both paths converge.

### New file: `backend/src/services/score-processor.service.js`
Extract from `scores.controller.js` into a reusable function:
```
processPerformances(matchId, performances, { markCompleted = false } = {})
```
- Upserts each PlayerPerformance with calculated fantasyPoints
- Recalculates all FantasyTeam.totalPoints for the match
- If `markCompleted`: sets match status to `completed`, locks teams, calculates awards
- Returns `{ teamsUpdated, playerPointsMap }`

### Modify: `backend/src/controllers/scores.controller.js`
- `submitScores` calls `processPerformances(matchId, perfs, { markCompleted: true })`
- Same behavior, less code

---

## Phase 2 — Match Model + Player Aliases

### Modify: `backend/src/models/Match.model.js`
Add three fields:
```js
cricApiMatchId: { type: String, default: '' },
lastPolledAt: { type: Date },
pollingEnabled: { type: Boolean, default: false },
```

### Modify: `backend/src/controllers/matches.controller.js`
Add `'cricApiMatchId', 'lastPolledAt', 'pollingEnabled'` to `allowedFields` in `updateMatch`.

### Modify: `backend/src/models/Player.model.js`
Add: `aliases: [{ type: String }]` — array of alternate names for CricAPI matching (e.g., "V Kohli", "VK Kohli").

### New file: `backend/src/seed-aliases.js`
Script to populate common aliases for all 248 players based on CricAPI naming conventions (initial + last name patterns). Run once.

---

## Phase 3 — CricAPI Service + Name Matcher

### New file: `backend/src/services/cricapi.service.js`
HTTP client wrapping CricAPI calls. Uses Node 22 native `fetch`.

**Methods:**
- `getMatchScorecard(cricApiMatchId)` → calls `https://api.cricapi.com/v1/match_scorecard?apikey=KEY&id=ID`
- `mapScorecardToPerformances(scorecardData)` → transforms CricAPI JSON into our `PlayerPerformance` schema shape
- `checkRateLimit()` / `incrementUsage()` → tracks daily API calls in MongoDB (`ApiUsage` collection)

**Data mapping logic:**
| CricAPI field | Our field | Notes |
|---|---|---|
| `batting[].r` | `runs` | |
| `batting[].b` | `ballsFaced` | |
| `batting[].4s` | `fours` | |
| `batting[].6s` | `sixes` | |
| `batting[].dismissal` | `isDismissed`, `didBat` | Parse "not out" vs caught/bowled/etc |
| `bowling[].o` | `oversBowled` | Convert cricket notation 3.4 → 3.667 |
| `bowling[].r` | `runsConceded` | |
| `bowling[].w` | `wickets` | |
| `bowling[].m` | `maidens` | |
| Parse dismissal strings | `lbwBowledWickets` | Count "b Bowler" and "lbw b Bowler" patterns per bowler |
| Parse dismissal strings | `catches`, `stumpings` | "c Fielder b Bowler" → catches++, "st WK b Bowler" → stumpings++ |
| Parse dismissal strings | `runOutDirect`, `runOutIndirect` | "run out (Name)" → direct, "run out (A/B)" → indirect for both |

**Overs conversion:** `3.4` (cricket notation = 3 overs, 4 balls) → `3 + 4/6 = 3.667` actual overs for economy calculation.

### New file: `backend/src/services/name-matcher.service.js`
Resolves CricAPI player names to local player IDs.

**Strategy (in order):**
1. Exact match on `Player.name`
2. Match against `Player.aliases[]`
3. Last-name match + initial comparison (e.g., "V Kohli" → first-name starts with V + last name "Kohli")
4. If still unmatched → return `null`, flag for admin review

**No external dependencies.** Hand-written ~40 lines of JS.

`matchPlayer(cricApiName, franchise)` → `{ playerId, confidence }` or `null`
`buildLookupMap()` → loads all players + aliases into memory, cached.

### New file: `backend/src/models/ApiUsage.model.js`
Simple schema: `{ date: String, count: Number }` — tracks daily API call count. Survives Render restarts.

---

## Phase 4 — Live Poller + Admin Routes

### New file: `backend/src/services/live-poller.service.js`
Manages `setInterval` per match.

- `startPolling(matchId, cricApiMatchId)` → creates 10-min interval
- `stopPolling(matchId)` → clears interval
- `restartActivePollers()` → called on server boot; queries live matches with `pollingEnabled: true` and restarts them
- `getStatus()` → returns active pollers + rate usage

**Each poll tick:**
1. Check rate limit (hard cap at 95/day, reserve 5 for manual actions)
2. Fetch scorecard from CricAPI
3. Map to performances via `cricapi.service.mapScorecardToPerformances()`
4. Resolve player IDs via `name-matcher.service.matchPlayer()`
5. Call `score-processor.processPerformances(matchId, performances)` (does NOT mark completed)
6. Update `Match.lastPolledAt`
7. If CricAPI says match ended → mark completed, calculate awards, stop polling
8. If 3 consecutive errors → stop polling, log warning

### New file: `backend/src/controllers/cricapi.controller.js`
### New file: `backend/src/routes/cricapi.routes.js`

**Endpoints (all admin-only):**
| Method | Path | Description |
|---|---|---|
| POST | `/api/cricapi/link/:matchId` | Set `cricApiMatchId` on a match |
| POST | `/api/cricapi/poll/:matchId/start` | Start 10-min polling |
| POST | `/api/cricapi/poll/:matchId/stop` | Stop polling |
| GET | `/api/cricapi/poll/status` | Active pollers + API usage today |
| POST | `/api/cricapi/sync-once/:matchId` | One-time scorecard fetch + process |
| GET | `/api/cricapi/preview/:matchId` | Fetch + map scorecard WITHOUT saving (admin preview) |
| POST | `/api/cricapi/sync-images` | Pull player images from scorecard data |

### Modify: `backend/src/app.js`
- Register `cricapiRoutes` at `/api/cricapi`
- After MongoDB connects, call `livePoller.restartActivePollers()`
- Add `CRICAPI_KEY` to `.env.example`

---

## Phase 5 — Admin UI for CricAPI Controls

### Modify: `frontend/src/app/core/services/api.service.ts`
Add methods: `linkCricApiMatch`, `startPolling`, `stopPolling`, `getPollingStatus`, `syncOnce`, `previewScorecard`, `syncPlayerImages`

### Modify: `frontend/src/app/core/models/api.models.ts`
Add to `Match`: `cricApiMatchId?: string`, `lastPolledAt?: string`, `pollingEnabled?: boolean`

### Modify: `frontend/src/app/features/admin/matches/admin-matches.component.ts`
For each match card, add:
- Text input to link CricAPI match ID
- "Start/Stop Polling" toggle (when linked + live)
- "Sync Now" button for one-time fetch
- "Preview" button to see mapped data before committing
- Status indicator: last polled time, API calls used today

---

## Phase 6 — Player Images in UI

### Image source
Extract `img` URLs from CricAPI scorecard player objects during polling (zero extra API calls). Store in `Player.imageUrl`.

### Modify: `frontend/.../team-builder.component.ts`
Add before player name in the `@for` loop:
```html
<img [src]="player.imageUrl || 'assets/default-player.png'"
     class="w-8 h-8 rounded-full object-cover flex-shrink-0"
     (error)="$event.target.src='assets/default-player.png'" />
```

### Modify: `frontend/.../all-teams-tab.component.ts`
Same pattern with `w-6 h-6` size.

### Add: `frontend/src/assets/default-player.png`
Simple cricket silhouette placeholder.

---

## Files Summary

| Action | File |
|---|---|
| **New** | `backend/src/services/score-processor.service.js` |
| **New** | `backend/src/services/cricapi.service.js` |
| **New** | `backend/src/services/name-matcher.service.js` |
| **New** | `backend/src/services/live-poller.service.js` |
| **New** | `backend/src/controllers/cricapi.controller.js` |
| **New** | `backend/src/routes/cricapi.routes.js` |
| **New** | `backend/src/models/ApiUsage.model.js` |
| **New** | `backend/src/seed-aliases.js` |
| **New** | `frontend/src/assets/default-player.png` |
| **Modify** | `backend/src/controllers/scores.controller.js` — use extracted score-processor |
| **Modify** | `backend/src/models/Match.model.js` — add cricApiMatchId, lastPolledAt, pollingEnabled |
| **Modify** | `backend/src/models/Player.model.js` — add aliases field |
| **Modify** | `backend/src/controllers/matches.controller.js` — allow new fields in PATCH |
| **Modify** | `backend/src/app.js` — register routes, restart pollers on boot |
| **Modify** | `backend/.env.example` — add CRICAPI_KEY |
| **Modify** | `frontend/.../api.service.ts` — add CricAPI methods |
| **Modify** | `frontend/.../api.models.ts` — add Match fields |
| **Modify** | `frontend/.../admin-matches.component.ts` — CricAPI controls |
| **Modify** | `frontend/.../team-builder.component.ts` — player images |
| **Modify** | `frontend/.../all-teams-tab.component.ts` — player images |

---

## Verification
1. **Unit test scoring pipeline:** Call `processPerformances()` with known data, verify same output as before
2. **Manual entry still works:** `POST /api/scores/:matchId` produces same results after refactor
3. **Preview endpoint:** Hit `/api/cricapi/preview/:matchId` with a real CricAPI match ID, verify all players are matched and stats map correctly
4. **Live polling:** Start polling for a live match, verify FantasyTeam.totalPoints update every 10 minutes
5. **Rate limiting:** Confirm API stops at 95 calls/day
6. **Render restart:** Kill backend, restart, verify polling resumes for live matches
7. **Player images:** Confirm images appear in team-builder after a sync
8. **Fallback:** With CricAPI down, manual score entry still works end-to-end
