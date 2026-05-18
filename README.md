# job-finder

Daily job search automation that scrapes three job boards and emails a filtered digest of remote contract/freelance frontend and fullstack positions.

## How it works

1. Runs every morning at **6:02 AM UTC** (7:02 AM CET / 8:02 AM CEST) via GitHub Actions
2. Scrapes **LinkedIn**, **Work at a Startup (YC)**, and **Anywhere Remote Jobs** via [Browserless](https://browserless.io)
3. Filters results: remote only, frontend/fullstack, React/Angular/Next.js/Node.js/TypeScript, contract/freelance, posted in the last 24h
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

### 4. Run locally

```bash
npm run dev
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

## Filtering rules

**Included only if ALL match:**
- Remote position (not hybrid or on-site)
- Frontend or fullstack role
- Mentions React, Angular, Next.js, Node.js, or TypeScript
- Posted in the last 24 hours
- Contractor, freelance, contract, or part-time (full-time OK if remote worldwide/EMEA)

**Excluded if ANY match:**
- Requires US work authorization or US-only
- Requires security clearance
- Senior Staff / Principal / VP / C-level title
- Intern, junior, or entry-level
- On-site or hybrid attendance

**Flagged as high priority (⭐):**
- Explicitly contractor or freelance
- Salary ≥ $80K/year or ≥ $40/hr
- Mentions AI, OpenAI, automation, or n8n
- Company size 50–499 employees

## Adding a new job board

1. Create `src/scrapers/my-board.ts` exporting `async function scrapeMyBoard(browser: Browser): Promise<ScrapeResult>`
2. Add the source to `JobSource` type in `src/types.ts`
3. Add the label to `SOURCE_LABELS` in `src/email/send-email.ts`
4. Call it in `src/index.ts` (before LinkedIn)
