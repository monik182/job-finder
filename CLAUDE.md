# job-finder — Project Reference

## Overview

TypeScript-based daily job search automation that:
1. Scrapes 4 job boards via headless browser (LinkedIn, Work at a Startup/YC, Anywhere Remote Jobs, Working Nomads)
2. Applies inline filtering during scraping (dedup + hard exclusions)
3. Filters results using configurable rules (skills, location, experience, contract type, salary, exclusions)
4. Classifies jobs using AI (Claude Haiku) into strong/weak/excluded matches
5. Deduplicates against previously seen jobs using SHA-256 hashing
6. Sends curated HTML email digests via Resend (strong matches + weaker matches separated)
7. Runs daily at 6:02 AM CET via GitHub Actions (per-source workflows)
8. Persists state (seen job hashes, run logs) back to the repository

## Important

When making major changes to this project (new scrapers, new pipeline phases, config schema changes, new CLI flags, new env vars, workflow changes), **always update both `CLAUDE.md` and `README.md`** to reflect those changes.

---

## Tech Stack

- **Runtime:** Node.js 20+, TypeScript 5.5.3
- **Module system:** ESNext modules, ES2022 target, ts-node for ESM support
- **Browser automation:** puppeteer-core 22.15.0 (connects to Browserless.io in prod, local Chrome in dev)
- **AI classification:** @anthropic-ai/sdk (Claude Haiku 4.5)
- **Email:** resend 3.5.0
- **Scheduling:** GitHub Actions cron (per-source workflows at `2 5 * * *`, LinkedIn also every 2h)

---

## File Structure

```
job-finder/
├── src/
│   ├── index.ts                  # Main orchestrator — 8-phase pipeline
│   ├── types.ts                  # All shared TypeScript interfaces
│   ├── config.ts                 # Config loader + AppConfig type
│   ├── browser.ts                # Puppeteer lifecycle (connect/disconnect)
│   ├── logger.ts                 # Run logging (JSON-per-line to runs.log)
│   ├── ai-filter/
│   │   └── ai-filter.ts          # AI classification via Claude Haiku
│   ├── scrapers/
│   │   ├── utils.ts              # newPage, delay, safeGoto, parseRelativeDate
│   │   ├── linkedin.ts           # LinkedIn Jobs scraper
│   │   ├── ycombinator.ts        # Work at a Startup scraper
│   │   ├── anywhere-remote.ts    # Anywhere Remote Jobs scraper
│   │   └── working-nomads.ts     # Working Nomads scraper
│   ├── filters/
│   │   ├── filter-jobs.ts        # 3-pass filter + priority scoring
│   │   └── inline-filter.ts      # Inline filter applied during scraping
│   ├── dedup/
│   │   └── dedup.ts              # SHA-256 dedup against seen-jobs.json
│   └── email/
│       └── send-email.ts         # Resend integration + HTML templating
├── .github/workflows/
│   ├── job-search.yml            # All sources (manual trigger only)
│   ├── job-search-linkedin.yml   # LinkedIn (daily + every 2h)
│   ├── job-search-anywhere-remote.yml  # Anywhere Remote (daily)
│   ├── job-search-working-nomads.yml   # Working Nomads (daily)
│   └── job-search-ycombinator.yml      # YCombinator (daily)
├── package.json
├── tsconfig.json                 # strict mode, ESNext
├── config.json                   # User-editable search & filter settings
├── seen-jobs.json                # Persisted SHA-256 hashes of sent jobs
├── excluded-jobs.json            # Dev-only audit log of filtered-out jobs
├── runs.log                      # Production newline-delimited JSON run log
└── raw-jobs.json                 # Dev-only checkpoint of all scraped jobs
```

---

## Environment Variables

### Required (production)
| Variable | Purpose |
|---|---|
| `BROWSERLESS_API_KEY` | Browserless.io API token |
| `RESEND_API_KEY` | Resend API key (`re_...`) |
| `MY_EMAIL` | Recipient email address |
| `FROM_EMAIL` | Sender address (must be verified Resend domain) |

