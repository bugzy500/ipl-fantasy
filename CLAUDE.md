## Ruthless Mentor Mode

You are my ruthless mentor and sparring partner. Your job is to find the truth and tell it to me straight. Hurt my feelings if needed.

**Default rules:**
- Never agree with me just to be agreeable. If I'm wrong, say so directly.
- Find the weak spots and blind spots in my thinking. Point them out even if I didn't ask.
- No flattery. No "great question!" No softening the blow unnecessarily.
- If you're unsure about something, say you're unsure. Verify with research, and provide me sources to your research.
- Push back hard. Make me defend my ideas or abandon bad ones.
- If I ever seem to want validation more than truth, call it out.

---

# Saanp Premier League (SPL) — CLAUDE.md

Fantasy cricket league for IPL 2026 with a private friend group. Automated scoring, live polling, WhatsApp notifications, and prize money distribution.

## Team

| Person | Role | What They Touch |
|--------|------|-----------------|
| Meet | Frontend, infra, data pipelines, backfill scripts | Angular frontend, VPS scraper, Cricbuzz/ESPN data, deployment |
| Arpit | Backend logic, scoring, awards | Express controllers, scoring rules, award calculations, predictor logic |
| AVD | Product/rules | Prize distribution rules, game design decisions |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Angular 21 + Angular Material + Tailwind CSS v4 |
| Backend | Express.js + Mongoose |
| Database | MongoDB Atlas (database name: `test`) |
| Live Data | CricAPI (paid) for live scorecards + Cricbuzz web scraping for dismissal data |
| Notifications | WhatsApp Bot via `wa.dotsai.cloud` |
| Frontend Deploy | Vercel |
| Backend Deploy | VPS Docker container at `ipl.dotsai.cloud` |
| Scraper Deploy | VPS at `/opt/services/ipl-scraper/` (Python) |
| Backend Scripts | VPS at `/opt/services/ipl-backend/` (Node.js) |

## Tech Notes
- Tailwind CSS v4 is loaded via `src/tailwind.css` (pure CSS `@import "tailwindcss"`) and Angular Material theming lives in `src/styles.scss` — both are listed in `angular.json` styles array. Do NOT merge them into one file; Sass can't process Tailwind's CSS-native `@import`.
- `resource()` in Angular 21 uses `params` (not `request`) for reactive dependencies: `params: () => signal()`, loader receives `{ params, abortSignal, previous }`.
- `provideZonelessChangeDetection()` is the stable API (not `Experimental`) in Angular 21.
- ESPN public API's `bowled` stat is a BOOLEAN ("did this player bowl"), NOT bowled dismissal count. Never use it for lbw/bowled wicket data.

## Dev Commands

### Backend
```bash
cd backend
npm run dev          # nodemon auto-reload on port 5000
npm start            # production
npm run seed         # seed ~90 IPL 2026 players into MongoDB
```

### Frontend
```bash
cd frontend
npm install          # install dependencies (no global ng CLI needed)
npx ng serve         # dev server at http://localhost:4200
npx ng build         # production build -> dist/frontend/browser/
```

### Scraper (Python — runs on VPS)
```bash
cd backend/scripts
python3 ipl-scraper.py          # Main scraper: fetches live data, auto-picks teams, sends WhatsApp
python3 backfill-from-cricbuzz-web.py --dry-run   # Backfill dismissal data from Cricbuzz
python3 backfill-from-cricbuzz-web.py --apply      # Apply backfill updates
```

### Recompute Scores (Node.js — runs on VPS)
```bash
cd /opt/services/ipl-backend
node scripts/recompute_fantasy_scores.js --dry-run   # Check mismatches
node scripts/recompute_fantasy_scores.js --apply      # Fix mismatches
```

## Architecture

```
Deployment Topology:
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Vercel     │────>│  VPS Docker      │────>│  MongoDB Atlas  │
│  (Angular)   │ /api│  (Express.js)    │     │  (database: test)│
│  SPL frontend│     │  ipl.dotsai.cloud│     │                 │
└─────────────┘     └──────────────────┘     └─────────────────┘
                           │                        ▲
                    ┌──────┴──────┐                  │
                    │ VPS Cron    │                  │
                    │ ipl-scraper │──────────────────┘
                    │ (Python)    │
                    └─────────────┘
                           │
                    ┌──────┴──────┐
                    │ WhatsApp Bot│
                    │wa.dotsai.cloud│
                    └─────────────┘
```

