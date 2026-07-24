import { type Browser } from 'puppeteer-core';
import { type RawJob, type ScrapeResult, type InlineFilterStats } from '../types.js';
import { type AppConfig } from '../config.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';
import { SEL, extractArticles, getNextPageUrl } from './anywhere-remote.js';

const SOURCE = 'anywhere-remote' as const;
const BASE_URL = 'https://anywhereremotejobs.com';
const PAGE_LIMIT = 10;

function buildJobsUrl(): string {
  const params = new URLSearchParams();
  params.append('country[0]', 'Worldwide');
  params.append('hide_reposts', '1');
  return `${BASE_URL}/remote-jobs?${params.toString()}`;
}

// Keep only engineering / programming roles (matched on title + tags).
const ENGINEERING_RE =
  /\b(develop(?:er|ment)|engineer(?:ing)?|programm(?:er|ing)|software|back[- ]?end|front[- ]?end|full[- ]?stack|devops|sre|web|mobile|ios|android|data\s+engineer|platform|qa|sdet|cloud|infrastructure|api|react|node|python|java|golang|ruby|php|rust|typescript|javascript)\b/i;

function isEngineering(title: string, tags: string): boolean {
  return ENGINEERING_RE.test(`${title} ${tags}`);
}

const EMPTY_INLINE_STATS: InlineFilterStats = { skippedAsSeen: 0, skippedByHardExclusion: 0, excludedJobs: [] };

export async function scrapeAnywhereRemoteWorldwide(
  browser: Browser,
  config: AppConfig,
  onProgress?: (newJobs: RawJob[]) => void,
): Promise<ScrapeResult> {
  const jobs: RawJob[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  const scrapedAt = new Date().toISOString();
  const minWait = config.scraping.minDelayMs;

  const page = await newPage(browser);
  let currentUrl: string | null = buildJobsUrl();
  let pageNum = 1;

  console.log(`[anywhere-remote-worldwide] Start: ${currentUrl}`);

  try {
    while (currentUrl && pageNum <= PAGE_LIMIT) {
      const ok = await safeGoto(page, currentUrl);
      if (!ok) {
        errors.push(`[anywhere-remote-worldwide] Failed to load page ${pageNum}: ${currentUrl}`);
        break;
      }

      try {
        await page.waitForSelector(SEL.jobsContainer, { timeout: 15_000 });
      } catch {
        errors.push(`[anywhere-remote-worldwide] Job container not found on page ${pageNum}`);
        break;
      }

      try {
        const rawJobs = await extractArticles(page);

        const batchJobs: RawJob[] = [];
        for (const raw of rawJobs) {
          if (seenUrls.has(raw.url)) continue;
          seenUrls.add(raw.url);
          if (!isEngineering(raw.title, raw.tags)) continue;

          const job: RawJob = {
            title: raw.title,
            company: raw.company,
            location: 'Remote',
            datePosted: parseRelativeDate(raw.dateText),
            url: raw.url,
            description: raw.tags,
            source: SOURCE,
            scrapedAt,
          };

          jobs.push(job);
          batchJobs.push(job);
        }

        if (batchJobs.length > 0) onProgress?.(batchJobs);
        console.log(`[anywhere-remote-worldwide] Page ${pageNum}: ${rawJobs.length} listings, ${batchJobs.length} engineering kept`);

        currentUrl = await getNextPageUrl(page);
        pageNum++;
      } catch (err) {
        const msg = `[anywhere-remote-worldwide] Error on page ${pageNum}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(msg);
        errors.push(msg);
        break;
      }

      if (currentUrl && pageNum <= PAGE_LIMIT) await delay(minWait, minWait + 3000);
    }
  } finally {
    await page.close().catch(() => {});
  }

  console.log(`[anywhere-remote-worldwide] Total: ${jobs.length} engineering jobs (${seenUrls.size} unique seen)`);
  return { source: SOURCE, jobs, errors, inlineStats: EMPTY_INLINE_STATS };
}