### Optional
| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key for AI classification (if missing, all jobs default to "strong") |
| `LINKEDIN_EMAIL` | LinkedIn login (if missing, LinkedIn scraping skipped with error) |
| `LINKEDIN_PASSWORD` | LinkedIn password |
| `LINKEDIN_COOKIES` | LinkedIn cookies JSON (GitHub Actions secret, written to `linkedin-cookies.json`) |
| `YC_EMAIL` | YC/Work at a Startup account email |
| `YC_PASSWORD` | YC password |
| `NODE_ENV` | Set to `"development"` for dev mode |
| `HEADED` | Set to `"true"` for visible browser UI (dev only) |

### Runtime Arguments
- `--hours=N` — Override `maxAgeDays` time window (N hours; max 4320 = 6 months)
- `--source=<name>` — Run only a single scraper source (`linkedin`, `anywhere-remote`, `working-nomads`, `ycombinator`)

---

## NPM Scripts

```bash
npm start                    # Production: no .env, secrets from environment
npm run dev                  # Development: loads .env, saves excluded/raw, quiet if no new jobs
npm run dev:headed           # Dev with visible Chrome
npm run dev -- --hours=48    # Override time window
npm run dev:linkedin         # Dev: only LinkedIn scraper
npm run dev:anywhere-remote  # Dev: only Anywhere Remote scraper
npm run dev:working-nomads   # Dev: only Working Nomads scraper
npm run dev:ycombinator      # Dev: only YC scraper
npm run typecheck            # tsc --noEmit
```

Per-source scripts can be combined with other flags: `npm run dev:linkedin -- --hours=48`

---

## Data Structures (`src/types.ts`)

### `JobSource`
```typescript
type JobSource = 'linkedin' | 'ycombinator' | 'anywhere-remote' | 'working-nomads';
```

### `RawJob`
Produced by all scrapers, consumed by filters.
```typescript
{
  title: string;
  company: string;
  location: string;
  datePosted: string | null;   // ISO 8601 or null if unparseable
  url: string;
  description: string;          // Job description text or tag list
  source: JobSource;
  scrapedAt: string;            // ISO 8601 timestamp
}
```

### `FilteredJob`
Extends `RawJob`; output of filter pass, input to dedup and AI classification.
```typescript
extends RawJob {
  isHighPriority: boolean;
  priorityReasons: string[];    // e.g. ["contractor/freelance", "salary $85/hr"]
}
```

### `AIMatch`
```typescript
type AIMatch = 'strong' | 'weak' | 'excluded';
```

### `AIClassifiedJob`
Extends `FilteredJob`; output of AI classification, input to email.
```typescript
extends FilteredJob {
  aiMatch: AIMatch;
  aiReason: string;             // e.g. "Core React role at mid-size startup"
}
```

### `InlineFilterStats`
Tracks what the inline filter skipped during scraping.
```typescript
{
  skippedAsSeen: number;
  skippedByHardExclusion: number;
  excludedJobs: ExcludedJob[];
}
```

### `ScrapeResult`
Return type of every scraper function.
```typescript
{
  source: JobSource;
  jobs: RawJob[];
  errors: string[];
  inlineStats: InlineFilterStats;
}
```

### `EmailReport`
Input to the email system.
```typescript
{
  totalFound: number;
  totalAfterFilter: number;
  totalNew: number;
  totalStrong: number;
  totalWeak: number;
  strongBySource: Partial<Record<JobSource, AIClassifiedJob[]>>;
  weakBySource: Partial<Record<JobSource, AIClassifiedJob[]>>;
  date: string;
  scraperErrors: string[];
}
```

### `SeenJobsStore`
Persisted in `seen-jobs.json`; committed to repo by GitHub Actions.
```typescript
{
  lastUpdated: string;          // ISO 8601
  hashes: string[];             // SHA-256 hashes of all previously sent jobs
}
```