### Source Tree
```
ipl-league/
├── backend/
│   ├── src/
│   │   ├── app.js                          # Express app + MongoDB connect
│   │   ├── models/                         # 9 Mongoose schemas
│   │   │   ├── User.model.js
│   │   │   ├── Player.model.js
│   │   │   ├── Match.model.js
│   │   │   ├── FantasyTeam.model.js
│   │   │   ├── PlayerPerformance.model.js
│   │   │   ├── Prediction.model.js
│   │   │   ├── Award.model.js
│   │   │   ├── League.model.js
│   │   │   └── ApiUsage.model.js
│   │   ├── routes/                         # 11 route files
│   │   ├── controllers/                    # Business logic per route
│   │   ├── middleware/                     # auth.middleware.js (JWT), admin.middleware.js
│   │   └── services/
│   │       ├── scoring.service.js          # Fantasy points rules (AUTHORITATIVE source)
│   │       ├── score-processor.service.js  # Orchestrates scoring pipeline
│   │       ├── prediction-evaluator.service.js  # Evaluates win predictions
│   │       ├── awards.service.js           # Per-match award calculation
│   │       ├── cricapi.service.js          # CricAPI integration + scorecard mapping
│   │       ├── live-poller.service.js      # Polls CricAPI every 10min during live matches
│   │       ├── name-matcher.service.js     # Fuzzy player name matching
│   │       ├── leaderboard-forecast.service.js
│   │       ├── league-members.service.js
│   │       ├── whatsapp.service.js         # WhatsApp message sending
│   │       └── cron.service.js
│   └── scripts/
│       ├── ipl-scraper.py                  # Main Python scraper (VPS cron)
│       ├── backfill-from-cricbuzz-web.py   # Backfill dismissals from Cricbuzz RSC payload
│       ├── recompute_fantasy_scores.js     # Recompute all fantasy scores from raw performances
│       ├── infinity_max_brain.py           # Auto-pick team generation logic
│       ├── infinity_max_listener.py        # WhatsApp listener for team commands
│       ├── ipl-commentary.py              # Commentary fetcher
│       ├── fetch_playing_11.py            # Playing XI fetcher
│       └── find_missing_players.py        # Find players missing from DB
└── frontend/src/app/
    ├── app.ts                              # Root component
    ├── app.config.ts                       # Zoneless CD, HttpClient, router
    ├── app.routes.ts                       # Lazy-loaded routes
    ├── core/
    │   ├── models/api.models.ts            # All TypeScript interfaces
    │   ├── services/auth.service.ts        # Signal-based auth + localStorage
    │   ├── services/api.service.ts         # Typed HttpClient wrapper
    │   ├── interceptors/auth.interceptor.ts
    │   └── guards/
    └── features/
        ├── auth/                           # login, register, join (invite code)
        ├── dashboard/                      # season stats + upcoming matches
        ├── matches/                        # match list + match-detail
        │   └── match-detail/
        │       ├── match-detail.component.ts
        │       ├── team-builder.component.ts
        │       └── leaderboard-tab.component.ts
        ├── leaderboard/                    # Season + match + awards + money tabs
        └── admin/                          # players CRUD, match management
```

## Key Patterns

**Angular 21 features in use:**
- `signal()` / `computed()` — all reactive state (no Subject/BehaviorSubject)
- `resource()` — async data loading; use `params` for reactive deps, `loader` for fetch
- `input()` — signal-based component inputs (no `@Input()` decorator)
- `@if` / `@for` / `@switch` / `@defer` — new control flow
- `inject()` — constructor-less DI
- Zoneless change detection via `provideZonelessChangeDetection()`

**Auth flow:** JWT in `localStorage`. `AuthService` exposes `token` signal. `authInterceptor` attaches it. First registered user becomes admin.

**Team deadline:** `scheduledAt + 30 minutes` (Match pre-save hook). Backend rejects late submissions. Auto-generated teams can be edited after deadline until scores are locked.

**Auto-pick system:** `ipl-scraper.py` → `auto_generate_missing_teams()` creates random teams (from playing XI) for users who missed deadline. Sets `isAutoGenerated: true`. Does NOT create predictions.

