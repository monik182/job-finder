import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser } from './browser.js';
import { scrapeAnywhereRemote } from './scrapers/anywhere-remote.js';
import { scrapeYCombinator } from './scrapers/ycombinator.js';
import { scrapeLinkedIn } from './scrapers/linkedin.js';
import { filterJobs } from './filters/filter-jobs.js';
import { loadSeenJobs, saveSeenJobs, deduplicateJobs } from './dedup/dedup.js';
import { sendEmail } from './email/send-email.js';
import { type EmailReport, type FilteredJob, type JobSource } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEN_JOBS_PATH = resolve(__dirname, '..', 'seen-jobs.json');

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

  const browser = await getBrowser();
  console.log('[main] Connected to Browserless');

  const allErrors: string[] = [];

  try {
    // Scrape in order: safest first, riskiest (LinkedIn) last
    const results = [];

    console.log('\n[main] Scraping Anywhere Remote Jobs...');
    results.push(await scrapeAnywhereRemote(browser));

    console.log('\n[main] Scraping Work at a Startup (YC)...');
    results.push(await scrapeYCombinator(browser));

    console.log('\n[main] Scraping LinkedIn...');
    results.push(await scrapeLinkedIn(browser));

    const allRawJobs = results.flatMap((r) => r.jobs);
    results.forEach((r) => allErrors.push(...r.errors));

    console.log(`\n[main] Total raw jobs collected: ${allRawJobs.length}`);

    // Filter
    const filteredJobs = filterJobs(allRawJobs);
    console.log(`[main] After filtering: ${filteredJobs.length}`);

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

    // Send email
    await sendEmail(report);

    // Persist updated seen-jobs.json
    saveSeenJobs(SEEN_JOBS_PATH, updatedStore);
    console.log(`[main] Updated seen-jobs.json (total hashes: ${updatedStore.hashes.length})`);

    console.log('\n=== Job Finder complete ===');
  } finally {
    await closeBrowser(browser);
  }
}

main().catch((err: unknown) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