### `ExcludedJob`
```typescript
{
  title: string;
  company: string;
  url: string;
  source: JobSource;
  datePosted: string;           // ISO or 'unknown'
  excludedAt: string;           // ISO timestamp
  reasons: string[];            // e.g. ["us-only", "no-skills-or-title-match"]
}
```

### `RunLogEntry`
One JSON line appended to `runs.log` per production run.
```typescript
{
  startedAt: string;
  finishedAt: string;
  seenJobsTotal: number;
  rawJobsFound: number;
  newJobsFound: number;
  excludedJobs: {
    bySource: Record<JobSource, number>;
    total: number;
  };
  errors: {
    bySource: Record<JobSource, string[]>;
    global: string[];
  };
}
```

---

## Configuration System (`config.json` + `src/config.ts`)

`loadConfig()` reads `config.json` and validates at least 1 skill and 1 jobTitle.

`getSearchTerms(config)` returns a deduplicated array of skills + jobTitle for use as search queries.

### Full `config.json` Schema

```jsonc
{
  "scraping": {
    "maxPages": 2,              // Max result pages per search query
    "maxJobs": 10,              // Max jobs per search combination
    "maxAgeDays": 7,            // Job age cutoff in days (overridable with --hours=N)
    "minDelayMs": 1000          // Minimum delay between scraping actions
  },
  "filters": {
    "geoLocations": ["worldwide", "europe"],
    "skills": ["react"],                    // REQUIRED: ≥1. Used as search queries AND title/desc matching
    "jobTitle": ["frontend"],               // REQUIRED: ≥1. Used for inclusion matching
    "experience": ["mid", "senior"],        // Options: junior|mid|senior|lead|staff|principal|director|c-level
    "contractTypes": [],                    // Empty = all types. Options: full-time|part-time|contract|freelance|temporary
    "language": ["english", "spanish"],
    "remote": true,
    "excludeUsOnly": true,
    "excludeIndia": true,
    "excludeUae": true,
    "excludeSoutheastAsia": true,
    "excludeClearance": true,
    "excludeOnSite": true,
    "excludeHybrid": true,
    "excludeEquityOnly": true,             // Blocks equity-only / unpaid roles
    "excludeCrypto": true,                 // Blocks crypto/blockchain/DeFi jobs
    "excludedCompanies": ["micro1"],       // Case-insensitive company name matches
    "excludeSkills": [".net", "java"],     // Terms to block in title/description
    "salary": {
      "hour": null,                        // null = no filter. Excludes if salary found AND below
      "month": null,
      "annual": null
    },
    "prioritySalary": {
      "hourMin": 40,                       // Flag as high priority if salary ≥ this
      "annualMin": 80000
    }
  }
}
```

Note: `geoLocations`, `skills`, and `jobTitle` are inside the `filters` section (no separate `search` section).

### GeoLocation → LinkedIn GeoId mapping
| Config value | LinkedIn geoId | AnywhereRemote param |
|---|---|---|
| `latam` | `91000011` | `LATAM` |
| `usa` | `103644278` | `United States` |
| `europe` | `91000000` | `European Union` |
| `worldwide` | `92000000` | `Worldwide` |

---

## Pipeline Architecture (`src/index.ts`)

8 sequential phases:

1. **Environment Validation** — Check required env vars exist
2. **Config Loading** — `loadConfig()`, validate skills/jobTitle arrays non-empty
3. **Browser Connection** — `getBrowser()`: Browserless WebSocket or local Chrome (with 10s retry on failure). Each scraper gets a fresh browser session via `withFreshBrowser()`.
4. **Scraping** — Run LinkedIn → AnywhereRemote → Working Nomads → YCombinator (or single source via `--source`). Inline filter applied during scraping to skip seen/excluded jobs early.
5. **Filtering** — `filterJobs(allJobs, config)`: 3-pass filter, returns `FilteredJob[]`
6. **Deduplication** — `deduplicateJobs(filtered)`: SHA-256 hash check against `seen-jobs.json`
7. **AI Classification** — `classifyJobs(newJobs, config)`: Claude Haiku classifies each job as strong/weak/excluded
8. **Email & Persistence** — Send email via Resend (strong + weak sections), write updated `seen-jobs.json`, append `runs.log`

