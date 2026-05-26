# Job Finder

Automated daily job search that scrapes multiple job boards, filters results with configurable rules, classifies matches using AI, and sends curated email digests.

## How It Works

1. **Scrape** 4 job boards via headless browser (LinkedIn, YC/Work at a Startup, Anywhere Remote Jobs, Working Nomads)
2. **Filter** using configurable rules — skills, location, experience, salary, exclusions — with inline filtering during scraping for efficiency
3. **Deduplicate** against previously seen jobs (SHA-256 hashes persisted in `seen-jobs.json`)
4. **Classify** with AI (Claude Haiku) into strong/weak/excluded matches
5. **Email** a curated HTML digest via Resend, with strong and weaker matches separated
6. **Persist** state back to the repo via GitHub Actions

Each source runs on its own scheduled GitHub Actions workflow every 4 hours starting at 0:00 CET, spaced 10 minutes apart (LinkedIn runs last). An all-sources workflow is available via manual `workflow_dispatch`.

## Setup

### Prerequisites

- Node.js 20+
- A [Browserless.io](https://www.browserless.io/) account (production) or local Chrome (dev)
- A [Resend](https://resend.com/) account with a verified sender domain
- (Optional) An [Anthropic](https://www.anthropic.com/) API key for AI classification

### Environment Variables

Create a `.env` file for local development:

```env
# Required
BROWSERLESS_API_KEY=your_browserless_key
RESEND_API_KEY=re_your_resend_key
MY_EMAIL=you@example.com
FROM_EMAIL=jobs@yourdomain.com

# Optional — AI classification (without this, all jobs default to "strong")
ANTHROPIC_API_KEY=sk-ant-your_key

# Optional — LinkedIn (without these, LinkedIn scraping is skipped)
LINKEDIN_EMAIL=your@email.com
LINKEDIN_PASSWORD=your_password

# Optional — YC / Work at a Startup
YC_EMAIL=your@email.com
YC_PASSWORD=your_password
```

### Install & Run

```bash
npm install

# Run all scrapers in dev mode
npm run dev

# Run a single scraper
npm run dev:linkedin
npm run dev:anywhere-remote
npm run dev:working-nomads
npm run dev:ycombinator

# Override time window (hours)
npm run dev -- --hours=48
npm run dev:linkedin -- --hours=24

# Dev with visible browser
npm run dev:headed

# Production (no .env, secrets from environment)
npm start

# Type check
npm run typecheck
```

## Configuration

Edit `config.json` to customize search and filter behavior:

```jsonc
{
  "scraping": {
    "maxPages": 2,              // Max result pages per search query
    "maxJobs": 10,              // Max jobs per search combination
    "maxAgeDays": 7,            // Job age cutoff (overridable with --hours=N)
    "minDelayMs": 1000          // Minimum delay between scraping actions
  },
  "filters": {
    "geoLocations": ["worldwide", "europe"],  // latam | usa | europe | worldwide
    "skills": ["react"],                       // Search terms + inclusion matching
    "jobTitle": ["frontend"],                  // Inclusion matching
    "experience": ["mid", "senior"],           // junior|mid|senior|lead|staff|principal|director|c-level
    "contractTypes": [],                       // Empty = all. full-time|part-time|contract|freelance|temporary
    "language": ["english", "spanish"],        // Used by AI filter for language matching
    "remote": true,
    "excludeUsOnly": true,
    "excludeIndia": true,
    "excludeUae": true,
    "excludeSoutheastAsia": true,
    "excludeClearance": true,
    "excludeOnSite": true,
    "excludeHybrid": true,
    "excludeEquityOnly": true,
    "excludeCrypto": true,
    "excludeReposted": true,                 // Blocks reposted/republished job listings
    "excludedCompanies": ["micro1"],
    "excludeSkills": [".net", "java"],
    "salary": { "hour": null, "month": null, "annual": null },
    "prioritySalary": { "hourMin": 40, "annualMin": 80000 }
  }
}
```

## Pipeline

```
Scrape (with inline filtering)
  → Global filter (hard exclusions → required inclusions → priority flags)
  → Deduplication (SHA-256 vs seen-jobs.json)
  → AI Classification (Claude Haiku: strong / weak / excluded)
  → Email (strong matches + other matches, grouped by source)
  → Persist (seen-jobs.json + runs.log)
```

## Job Sources

| Source | Auth Required | Geo Support | Notes |
|---|---|---|---|
| LinkedIn | Email+password or cookies | Yes (geoId) | Human-like interaction delays |
| YC / Work at a Startup | Email+password | No (always global) | Infinite scroll, React hydration |
| Anywhere Remote Jobs | None | Yes (country param) | Pagination, relative date parsing |
| Working Nomads | None | Yes (region param) | "Show more" button pagination |

## AI Classification

After filtering and dedup, new jobs are classified by Claude Haiku into:

- **Strong** — Target role with target skills central to the job
- **Weak** — Incidental skill match or tangentially related
- **Excluded** — Not relevant or requires languages outside config

If `ANTHROPIC_API_KEY` is not set, all jobs default to "strong" (graceful degradation).

## GitHub Actions

Each source has its own workflow in `.github/workflows/`:

| Workflow | Schedule (UTC) | CET times |
|---|---|---|
| `job-search-anywhere-remote.yml` | `0 23,3,7,11,15,19 * * *` | 0:00, 4:00, 8:00, 12:00, 16:00, 20:00 |
| `job-search-working-nomads.yml` | `10 23,3,7,11,15,19 * * *` | +10 min |
| `job-search-ycombinator.yml` | `20 23,3,7,11,15,19 * * *` | +20 min |
| `job-search-linkedin.yml` | `30 23,3,7,11,15,19 * * *` | +30 min |
| `job-search.yml` | Manual only | (all sources) |

Each workflow scrapes its source, filters, deduplicates, classifies, sends an email digest, and commits `seen-jobs.json` + `runs.log`. Concurrency groups prevent overlapping runs per source.

Secrets required: `BROWSERLESS_API_KEY`, `RESEND_API_KEY`, `MY_EMAIL`, `FROM_EMAIL`, `ANTHROPIC_API_KEY`, `LINKEDIN_EMAIL`, `LINKEDIN_PASSWORD`, `LINKEDIN_COOKIES`, `YC_EMAIL`, `YC_PASSWORD`.

## Dev vs Production

| Behavior | Development | Production |
|---|---|---|
| Browser | Local Chrome | Browserless.io |
| `raw-jobs.json` | Saved | Not saved |
| `excluded-jobs.json` | Saved | Not saved |
| Email if no jobs | Skipped | Sent |
| `runs.log` | Not appended | Appended |

## Tech Stack

- **TypeScript** + ts-node (ESM)
- **puppeteer-core** — Headless browser automation
- **@anthropic-ai/sdk** — AI job classification
- **resend** — Email delivery
- **GitHub Actions** — Scheduling + state persistence
