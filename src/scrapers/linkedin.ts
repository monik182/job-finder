import { type Browser } from 'puppeteer-core';
import { type RawJob, type ScrapeResult } from '../types.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';

const SOURCE = 'linkedin' as const;
const BASE_URL = 'https://www.linkedin.com/jobs/search/';

// f_WT=2 = Remote, f_TPR=r86400 = Past 24 hours
const QUERIES = [
  'react frontend contractor',
  'react frontend freelance',
  'angular frontend contractor',
  'angular frontend freelance',
  'fullstack react contractor',
  'fullstack next.js remote',
  'fullstack node.js contractor',
];

function buildUrl(query: string, start = 0): string {
  const params = new URLSearchParams({
    keywords: query,
    location: '',
    f_WT: '2',
    f_TPR: 'r86400',
    start: String(start),
  });
  return `${BASE_URL}?${params.toString()}`;
}

interface RawJobData {
  title: string;
  company: string;
  location: string;
  dateIso: string;
  url: string;
}

export async function scrapeLinkedIn(browser: Browser): Promise<ScrapeResult> {
  const jobs: RawJob[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  const scrapedAt = new Date().toISOString();

  for (const query of QUERIES) {
    let start = 0;
    let keepPaging = true;

    while (keepPaging) {
      const url = buildUrl(query, start);
      const page = await newPage(browser);

      // Block images/fonts to speed up load
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        if (type === 'image' || type === 'font' || type === 'media') {
          req.abort();
        } else {
          req.continue();
        }
      });

      try {
        const ok = await safeGoto(page, url, 30_000);
        if (!ok) {
          errors.push(`[linkedin] Failed to load: ${url}`);
          keepPaging = false;
          await page.close();
          break;
        }

        // LinkedIn may redirect to login page or show a bot challenge
        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
          const msg = `[linkedin] Redirected to login/checkpoint for query "${query}" — skipping`;
          console.warn(msg);
          errors.push(msg);
          keepPaging = false;
          await page.close();
          break;
        }

        // Wait for job list
        try {
          await page.waitForSelector(
            'ul.jobs-search__results-list, .jobs-search-results-list',
            { timeout: 15_000 },
          );
        } catch {
          // No results or selector changed — stop paging this query
          keepPaging = false;
          await page.close();
          break;
        }

        const rawJobs = await page.evaluate((): RawJobData[] => {
          const results: RawJobData[] = [];
          const items = document.querySelectorAll(
            'ul.jobs-search__results-list > li, .jobs-search-results-list li',
          );

          items.forEach((li) => {
            const titleEl = li.querySelector('h3.base-search-card__title');
            const companyEl = li.querySelector('h4.base-search-card__subtitle');
            const locationEl = li.querySelector('span.job-search-card__location');
            const timeEl = li.querySelector('time');
            const linkEl = li.querySelector('a.base-card__full-link');

            const title = titleEl?.textContent?.trim() ?? '';
            const company = companyEl?.textContent?.trim() ?? '';
            const location = locationEl?.textContent?.trim() ?? '';
            const dateIso =
              timeEl instanceof HTMLTimeElement
                ? (timeEl.getAttribute('datetime') ?? timeEl.textContent?.trim() ?? '')
                : '';
            const url =
              linkEl instanceof HTMLAnchorElement
                ? linkEl.href.split('?')[0] ?? linkEl.href
                : '';

            if (title && url) {
              results.push({ title, company, location, dateIso, url });
            }
          });

          return results;
        });

        for (const raw of rawJobs) {
          if (seenUrls.has(raw.url)) continue;
          seenUrls.add(raw.url);

          jobs.push({
            title: raw.title,
            company: raw.company,
            location: raw.location,
            datePosted: parseRelativeDate(raw.dateIso),
            url: raw.url,
            description: '', // not available in list view without login
            source: SOURCE,
            scrapedAt,
          });
        }

        console.log(`[linkedin] "${query}" (start=${start}): ${rawJobs.length} listings`);

        // Paginate only if we got a full page of results
        if (rawJobs.length >= 25 && start === 0) {
          start = 25;
        } else {
          keepPaging = false;
        }
      } catch (err) {
        const msg = `[linkedin] Error scraping "${query}" start=${start}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(msg);
        errors.push(msg);
        keepPaging = false;
      } finally {
        await page.close();
      }

      if (keepPaging) await delay();
    }

    await delay();
  }

  console.log(`[linkedin] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
  return { source: SOURCE, jobs, errors };
}
