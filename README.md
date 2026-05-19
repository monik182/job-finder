# job-finder

Daily job search automation that scrapes three job boards and emails a filtered digest of remote developer positions.

## How it works

1. Runs every morning at **6:02 AM UTC** (7:02 AM CET / 8:02 AM CEST) via GitHub Actions
2. Scrapes **LinkedIn**, **Work at a Startup (YC)**, and **Anywhere Remote Jobs** via [Browserless](https://browserless.io)
3. Filters results based on `config.json` — skills, location, experience, contract type, and more
4. Deduplicates against previously seen jobs stored in `seen-jobs.json`
5. Sends a clean HTML digest email via [Resend](https://resend.com)
6. Commits the updated `seen-jobs.json` back to the repo

## Setup

### 1. Clone and install

```bash
git clone https://github.com/monik182/job-finder.git
cd job-finder
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Description |
|---|---|
| `BROWSERLESS_API_KEY` | Your [Browserless](https://browserless.io) API key |
| `RESEND_API_KEY` | Your [Resend](https://resend.com) API key (`re_...`) |
| `MY_EMAIL` | Your email address (where results are sent) |
| `FROM_EMAIL` | Sender address (must be a verified Resend domain, e.g. `jobs@yourdomain.com`) |

### 3. Add GitHub Secrets

In your repo go to **Settings → Secrets and variables → Actions** and add:

- `BROWSERLESS_API_KEY`
- `RESEND_API_KEY`
- `MY_EMAIL`
- `FROM_EMAIL`

### 4. Configure `config.json`

Edit `config.json` at the project root to set your search preferences (skills, locations, filters). See the [Configuration](#configuration) section below.

### 5. Run locally

```bash
npm run dev
```

> **Note:** Use `npm run dev` (not `npm start`) locally — it loads your `.env` file via Node's `--env-file` flag. `npm start` skips `.env` and is used by GitHub Actions, where secrets are injected directly into the environment.

You can also override the time window at runtime:

```bash
npm run dev -- --hours=48
```

### 5. Trigger manually in GitHub Actions

Go to **Actions → Daily Job Search → Run workflow**.

## Project structure

```
src/
  index.ts                  Main orchestrator
  types.ts                  Shared TypeScript interfaces
  browser.ts                Browserless WebSocket connection
  scrapers/
    utils.ts                Shared scraper helpers
    linkedin.ts             LinkedIn public job search
    ycombinator.ts          Work at a Startup (YC)
    anywhere-remote.ts      Anywhere Remote Jobs
  filters/
    filter-jobs.ts          Filtering and priority flagging logic
  dedup/
    dedup.ts                SHA-256 deduplication against seen-jobs.json
  email/
    send-email.ts           Resend integration + HTML email template
seen-jobs.json              Tracks previously emailed jobs (committed to repo)
.github/workflows/
  job-search.yml            Daily GitHub Actions schedule
```

## Configuration

All scraping and filtering behaviour is controlled by `config.json` at the project root. No code changes needed — just edit the file and re-run.

---

### `scraping`

Global limits applied to every scraper.

| Field | Type | Default | Description |
|---|---|---|---|
| `maxPages` | `number` | `1` | Max pages to paginate per search query |
| `maxJobs` | `number` | `10` | Max jobs to collect per search query / combination |
| `maxAgeDays` | `number` | `7` | Only keep jobs posted within this many days. Also sets LinkedIn's `f_TPR` time filter. Override at runtime with `--hours=N` |

---

### `filters`

#### Search scope

| Field | Type | Description |
|---|---|---|
| `geoLocations` | `("latam" \| "usa" \| "europe" \| "worldwide")[]` | Regions to search. Drives scraper URLs directly — LinkedIn geoId and Anywhere Remote country param. YC does not support geo filtering. |
| `skills` | `string[]` | Tech skills used as **search query terms** in scrapers AND matched against job text. Must have at least one entry. |
| `jobTitle` | `string[]` | Job title variations (e.g. `"frontend"`, `"front-end"`). A job passes if its text matches any skill **or** any job title. Must have at least one entry. |

**Geo location mapping:**

| Value | LinkedIn geoId | Anywhere Remote |
|---|---|---|
| `latam` | `91000011` — Latin America | `LATAM` |
| `usa` | `103644278` — United States | `United States` |
| `europe` | `91000000` — European Union | `European Union` |
| `worldwide` | `92000000` — Worldwide | `Worldwide` |

---

#### Experience & contract

| Field | Type | Default | Description |
|---|---|---|---|
| `experience` | `ExperienceLevel[]` | `["mid", "senior"]` | Allowed experience levels. Jobs with titles matching a level **not** in this list are excluded. Also sets LinkedIn `f_E` and Anywhere Remote `experience` URL params. |
| `contractTypes` | `ContractType[]` | `[]` | Allowed contract types. Empty = no filter. If non-empty, job text must match at least one type. Also sets LinkedIn `f_JT`. |
| `language` | `string[]` | `["english"]` | Accepted job posting languages. If `"spanish"` is absent, jobs with Spanish-language markers in the text are excluded. |

**Experience levels:** `"junior"` · `"mid"` · `"senior"` · `"lead"` · `"staff"` · `"principal"` · `"director"` · `"c-level"`

**Contract types:** `"full-time"` · `"part-time"` · `"contract"` · `"freelance"` · `"temporary"`

**Experience → LinkedIn `f_E` mapping:**

| Config level | LinkedIn code |
|---|---|
| `junior` | 1, 2 (Internship, Entry Level) |
| `mid` | 3, 4 (Associate, Mid-Senior) |
| `senior` / `lead` / `staff` / `principal` | 4 (Mid-Senior) |
| `director` | 5 |
| `c-level` | 6 (Executive) |

---

#### Hard exclusions

Boolean flags — set to `false` to disable. All default to `true`.

| Field | Excludes jobs that… |
|---|---|
| `excludeUsOnly` | Require US citizenship or work authorization |
| `excludeIndia` | Mention India, Indian cities, or ₹ |
| `excludeUae` | Mention UAE, Gulf countries, Saudi Arabia, Qatar, Kuwait, Bahrain, or Oman |
| `excludeSoutheastAsia` | Mention SEA countries (Vietnam, Thailand, Indonesia, Philippines, Malaysia, Singapore, Myanmar, Cambodia, Laos, Brunei, Timor) or their currencies |
| `excludeClearance` | Require security clearance |
| `excludeOnSite` | Mention on-site, in-office, in-person, or must relocate |
| `excludeHybrid` | Mention hybrid |
| `remote` | Do not include "remote" in location or description |

---

#### List exclusions

| Field | Type | Description |
|---|---|---|
| `excludedCompanies` | `string[]` | Company names to skip (case-insensitive match). |
| `excludeSkills` | `string[]` | Skills to block. Jobs mentioning any of these in title or description are excluded (e.g. `[".net", "java", "c#"]`). |

---

#### Salary

| Field | Type | Default | Description |
|---|---|---|---|
| `salary.hour` | `number \| null` | `null` | Minimum hourly rate. Jobs listing a salary **below** this are excluded. Jobs with no salary info are not affected. |
| `salary.month` | `number \| null` | `null` | Minimum monthly rate. Same logic. |
| `salary.annual` | `number \| null` | `null` | Minimum annual salary. Same logic. |
| `prioritySalary.hourMin` | `number` | `40` | Hourly threshold for flagging a job as high-priority (shown first in email). |
| `prioritySalary.annualMin` | `number` | `80000` | Annual threshold for flagging a job as high-priority. |

---

#### High-priority flags

Jobs passing all filters are additionally checked for priority signals (surfaced first in the email digest):

- Salary ≥ `prioritySalary.hourMin`/hr or ≥ `prioritySalary.annualMin`/year
- Explicitly contractor or freelance
- Mentions AI, OpenAI, LLM, automation, or n8n
- Company size 50–499 employees

---

### Full `config.json` example

```json
{
  "scraping": {
    "maxPages": 1,
    "maxJobs": 10,
    "maxAgeDays": 7
  },
  "filters": {
    "geoLocations": ["latam", "europe"],
    "skills": ["react", "angular", "typescript", "next.js", "node.js"],
    "jobTitle": ["frontend", "front-end", "fullstack", "full-stack"],
    "excludedCompanies": [],
    "excludeSkills": [".net", "java", "c#", "php"],
    "excludeUsOnly": true,
    "excludeIndia": true,
    "excludeUae": true,
    "excludeSoutheastAsia": true,
    "excludeClearance": true,
    "experience": ["mid", "senior"],
    "excludeOnSite": true,
    "excludeHybrid": true,
    "remote": true,
    "language": ["english"],
    "salary": {
      "hour": null,
      "month": null,
      "annual": null
    },
    "contractTypes": [],
    "prioritySalary": {
      "hourMin": 40,
      "annualMin": 80000
    }
  }
}
```

## Adding a new job board

1. Create `src/scrapers/my-board.ts` exporting `async function scrapeMyBoard(browser: Browser): Promise<ScrapeResult>`
2. Add the source to `JobSource` type in `src/types.ts`
3. Add the label to `SOURCE_LABELS` in `src/email/send-email.ts`
4. Call it in `src/index.ts` (before LinkedIn)
