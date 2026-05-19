# job-finder — Project Reference

## Overview

TypeScript-based daily job search automation that:
1. Scrapes 3 job boards via headless browser (LinkedIn, Work at a Startup/YC, Anywhere Remote Jobs)
2. Filters results using configurable rules (skills, location, experience, contract type, salary, exclusions)
3. Deduplicates against previously seen jobs using SHA-256 hashing
4. Sends curated HTML email digests via Resend
5. Runs daily at 6:02 AM UTC via GitHub Actions
6. Persists state (seen job hashes, run logs) back to the repository

---

## Tech Stack

- **Runtime:** Node.js 20+, TypeScript 5.5.3
- **Module system:** ESNext modules, ES2022 target, ts-node for ESM support
- **Browser automation:** puppeteer-core 22.15.0 (connects to Browserless.io in prod, local Chrome in dev)
- **Email:** resend 3.5.0
- **Scheduling:** GitHub Actions cron (`2 6 * * *`)

---

## File Structure

```
job-finder/
├── src/
│   ├── index.ts                  # Main orchestrator — 7-phase pipeline
│   ├── types.ts                  # All shared TypeScript interfaces
│   ├── config.ts                 # Config loader + AppConfig type
│   ├── browser.ts                # Puppeteer lifecycle (connect/disconnect)
│   ├── logger.ts                 # Run logging (JSON-per-line to runs.log)
│   ├── scrapers/
│   │   ├── utils.ts              # newPage, delay, safeGoto, parseRelativeDate
│   │   ├── linkedin.ts           # LinkedIn Jobs scraper
│   │   ├── ycombinator.ts        # Work at a Startup scraper
│   │   └── anywhere-remote.ts   # Anywhere Remote Jobs scraper
│   ├── filters/
│   │   └── filter-jobs.ts        # 3-pass filter + priority scoring
│   ├── dedup/
│   │   └── dedup.ts              # SHA-256 dedup against seen-jobs.json
│   └── email/
│       └── send-email.ts         # Resend integration + HTML templating
├── .github/workflows/
│   └── job-search.yml            # GitHub Actions schedule
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
| `LINKEDIN_EMAIL` | LinkedIn login (if missing, LinkedIn scraping skipped with error) |
| `LINKEDIN_PASSWORD` | LinkedIn password |
| `YC_EMAIL` | YC/Work at a Startup account email |
| `YC_PASSWORD` | YC password |
| `NODE_ENV` | Set to `"development"` for dev mode |
| `HEADED` | Set to `"true"` for visible browser UI (dev only) |

### Runtime Arguments
- `--hours=N` — Override `maxAgeDays` time window (N hours; max 4320 = 6 months)

---

## NPM Scripts

```bash
npm start              # Production: no .env, secrets from environment
npm run dev            # Development: loads .env, saves excluded/raw, quiet if no new jobs
npm run dev:headed     # Dev with visible Chrome
npm run dev -- --hours=48  # Override time window
npm run typecheck      # tsc --noEmit
```

---

## Data Structures (`src/types.ts`)

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
  source: 'linkedin' | 'ycombinator' | 'anywhere-remote';
  scrapedAt: string;            // ISO 8601 timestamp
}
```

### `FilteredJob`
Extends `RawJob`; output of filter pass, input to dedup and email.
```typescript
extends RawJob {
  isHighPriority: boolean;
  priorityReasons: string[];    // e.g. ["contractor/freelance", "salary $85/hr"]
}
```

