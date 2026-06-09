<div align="center">
<img width="1200" height="400" alt="dokucreator-backend banner" src="./assets/banner_dokucreator_17809874203791.png" />
# dokucreator-backend

**rest api for dokucreator — ai-powered chart, slide, and report generation**

[![Express](https://img.shields.io/badge/Express-4.21-000000?logo=express&logoColor=white)](https://expressjs.com)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/atlas)
[![Gemini](https://img.shields.io/badge/Gemini_AI-powered-4285F4?logo=google&logoColor=white)](https://ai.google.dev)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[frontend repo](https://github.com/swarajduttacv/dokucreator) · [report bug](https://github.com/swarajduttacv/dokucreator-backend/issues)

</div>

---

## what is this

the backend api for [dokucreator](https://github.com/swarajduttacv/dokucreator). handles user auth, ai-powered generation (charts, slides, reports, color palettes), and persistent content storage via mongodb.

this isn't just a dumb proxy to an ai api — it has its own rule-based chart recommendation engine and statistical pre-analysis pipeline. your data gets analyzed locally first (column type detection, trend analysis, outlier detection, growth rates), and those computed metrics get injected into the ai prompt so the model uses *real numbers* instead of hallucinating.

uses gemini 3 flash as the primary model with groq (llama 3.3 70b) as a fallback.

## tech stack

| layer | tech |
|---|---|
| runtime | node.js (esm) |
| framework | express 4.21 |
| database | mongodb (mongoose 8) |
| ai | @google/genai (gemini 3 flash), groq-sdk (llama 3.3 70b) |
| auth | bcryptjs + jsonwebtoken (7-day tokens) |
| file parsing | xlsx for excel files |
| rate limiting | express-rate-limit (20 req/min on generate endpoints) |

## api endpoints

### auth — `/api/auth`

| method | endpoint | auth | description |
|---|---|---|---|
| `POST` | `/api/auth/signup` | ✗ | create account (username 3-30 chars, password 4+ chars) |
| `POST` | `/api/auth/login` | ✗ | login, returns jwt token |
| `GET` | `/api/auth/me` | ✓ | verify token, returns user info |

### generate — `/api/generate` (rate limited: 20/min)

| method | endpoint | auth | description |
|---|---|---|---|
| `POST` | `/api/generate/charts` | ✓ | analyze data and generate chart suggestions |
| `POST` | `/api/generate/slides` | ✓ | generate slide definition (title, bullets, style) |
| `POST` | `/api/generate/color-palette` | ✓ | generate 6 hex colors from a text description |
| `POST` | `/api/generate/reports` | ✓ | generate multi-page html report |

### content — `/api/content` (crud for saved items)

| method | endpoint | auth | description |
|---|---|---|---|
| `GET` | `/api/content/:type` | ✓ | list saved items (type: `chartGeneration`, `slide`, `report`) |
| `POST` | `/api/content/:type` | ✓ | save new item (limits: 20 charts, 40 slides, 20 reports) |
| `DELETE` | `/api/content/:type/:id` | ✓ | delete saved item |

### health

| method | endpoint | auth | description |
|---|---|---|---|
| `GET` | `/api/health` | ✗ | health check, returns `{ status: 'ok' }` |

## chart generation pipeline

the chart endpoint isn't just "send data to gemini and pray." here's what actually happens:

```
raw data (text/csv/xlsx/pdf)
        │
        ▼
┌─────────────────────┐
│  file parser         │ ← xlsx for excel, utf-8 decode for csv/text,
│                      │   native gemini for pdf/word
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  tabular parser      │ ← auto-detects separator (comma, tab, semicolon, pipe)
│                      │   converts to array of objects with typed values
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  chart recommender   │ ← rule-based scoring engine
│                      │   detects time-series columns, counts categories,
│                      │   scores bar/line/pie/area/composed by data shape
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  data analyzer       │ ← computes per-column stats:
│                      │   min, max, mean, median, stddev, sum
│                      │   growth rate (first→last), linear regression trend,
│                      │   outlier detection (>2σ from mean)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  prompt builder      │ ← injects recommendations + exact stats into prompt
│                      │   so ai uses real numbers in chart titles
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  gemini 3 flash      │ ← structured json output with response schema
│  (groq fallback)     │
└─────────────────────┘
```

## project structure

```
dokucreator-backend/
├── server.js               # entry point — express setup, cors, rate limiting, mongodb
├── routes/
│   ├── auth.js             # signup, login, session verification
│   ├── generate.js         # chart/slide/palette/report generation endpoints
│   └── content.js          # crud for saved charts, slides, reports
├── models/
│   ├── User.js             # user schema (username, hashed password)
│   └── Content.js          # generic content schema (type, userId, data, name)
├── middleware/
│   └── auth.js             # jwt verification middleware
├── utils/
│   ├── chartRecommender.js # rule-based chart type scoring engine
│   └── dataAnalyzer.js     # statistical pre-analysis (stats, trends, outliers)
├── .env.example            # environment variable template
├── render.yaml             # render.com deploy config
└── package.json
```

## getting started

### prerequisites

- [node.js](https://nodejs.org) (v18+)
- [mongodb atlas](https://www.mongodb.com/atlas) cluster (free tier works)
- [gemini api key](https://ai.google.dev)
- (optional) [groq api key](https://console.groq.com) for fallback/report generation

### setup

```bash
# clone
git clone https://github.com/swarajduttacv/dokucreator-backend.git
cd dokucreator-backend

# install dependencies
npm install

# copy env template and fill in your keys
cp .env.example .env

# start dev server (auto-restarts on file changes)
npm run dev

# or start production server
npm start
```

### environment variables

| variable | required | description |
|---|---|---|
| `MONGODB_URI` | ✓ | mongodb atlas connection string |
| `GEMINI_API_KEY` | ✓ | google gemini api key |
| `GROQ_API_KEY` | ✗ | groq api key (enables llama 3.3 fallback + report model option) |
| `JWT_SECRET` | ✓ | secret for signing jwt tokens (use a strong random string) |
| `PORT` | ✗ | server port (default: `5000`) |
| `FRONTEND_URL` | ✗ | cors origin for frontend (default: `http://localhost:3000`) |

## deployment

currently deployed on [render](https://render.com) — the `render.yaml` blueprint is included in the repo.

for render:
- set all environment variables in the render dashboard
- it auto-deploys from the main branch

## license

[MIT](LICENSE) © 2025-2026 Swaraj Dutta