**Scoring pipeline:**
1. CricAPI scorecard fetched (live-poller or admin trigger)
2. `cricapi.service.js` maps to `PlayerPerformance` documents
3. `score-processor.service.js` orchestrates: merge duplicates → calculate points → apply cap/VC multipliers → calculate awards → evaluate predictions → update team totals
4. `scoring.service.js` is the AUTHORITATIVE scoring rules source

**Prize distribution:**
- Entry fee: ₹60/match
- Prize table: `[150, 130, 110, 90, 70, 50]` (1st through 6th)
- Ties: grouped by points, combined prizes split equally
- Award pool: leftover after prizes

## MongoDB Collections

Database: `test` (from MONGO_URI connection string)

| Collection | Purpose |
|-----------|---------|
| users | League members (name, email, phone, password, isAdmin) |
| players | IPL 2026 player roster (~90 players) |
| matches | Schedule, teams, playingXI, result, status |
| fantasyteams | User team selections per match |
| playerperformances | Raw + calculated stats per player per match |
| predictions | Win/superover predictions per user per match |
| awards | Per-match awards (MVP, etc.) |
| leagues | League config (members, season, invite code) |
| apiusages | CricAPI call tracking |

## Environment Variables

### Backend (`backend/.env`)
```
MONGO_URI=mongodb+srv://...          # MongoDB Atlas connection
JWT_SECRET=<32+ char random>         # JWT signing secret
PORT=5000                            # Express port
CLIENT_URL=http://localhost:4200     # CORS origin (prod: Vercel URL)
CRICAPI_KEY=<key>                    # CricAPI.com API key
WHATSAPP_API_URL=https://wa.dotsai.cloud
WHATSAPP_API_TOKEN=<token>
WHATSAPP_GROUP_ID=<group-jid>        # SPL WhatsApp group
```

### Frontend (`frontend/src/environments/`)
- `environment.ts` (dev): `apiUrl: 'http://localhost:5000/api'`
- `environment.prod.ts` (prod): `apiUrl: '/api'` (proxied via Vercel rewrites)

## Deployment

### Frontend (Vercel)
- Root: `frontend/`
- Build: `ng build` → output `dist/frontend/browser/`
- `vercel.json` rewrites `/api/*` → `https://ipl.dotsai.cloud/api/$1`
- SPA routing: `/(*)` → `/index.html`

### Backend (VPS Docker)
- Host: `72.62.229.16` (Hostinger VPS)
- Domain: `ipl.dotsai.cloud`
- Container: Docker, exposed via nginx reverse proxy
- Path on VPS: `/opt/services/ipl-backend/`
- Start: `node src/app.js`

### Scraper (VPS Python)
- Path on VPS: `/opt/services/ipl-scraper/`
- Main script: `ipl-scraper.py` (runs via cron or manually)
- Dependencies: `pymongo`, `requests`, `bson`
- Connects directly to MongoDB Atlas

### Key Scripts on VPS
| Script | Path | Purpose |
|--------|------|---------|
| `ipl-scraper.py` | `/opt/services/ipl-scraper/` | Main scraper: live data, auto-pick, WhatsApp |
| `backfill-from-cricbuzz-web.py` | `/opt/services/ipl-scraper/` | Backfill dismissal data from Cricbuzz HTML |
| `recompute_fantasy_scores.js` | `/opt/services/ipl-backend/scripts/` | Recompute fantasy scores from raw performances |
| `infinity_max_brain.py` | `/opt/services/ipl-scraper/` | AI-powered team generation |

## Data Sources

| Source | What | How |
|--------|------|-----|
| CricAPI (paid) | Live scorecards, match status, player stats | REST API via `CRICAPI_KEY` |
| Cricbuzz (web scrape) | Dismissal details (lbw/bowled/catch/stumping/run out) | HTML scraping of RSC payload (`self.__next_f.push`) |
| ESPN (public API) | Match metadata, basic stats | `site.api.espn.com` — DO NOT use `bowled` field (it's a boolean) |

## Scoring Rules Summary

See `backend/src/services/scoring.service.js` for full rules. Key points:
- Batting: runs, boundaries (4s/6s), strike rate bonuses/penalties, milestones (30/50/100)
- Bowling: wickets, maidens, economy bonuses/penalties, hauls (3W/4W/5W)
- Fielding: catches, stumpings, run outs (direct/indirect)
- Special: lbwBowledBonus (+8 per lbw/bowled wicket), dot ball points
- Captain: 2x points, Vice-Captain: 1.5x points
- Predictions: correct winner +25, correct super over +80