### `ScrapeResult`
Return type of every scraper function.
```typescript
{
  source: JobSource;            // 'linkedin' | 'ycombinator' | 'anywhere-remote'
  jobs: RawJob[];
  errors: string[];
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

### `ExcludedJobsStore`
Dev-only, appended to `excluded-jobs.json` per run.
```typescript
{
  lastUpdated: string;
  jobs: {
    title: string;
    company: string;
    url: string;
    source: JobSource;
    datePosted: string;         // ISO or 'unknown'
    excludedAt: string;         // ISO timestamp
    reasons: string[];          // e.g. ["us-only", "no-skills-or-title-match"]
  }[]
}
```

### `RunLogEntry`
One JSON line appended to `runs.log` per production run.
```typescript
{
  startedAt: string;            // ISO 8601
  finishedAt: string;           // ISO 8601
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

### Full `config.json` Schema

```jsonc
{
  "scraping": {
    "maxPages": 1,              // Max result pages per search query
    "maxJobs": 10,              // Max jobs per search combination
    "maxAgeDays": 7             // Job age cutoff in days (overridable with --hours=N)
  },
  "search": {
    "geoLocations": ["latam", "usa", "europe", "worldwide"],
    "skills": ["react", "typescript"],  // REQUIRED: ≥1. Used as search queries AND title/desc matching
    "jobTitle": ["frontend", "full stack"]  // REQUIRED: ≥1. Used for inclusion matching
  },
  "filters": {
    "experience": ["mid", "senior"],    // Options: junior|mid|senior|lead|staff|principal|director|c-level
    "contractTypes": [],                // Empty = all types. Options: full-time|part-time|contract|freelance|temporary
    "language": ["english"],
    "remote": true,
    "excludeUsOnly": true,
    "excludeIndia": true,
    "excludeUae": true,
    "excludeSoutheastAsia": true,
    "excludeClearance": true,
    "excludeOnSite": true,
    "excludeHybrid": true,
    "excludedCompanies": [],            // Case-insensitive company name matches
    "excludeSkills": [".net", "java"],  // Terms to block in title/description
    "salary": {
      "hour": null,                     // null = no filter. Excludes if salary found AND below
      "month": null,
      "annual": null
    },
    "prioritySalary": {
      "hourMin": 40,                    // Flag as high priority if salary ≥ this
      "annualMin": 80000
    }
  }
}
```

### GeoLocation → LinkedIn GeoId mapping
| Config value | LinkedIn geoId | AnywhereRemote param |
|---|---|---|
| `latam` | `91000011` | `LATAM` |
| `usa` | `103644278` | `United States` |
| `europe` | `91000000` | `European Union` |
| `worldwide` | `92000000` | `Worldwide` |

---

## Pipeline Architecture (`src/index.ts`)

7 sequential phases:

1. **Environment Validation** — Check required env vars exist
2. **Config Loading** — `loadConfig()`, validate skills/jobTitle arrays non-empty
3. **Browser Connection** — `getBrowser()`: Browserless WebSocket or local Chrome (with 10s retry on failure)
4. **Scraping** — Run LinkedIn → AnywhereRemote → YCombinator, collect all `ScrapeResult[]`
5. **Filtering** — `filterJobs(allJobs, config)`: 3-pass filter, returns `FilteredJob[]`
6. **Deduplication** — `deduplicateJobs(filtered)`: SHA-256 hash check against `seen-jobs.json`
7. **Email & Persistence** — Send email via Resend, write updated `seen-jobs.json`, append `runs.log`

---

## Scraper Details

### LinkedIn (`src/scrapers/linkedin.ts`)

**Authentication:**
- Logs in via email/password (env: `LINKEDIN_EMAIL`, `LINKEDIN_PASSWORD`)
- If either missing → returns `ScrapeResult` with error, no scraping
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
1. Login
2. For each `(geoLocation × skill)` combination:
   - Navigate to search URL
   - Paginate (limited by `maxPages`)
   - Click each job card, wait for detail panel
   - Extract: title (h1), company, location (bullet element), description (3000 chars max)
   - Parse datePosted from `<time datetime="...">` attribute
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
4. Parse relative date ("2 days ago" → ISO)
5. Skip URL duplicates
6. Delays: 2–5s between pages

---

## Filtering System (`src/filters/filter-jobs.ts`)

Three sequential passes. Each excluded job records its `reasons[]`.

### Pass 1: Hard Exclusions

Applied in order; first match records reason and stops further checks for that job.

| Reason key | Config flag | Pattern |
|---|---|---|
| `us-only` | `excludeUsOnly` | `/\b(US\|U\.S\.\|United States)\s+(citizen\|citizenship\|work\s*auth\|only\|resident\|person)\b/i` |
| `clearance-required` | `excludeClearance` | `/security\s+clearance\|clearance\s+required\|\bcleared\b/i` |
| `experience-{level}` | derived from `experience` | Title matches a level NOT in config (e.g. "senior" in title when config only has ["junior"]) |
| `on-site` | `excludeOnSite` | `/\b(on[- ]?site\|in[- ]office\|in[- ]person\|must\s+relocate)\b/i` |
| `hybrid` | `excludeHybrid` | `/\bhybrid\b/i` |
| `india-market` | `excludeIndia` | `/\b(india\|bangalore\|mumbai\|delhi\|hyderabad\|chennai\|pune\|kolkata\|noida\|gurugram\|...)\b\|₹/i` |
| `uae-gulf-market` | `excludeUae` | `/\b(UAE\|dubai\|abu\s*dhabi\|saudi\s*arabia\|riyadh\|qatar\|doha\|kuwait\|bahrain\|oman\|muscat)\b/i` |
| `southeast-asia` | `excludeSoutheastAsia` | `/\b(vietnam\|thailand\|indonesia\|philippines\|malaysia\|myanmar\|cambodia\|laos\|singapore\|brunei\|timor)\b\|₫\|₱\|(?<!\w)RM\s*\d/i` |
| `excluded-company` | `excludedCompanies[]` | Case-insensitive company name match |
| `excluded-skill` | `excludeSkills[]` | Term found in title or description |

### Pass 2: Required Inclusions

All conditions must be satisfied or the job is excluded.

| Reason key | Condition |
|---|---|
| `no-skills-or-title-match` | Must match at least 1 skill OR 1 jobTitle in title/description |
| `not-remote` | If `filters.remote=true`, `/\bremote\b/i` must match location or description |
| `too-old` | `datePosted` must be within `maxAgeDays * 24` hours (or `--hours=N` override) |
| `no-contract-type` | If `contractTypes` non-empty, must match at least one type pattern |
| `salary-below-minimum` | If salary found AND below ALL configured salary minimums → excluded |

**Salary extraction regex:** `/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*k?\s*(?:\/\|\s+per\s+)?\s*(hr\|hour\|yr\|year\|annual)?/gi`

**Salary conversion logic:**
- If marked `k` and value < 10,000 → multiply by 1,000
- Hourly → annual: `hourly × 2000`
- Annual → hourly: `annual / 2000`
- Monthly: `annual / 12`
- No unit & value < 500 → assume hourly; else assume annual
- Jobs with **no salary info are never excluded** by salary filters

### Pass 3: Priority Flags

Applied after passes 1 & 2. Sets `isHighPriority=true` and appends to `priorityReasons[]`.

| Trigger | Pattern / Condition |
|---|---|
| Contractor/freelance | `/\b(contractor\|freelance)\b/i` in title or description |
| AI-related | `/\b(ai\|openai\|automation\|n8n\|llm\|machine\s+learning\|artificial\s+intelligence)\b/i` |
| Company size 50–499 | `/\b([5-9]\d\|[1-4]\d\d)\s*employees?\b/i` in description |
| Salary threshold | `hourly >= prioritySalary.hourMin` OR `annual >= prioritySalary.annualMin` |

---

## Deduplication (`src/dedup/dedup.ts`)

**Hash key:**
```
key = [company.toLowerCase().trim(), title.toLowerCase().trim(), url].join('|')
hash = sha256(key)
```

**Logic:**
1. Load `seen-jobs.json` → put all hashes in a `Set`
2. For each `FilteredJob`, compute hash
3. If hash not in Set → new job (add to results, add hash to Set)
4. Write updated `seen-jobs.json` with merged old + new hashes
5. GitHub Actions commits the updated file back to the repo

---

## Email System (`src/email/send-email.ts`)

**Resend config:**
- From: `Job Finder BOT <{FROM_EMAIL}>`
- To: `MY_EMAIL`

**Subject lines:**
- With new jobs: `🔍 Job Search Results - {date} - {N} new jobs found`
- No new jobs: `No new jobs today. Keep going 💪`

**HTML template structure:**
1. Dark header bar — "🔍 Job Search Results" + date
2. Summary bar — raw found | after filters | new (counts)
3. Job cards grouped by source (LinkedIn → YC → AnywhereRemote)
4. Footer — statistics + source names

**Job card variants:**
- **High priority:** Yellow/amber background, "⭐ High Priority" label, yellow badge pills for each `priorityReason`
- **Regular:** Light gray border
- Both contain: title (link), company, location, datePosted, description snippet, priority badges if applicable

**No-jobs email:** Sends "No new jobs today. Keep going 💪" body (production always sends; dev skips if no new jobs).

---

## Run Logging (`src/logger.ts`)

**`runs.log`** — newline-delimited JSON, production only.

```json
{
  "startedAt": "2026-05-19T06:02:00.000Z",
  "finishedAt": "2026-05-19T06:08:42.000Z",
  "seenJobsTotal": 347,
  "rawJobsFound": 63,
  "newJobsFound": 4,
  "excludedJobs": {
    "bySource": { "linkedin": 28, "ycombinator": 12, "anywhere-remote": 19 },
    "total": 59
  },
  "errors": {
    "bySource": { "linkedin": [], "ycombinator": [], "anywhere-remote": [] },
    "global": []
  }
}
```

---

## GitHub Actions (`.github/workflows/job-search.yml`)

- **Trigger:** `cron: '2 6 * * *'` (daily 6:02 AM UTC)
- **Permissions:** `contents: write`
- **Steps:**
  1. Checkout repo
  2. Setup Node.js 20 (npm cache)
  3. `npm ci`
  4. `npm start` (env vars injected from GitHub Secrets)
  5. Git config + commit `seen-jobs.json` if changed (commit message includes `[skip ci]`)
  6. `git push`

---

## Dev vs Production

| Behavior | Development (`NODE_ENV=development`) | Production (GitHub Actions) |
|---|---|---|
| Browser | Local Chrome at `/Applications/Google Chrome.app/...` | Browserless.io WebSocket |
| Visible UI | `HEADED=true` enables it | Never |
| `raw-jobs.json` | Saved (all scraped jobs) | Not saved |
| `excluded-jobs.json` | Saved (filtered jobs with reasons) | Not saved |
| Email if no new jobs | Skipped (quiet mode) | Sent (confirms script ran) |
| `runs.log` | Not appended | Appended |
| `.env` file | Loaded automatically | Not used |

---

## Shared Utilities

### `src/scrapers/utils.ts`

| Function | Signature | Purpose |
|---|---|---|
| `newPage` | `(browser) => Promise<Page>` | Creates page with spoofed user-agent, viewport, webdriver detection bypass |
| `delay` | `(min: number, max: number) => Promise<void>` | Random delay in ms |
| `safeGoto` | `(page, url, timeout?) => Promise<void>` | Wrapped `page.goto` with error handling |
| `parseRelativeDate` | `(raw: string) => string \| null` | Converts "2 days ago", "just now", ISO strings → ISO 8601 |

**`parseRelativeDate` handles:**
- ISO strings (`/^\d{4}-\d{2}-\d{2}/`) → returned as-is
- `"just now"` / `"today"` → current time
- `"X minutes ago"`, `"X hours ago"`, `"X days ago"`, `"X weeks ago"`

### `src/browser.ts`

| Function | Purpose |
|---|---|
| `getBrowser()` | Returns Browserless WebSocket connection (prod) or local Chrome (dev); 1 retry after 10s |
| `closeBrowser(browser)` | Closes local browser or disconnects from Browserless |

### `src/config.ts`

| Function | Purpose |
|---|---|
| `loadConfig()` | Reads `config.json`, validates required fields, returns typed `AppConfig` |

---

## All Exclusion Reason Keys

Used in `excluded-jobs.json` `reasons[]` array:

```
us-only
clearance-required
experience-junior | experience-mid | experience-senior | experience-lead | experience-staff | experience-principal | experience-director | experience-c-level
on-site
hybrid
india-market
uae-gulf-market
southeast-asia
excluded-company
excluded-skill
no-skills-or-title-match
not-remote
too-old
no-contract-type
salary-below-minimum
```

---

## Edge Cases & Invariants

1. **No salary info → never excluded.** Salary minimums only filter jobs that have salary data AND fall below ALL configured minimums simultaneously.
2. **Experience matching uses title only** (not description) to detect experience level for exclusion.
3. **`contractTypes: []` means all types allowed** — no `f_JT` param on LinkedIn (F, C, T all included).
4. **YC has no geo support** — always searches globally regardless of `geoLocations` config.
5. **`--hours=N` caps at 4320** (6 months) to prevent unbounded scraping.
6. **Dedup hash includes URL** — same job reposted at a new URL will be treated as new.
7. **LinkedIn requires both email + password** — missing either returns error, not partial scraping.
8. **Browserless has 1 retry after 10s** on initial connection failure.
9. **YC infinite scroll** — scrolls up to 5× or until `maxJobs` reached or no new content loads.
10. **Seen-jobs.json grows indefinitely** — hashes are never pruned (acceptable for daily job counts).
