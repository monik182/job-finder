import { type Browser } from 'puppeteer-core';
import { type RawJob, type ScrapeResult } from '../types.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';

const SOURCE = 'ycombinator' as const;
const BASE_URL = 'https://www.workatastartup.com';
const QUERIES = ['React', 'Angular', 'Next.js', 'Node.js', 'frontend', 'fullstack'];

interface RawJobData {
  title: string;
  company: string;
  location: string;
  dateText: string;
  url: string;
  description: string;
}

export async function scrapeYCombinator(browser: Browser): Promise<ScrapeResult> {
  const jobs: RawJob[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  const scrapedAt = new Date().toISOString();

  for (const query of QUERIES) {
    const url = `${BASE_URL}/jobs?remote=true&query=${encodeURIComponent(query)}`;
    const page = await newPage(browser);

    try {
      const ok = await safeGoto(page, url, 30_000);
      if (!ok) {
        errors.push(`[ycombinator] Failed to load: ${url}`);
        await page.close();
        await delay();
        continue;
      }

      // Wait for React SPA to render jobs
      try {
        await page.waitForSelector('.jobs-list, [data-testid="job-list"], .job-row, .company-jobs-table', {
          timeout: 15_000,
        });
      } catch {
        // Selector may vary; attempt to proceed anyway
      }

      // Scroll to trigger lazy loading
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1000, 1500);
      }

      const rawJobs = await page.evaluate((baseUrl: string): RawJobData[] => {
        const results: RawJobData[] = [];

        // YC job rows can be in a table or div layout
        const jobEls = document.querySelectorAll(
          '.job-row, tr.job, .job-listing, [class*="job-"] a[href*="/jobs/"]',
        );

        // Fallback: find all links that point to job detail pages
        const jobLinks = Array.from(
          document.querySelectorAll('a[href*="/jobs/"]'),
        ) as HTMLAnchorElement[];

        const processedHrefs = new Set<string>();

        // Try structured selectors first
        jobEls.forEach((el) => {
          const anchor = el.querySelector('a[href*="/jobs/"]') as HTMLAnchorElement | null;
          const url = anchor ? (anchor.href.startsWith('http') ? anchor.href : baseUrl + anchor.getAttribute('href')) : '';
          if (!url || processedHrefs.has(url)) return;
          processedHrefs.add(url);

          const title = el.querySelector('.title, .job-title, h3, h2, strong')?.textContent?.trim()
            ?? anchor?.textContent?.trim()
            ?? '';
          const company = el.querySelector('.company-name, .company, td:first-child')?.textContent?.trim() ?? '';
          const location = el.querySelector('.location, .remote')?.textContent?.trim() ?? '';
          const dateText = el.querySelector('time, .date, .posted')?.textContent?.trim() ?? '';
          const description = el.querySelector('.description, p')?.textContent?.trim().slice(0, 300) ?? '';

          if (title) results.push({ title, company, location, dateText, url, description });
        });

        // Fallback: collect remaining job links not already processed
        jobLinks.forEach((anchor) => {
          const href = anchor.getAttribute('href') ?? '';
          if (!href.match(/\/jobs\/\d+/)) return;
          const url = anchor.href.startsWith('http') ? anchor.href : baseUrl + href;
          if (processedHrefs.has(url)) return;
          processedHrefs.add(url);

          const row = anchor.closest('tr, .job-row, li, [class*="job"]');
          const title = anchor.textContent?.trim() ?? '';
          const company = row?.querySelector('.company-name, td:first-child')?.textContent?.trim() ?? '';
          const location = row?.querySelector('.location')?.textContent?.trim() ?? '';
          const dateText = row?.querySelector('time')?.textContent?.trim() ?? '';
          const description = '';

          if (title) results.push({ title, company, location, dateText, url, description });
        });

        return results;
      }, BASE_URL);

      for (const raw of rawJobs) {
        if (seenUrls.has(raw.url)) continue;
        seenUrls.add(raw.url);

        jobs.push({
          title: raw.title,
          company: raw.company,
          location: raw.location,
          datePosted: parseRelativeDate(raw.dateText),
          url: raw.url,
          description: raw.description,
          source: SOURCE,
          scrapedAt,
        });
      }

      console.log(`[ycombinator] "${query}": ${rawJobs.length} listings`);
    } catch (err) {
      const msg = `[ycombinator] Error scraping "${query}": ${err instanceof Error ? err.message : String(err)}`;
      console.error(msg);
      errors.push(msg);
    } finally {
      await page.close();
    }

    await delay();
  }

  console.log(`[ycombinator] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
  return { source: SOURCE, jobs, errors };
}
