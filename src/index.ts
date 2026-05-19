import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser } from './browser.js';
import { scrapeAnywhereRemote } from './scrapers/anywhere-remote.js';
import { scrapeYCombinator } from './scrapers/ycombinator.js';
import { scrapeLinkedIn } from './scrapers/linkedin.js';
import { filterJobs, saveExcludedJobs, saveRawJobs } from './filters/filter-jobs.js';
import { loadSeenJobs, saveSeenJobs, deduplicateJobs } from './dedup/dedup.js';
import { sendEmail } from './email/send-email.js';
import { buildRunLog, appendRunLog } from './logger.js';
import { type EmailReport, type FilteredJob, type JobSource, type RawJob, type ScrapeResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEN_JOBS_PATH = resolve(__dirname, '..', 'seen-jobs.json');
const RAW_JOBS_PATH = resolve(__dirname, '..', 'raw-jobs.json');
const EXCLUDED_JOBS_PATH = resolve(__dirname, '..', 'excluded-jobs.json');
const RUNS_LOG_PATH = resolve(__dirname, '..', 'runs.log');

function validateEnv(): void {
  const required = ['BROWSERLESS_API_KEY', 'RESEND_API_KEY', 'MY_EMAIL', 'FROM_EMAIL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function getDate(): string {
  return new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

async function main(): Promise<void> {
  console.log('=== Job Finder starting ===');
  validateEnv();

  const startedAt = new Date().toISOString();
  const browser = await getBrowser();
  console.log('[main] Connected to Browserless');

  const allErrors: string[] = [];

  try {
    // Scrape in order: safest first, riskiest (LinkedIn) last
    const results: ScrapeResult[] = [];
    const allRawJobs: RawJob[] = [];

    const checkpoint = (newJobs: RawJob[]): void => {
      allRawJobs.push(...newJobs);
      saveRawJobs(RAW_JOBS_PATH, allRawJobs);
    };

    console.log('\n[main] Scraping Anywhere Remote Jobs...');
    // try { results.push(await scrapeAnywhereRemote(browser, checkpoint)); } catch (e) { console.error('[main] Anywhere Remote failed:', e); }

    console.log('\n[main] Scraping Work at a Startup (YC)...');
    //TODO: Fix the broken scraper issue.
    try { results.push(await scrapeYCombinator(browser, checkpoint)); } catch (e) { console.error('[main] YCombinator failed:', e); }

    console.log('\n[main] Scraping LinkedIn...');
    // try { results.push(await scrapeLinkedIn(browser, checkpoint)); } catch (e) { console.error('[main] LinkedIn failed:', e); }

    results.forEach((r) => allErrors.push(...r.errors));

    console.log(`\n[main] Total raw jobs collected: ${allRawJobs.length} (saved to raw-jobs.json)`);

    // Filter
    const { filtered: filteredJobs, excluded: excludedJobs } = filterJobs(allRawJobs);
    console.log(`[main] After filtering: ${filteredJobs.length} kept, ${excludedJobs.length} excluded`);

    // Dedup
    const store = loadSeenJobs(SEEN_JOBS_PATH);
    const { newJobs, updatedStore } = deduplicateJobs(filteredJobs, store);
    console.log(`[main] New jobs (not seen before): ${newJobs.length}`);

    // Group by source
    const jobsBySource: Partial<Record<JobSource, FilteredJob[]>> = {};
    for (const job of newJobs) {
      const existing = jobsBySource[job.source] ?? [];
      existing.push(job);
      jobsBySource[job.source] = existing;
    }

    // Sort within each source: high priority first
    for (const source of Object.keys(jobsBySource) as JobSource[]) {
      jobsBySource[source] = (jobsBySource[source] ?? []).sort((a, b) => {
        if (a.isHighPriority && !b.isHighPriority) return -1;
        if (!a.isHighPriority && b.isHighPriority) return 1;
        return 0;
      });
    }

    const report: EmailReport = {
      totalFound: allRawJobs.length,
      totalAfterFilter: filteredJobs.length,
      totalNew: newJobs.length,
      jobsBySource,
      date: getDate(),
      scraperErrors: allErrors,
    };

    // Persist updated seen-jobs.json
    saveSeenJobs(SEEN_JOBS_PATH, updatedStore);
    console.log(`[main] Updated seen-jobs.json (total hashes: ${updatedStore.hashes.length})`);

    // Persist excluded jobs (dev only)
    if (process.env['NODE_ENV'] === 'development') {
      saveExcludedJobs(EXCLUDED_JOBS_PATH, excludedJobs);
      console.log(`[main] Updated excluded-jobs.json (+${excludedJobs.length} exclusions)`);
    }

    // Send email only if there are new jobs
    if (newJobs.length === 0) {
      console.log('[main] No new jobs found — skipping email');
    } else {
      await sendEmail(report);
    }

    // Append run log (production only)
    // if (process.env['NODE_ENV'] !== 'development') {
    if (true) {
      const entry = buildRunLog({
        startedAt,
        finishedAt: new Date().toISOString(),
        seenJobsTotal: updatedStore.hashes.length,
        rawJobsFound: allRawJobs.length,
        newJobsFound: newJobs.length,
        excludedJobs,
        results,
        globalErrors: allErrors.filter(
          (e) => !results.some((r) => r.errors.includes(e)),
        ),
      });
      appendRunLog(RUNS_LOG_PATH, entry);
      console.log('[main] Run logged to runs.log');
    }

    console.log('\n=== Job Finder complete ===');
  } finally {
    await closeBrowser(browser);
  }
}

main().catch((err: unknown) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