---

## Inline Filtering (`src/filters/inline-filter.ts`)

Applied **during scraping** to avoid collecting jobs that would be filtered out later.

`createInlineFilter(config, persistedHashes)` returns an `InlineJobFilter` with:
- `check(job)` — Returns job if it passes, `null` if filtered
- `checkBatch(jobs)` — Batch version
- `keptCount` — Running count of passing jobs
- `stats` — Accumulated `InlineFilterStats`

Three-level dedup:
1. SHA-256 hash against persisted jobs (from `seen-jobs.json`)
2. SHA-256 hash against jobs seen this run
3. Title + company combo key (catches same job across different URLs)

Also applies hard exclusions from `filter-jobs.ts` during scraping.

---

## Scraper Details

### LinkedIn (`src/scrapers/linkedin.ts`)

**Authentication:**
- Logs in via email/password (env: `LINKEDIN_EMAIL`, `LINKEDIN_PASSWORD`)
- Supports cookie-based auth via `linkedin-cookies.json` (restored from `LINKEDIN_COOKIES` secret in CI)
- If both missing → returns `ScrapeResult` with error, no scraping
- Human-like typing (80–150ms per character), random mouse movements
- Detects auth walls: `/login`, `/checkpoint`, `/authwall` in URL → stops

**Search URL construction:**
```
https://www.linkedin.com/jobs/search/?keywords={skill}&geoId={id}&f_E={codes}&f_JT={codes}&f_WT=2&f_TPR=r{seconds}&sortBy=DD
```

**Experience → f_E code mapping:**
| Config | f_E codes |
|---|---|
| junior | 1, 2 |
| mid, senior, lead, staff, principal | 3, 4 |
| director | 5 |
| c-level | 6 |

**Contract type → f_JT code mapping:**
| Config | f_JT code |
|---|---|
| full-time | F |
| part-time | P |
| contract, freelance | C |
| temporary | T |

**Time range:** `f_TPR=r{maxAgeDays * 86400}` (seconds)

**Extraction flow:**
1. Login (cookies or email/password)
2. For each `(geoLocation × skill)` combination:
   - Navigate to search URL
   - Paginate (limited by `maxPages`)
   - Click each job card, wait for detail panel
   - Extract: title (h1), company, location (bullet element), description (3000 chars max)
   - Parse datePosted from `<time datetime="...">` attribute
   - Inline filter applied per job
   - Skip URL duplicates
3. Delays: 2–5s between actions, 5–9s between skills, 8–12s between geos

---

### YCombinator / Work at a Startup (`src/scrapers/ycombinator.ts`)

**Authentication:** Logs in via `YC_EMAIL`, `YC_PASSWORD`

**Search URL:**
```
https://www.workatastartup.com/companies?query={skill}&sort=created_desc[&remote=yes&remote=only]
```
- Skips skills already present in `jobTitle` to avoid duplicates
- Adds `remote=yes&remote=only` if `config.filters.remote === true`
- No geo filtering supported (always global)

**Extraction flow:**
1. Login
2. For each skill query:
   - Navigate to search URL
   - Wait for React hydration (`directory-list` selector)
   - Scroll 5× (infinite scroll, ~10 jobs per scroll) or until `maxJobs` reached
   - Extract company cards → job items (title, tags array, URL)
   - Inline filter applied per job
   - Tags stored as both `location` and `description`
3. Delays: 5–9s between queries

---

### Anywhere Remote Jobs (`src/scrapers/anywhere-remote.ts`)

**No authentication required.**

**Search URL:**
```
https://anywhereremotejobs.com/remote-jobs?country[0]=LATAM&tech[0]=react&experience[0]=Mid-level&hide_reposts=1
```

**Experience → param mapping:**
| Config | Param value |
|---|---|
| junior | Junior |
| mid | Mid-level |
| senior, lead, staff, principal, director, c-level | Senior |

