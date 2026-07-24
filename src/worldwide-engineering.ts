import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser } from './browser.js';
import { loadConfig } from './config.js';
import { scrapeAnywhereRemoteWorldwide } from './scrapers/anywhere-remote-worldwide.js';
import { loadSeenJobs, saveSeenJobs, deduplicateJobs } from './dedup/dedup.js';
import { classifyJobs } from './ai-filter/ai-filter.js';
import { sendEmail } from './email/send-email.js';
import { buildRunLog, appendRunLog } from './logger.js';
import { type AIClassifiedJob, type EmailReport, type FilteredJob, type JobSource, type RawJob } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEN_JOBS_PATH = resolve(__dirname, '..', 'seen-jobs.json');
const RUNS_LOG_PATH = resolve(__dirname, '..', 'runs.log');

function validateEnv(): void {
  const required = ['BROWSERLESS_API_KEY', 'RESEND_API_KEY', 'MY_EMAIL', 'FROM_EMAIL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function getDate(): string {
  return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function groupBySource(jobs: AIClassifiedJob[]): Partial<Record<JobSource, AIClassifiedJob[]>> {
  const map: Partial<Record<JobSource, AIClassifiedJob[]>> = {};
  for (const job of jobs) {
    const existing = map[job.source] ?? [];
    existing.push(job);
    map[job.source] = existing;
  }
  return map;
}

async function main(): Promise<void> {
  console.log('=== Worldwide Engineering scrape starting ===');
  validateEnv();

  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const store = loadSeenJobs(SEEN_JOBS_PATH);

  const browser = await getBrowser();
  let result;
  try {
    result = await scrapeAnywhereRemoteWorldwide(browser, config);
  } finally {
    await closeBrowser(browser);
  }

  console.log(`[main] Scraped ${result.jobs.length} engineering jobs`);

  // Bypass config skill/title filter by design — map straight to FilteredJob.
  const filtered: FilteredJob[] = result.jobs.map((job: RawJob) => ({
    ...job,
    isHighPriority: false,
    priorityReasons: [],
  }));

  const { newJobs } = deduplicateJobs(filtered, store);
  console.log(`[main] New jobs (not seen before): ${newJobs.length}`);

  const classifiedJobs = await classifyJobs(newJobs, config);
  const strongJobs = classifiedJobs.filter((j) => j.aiMatch === 'strong');
  const weakJobs = classifiedJobs.filter((j) => j.aiMatch === 'weak');
  console.log(`[main] AI classification: ${strongJobs.length} strong, ${weakJobs.length} weak`);

  // Persist only jobs that will be emailed.
  const emailedJobs: FilteredJob[] = [...strongJobs, ...weakJobs];
  const { updatedStore } = deduplicateJobs(emailedJobs, store);

  const report: EmailReport = {
    totalFound: result.jobs.length,
    totalAfterFilter: filtered.length,
    totalNew: newJobs.length,
    totalStrong: strongJobs.length,
    totalWeak: weakJobs.length,
    strongBySource: groupBySource(strongJobs),
    weakBySource: groupBySource(weakJobs),
    date: getDate(),
    scraperErrors: result.errors,
    source: 'anywhere-remote',
  };

  saveSeenJobs(SEEN_JOBS_PATH, updatedStore);
  console.log(`[main] Updated seen-jobs.json (total hashes: ${updatedStore.hashes.length})`);

  if (strongJobs.length === 0 && weakJobs.length === 0) {
    console.log('[main] No new jobs found — skipping email');
  } else {
    await sendEmail(report);
  }

  if (process.env['NODE_ENV'] !== 'development') {
    const entry = buildRunLog({
      startedAt,
      finishedAt: new Date().toISOString(),
      seenJobsTotal: updatedStore.hashes.length,
      rawJobsFound: result.jobs.length,
      newJobsFound: newJobs.length,
      excludedJobs: [],
      results: [result],
      globalErrors: [],
    });
    appendRunLog(RUNS_LOG_PATH, entry);
    console.log('[main] Run logged to runs.log');
  }

  console.log('\n=== Worldwide Engineering scrape complete ===');
}

main().catch((err: unknown) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