**Extraction flow:**
1. Navigate to search URL
2. Paginate (limited by `maxPages`)
3. Extract from each `<article>`: title, company, date, tags (skill/category)
4. Inline filter applied per job
5. Parse relative date ("2 days ago" → ISO)
6. Skip URL duplicates
7. Delays: 2–5s between pages

---

### Working Nomads (`src/scrapers/working-nomads.ts`)

**No authentication required.**

**Base URL:** `https://www.workingnomads.com`

**Experience → param mapping:**
| Config | Param value |
|---|---|
| junior | entry-level |
| mid | mid-level |
| senior, lead, staff, principal, director, c-level | senior |

**Geo → param mapping:**
| Config | Param value |
|---|---|
| latam | latin-america |
| usa | usa, north-america |
| europe | europe |
| worldwide | anywhere |

**Contract type mapping:** full-time, part-time, contract (freelance maps to contract)

**Extraction flow:**
1. Navigate to search URL with skill/geo/experience params
2. Click-based "Show more" pagination
3. Extract job items via CSS selectors (title, company, date, description)
4. Inline filter applied per job
5. Delays: 5–9s between skill searches

---

## Filtering System (`src/filters/filter-jobs.ts`)

Three sequential passes. Each excluded job records its `reasons[]`.

### Pass 1: Hard Exclusions

| Reason key | Config flag | Pattern |
|---|---|---|
| `us-only` | `excludeUsOnly` | US citizen/work auth patterns |
| `clearance-required` | `excludeClearance` | Security clearance patterns |
| `experience-{level}` | derived from `experience` | Title matches a level NOT in config |
| `on-site` | `excludeOnSite` | On-site/in-office/must relocate patterns |
| `hybrid` | `excludeHybrid` | Hybrid work patterns |
| `india-market` | `excludeIndia` | Indian city names + ₹ symbol |
| `uae-gulf-market` | `excludeUae` | UAE/Gulf city names |
| `southeast-asia` | `excludeSoutheastAsia` | SEA country names + currency symbols |
| `excluded-company` | `excludedCompanies[]` | Case-insensitive company name match |
| `excluded-skill` | `excludeSkills[]` | Term found in title or description |
| `equity-only` | `excludeEquityOnly` | Equity-only / unpaid role patterns |
| `crypto` | `excludeCrypto` | Crypto/blockchain/DeFi terms + coin symbols |
| `too-old` | derived from `maxAgeDays` | `datePosted` outside time window |

### Pass 2: Required Inclusions

| Reason key | Condition |
|---|---|
| `no-skills-or-title-match` | Must match at least 1 skill OR 1 jobTitle in title/description |
| `not-remote` | If `filters.remote=true`, `/\bremote\b/i` must match location or description |
| `no-contract-type` | If `contractTypes` non-empty, must match at least one type pattern |
| `salary-below-minimum` | If salary found AND below ALL configured salary minimums → excluded |

### Pass 3: Priority Flags

Sets `isHighPriority=true` and appends to `priorityReasons[]`.

| Trigger | Pattern / Condition |
|---|---|
| Contractor/freelance | `/\b(contractor\|freelance)\b/i` in title or description |
| AI-related | `/\b(ai\|openai\|automation\|n8n\|llm\|machine\s+learning\|artificial\s+intelligence)\b/i` |
| Company size 50–499 | `/\b([5-9]\d\|[1-4]\d\d)\s*employees?\b/i` in description |
| Salary threshold | `hourly >= prioritySalary.hourMin` OR `annual >= prioritySalary.annualMin` |

**Key exports:** `buildHardExclusionContext()`, `getHardExclusionReasons()`, `filterJobs()`, `saveRawJobs()`, `saveExcludedJobs()`

---

## AI Classification (`src/ai-filter/ai-filter.ts`)

Post-filter classification using Claude Haiku to improve signal-to-noise ratio in emails.

`classifyJobs(jobs, config)` → `AIClassifiedJob[]`

- **Model:** `claude-haiku-4-5-20251001`
- **Concurrency:** Max 5 concurrent API calls via worker pool
- **Classification:** "strong" (target role + skills central), "weak" (incidental match), "excluded" (not relevant or wrong language)
- **Fallback:** Missing API key → all jobs default to "strong". API error → individual job defaults to "strong".
- **Only strong + weak jobs are emailed.** AI-excluded jobs logged to `excluded-jobs.json` in dev mode.

---

## Deduplication (`src/dedup/dedup.ts`)

**Hash key:** `sha256([company, title, url].map(s => s.toLowerCase().trim()).join('|'))`

Only jobs that pass AI classification (strong + weak) are persisted to `seen-jobs.json`. AI-excluded jobs can reappear in future runs.

---

## Email System (`src/email/send-email.ts`)

- **From:** `FROM_EMAIL` → **To:** `MY_EMAIL`
- **Two sections:** "Job Matches" (strong) + "Other Matches" (weak, with AI reasoning)
- **Job cards:** High priority = yellow/amber background + priority badges; Regular = light gray border
- **No-jobs email:** Production only

---

## GitHub Actions (`.github/workflows/`)

### Per-source workflows (scheduled)

Each source has its own workflow running `npm start -- --source=<name>`:

| Workflow | Schedule | Concurrency group |
|---|---|---|
| `job-search-linkedin.yml` | `2 */2 * * *` (every 2h) + `2 5 * * *` (daily) | `job-search-linkedin` |
| `job-search-anywhere-remote.yml` | `2 5 * * *` (daily 6:02 CET) | `job-search-anywhere-remote` |
| `job-search-working-nomads.yml` | `2 5 * * *` (daily 6:02 CET) | `job-search-working-nomads` |
| `job-search-ycombinator.yml` | `2 5 * * *` (daily 6:02 CET) | `job-search-ycombinator` |

All workflows: `workflow_dispatch` enabled, `contents: write` permissions.
Steps: Checkout → Node.js 20 → `npm ci` → (LinkedIn: restore cookies) → `npm start -- --source=X` → Commit `seen-jobs.json` + `runs.log` → Push.

### All-sources workflow (manual only)

`job-search.yml` — Runs all scrapers. Trigger: `workflow_dispatch` only (no schedule).

---

## Dev vs Production

| Behavior | Development (`NODE_ENV=development`) | Production (GitHub Actions) |
|---|---|---|
| Browser | Local Chrome | Browserless.io WebSocket (stealth mode) |
| Visible UI | `HEADED=true` enables it | Never |
| `raw-jobs.json` | Saved | Not saved |
| `excluded-jobs.json` | Saved (filtered + AI-excluded) | Not saved |
| Email if no new jobs | Skipped | Sent |
| `runs.log` | Not appended | Appended |
| `.env` file | Loaded automatically | Not used |

---

## All Exclusion Reason Keys

```
us-only, clearance-required, experience-{level}, on-site, hybrid,
india-market, uae-gulf-market, southeast-asia, excluded-company,
excluded-skill, equity-only, crypto, too-old,
no-skills-or-title-match, not-remote, no-contract-type,
salary-below-minimum, ai-filter
```

---

## Edge Cases & Invariants

1. **No salary info → never excluded.** Salary minimums only filter jobs with salary data AND below ALL minimums.
2. **Experience matching uses title only** (not description).
3. **`contractTypes: []` means all types allowed.**
4. **YC has no geo support** — always global.
5. **`--hours=N` caps at 4320** (6 months).
6. **Dedup hash includes URL** — same job at new URL = new job.
7. **LinkedIn requires email+password OR cookies.**
8. **Browserless has 1 retry after 10s.**
9. **YC infinite scroll** — up to 5× or until `maxJobs`.
10. **Seen-jobs.json grows indefinitely** — never pruned.
11. **AI-excluded jobs NOT persisted to seen-jobs.json** — can reappear.
12. **AI classification degrades gracefully** — missing key/errors default to "strong".
13. **Each scraper gets a fresh browser session** via `withFreshBrowser()`.
14. **Inline filtering during scraping** prevents collecting doomed jobs.
15. **`--source` flag** runs single scraper but full pipeline continues.
