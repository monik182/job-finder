import { type Browser } from 'puppeteer-core';
import { type RawJob, type ScrapeResult } from '../types.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';

const SOURCE = 'anywhere-remote' as const;
const BASE_URL = 'https://anywhereremotejobs.com';
const QUERIES = [
  'react frontend',
  'angular frontend',
  'nextjs',
  'nodejs remote',
  'fullstack remote',
];

interface RawJobData {
  title: string;
  company: string;
  location: string;
  dateText: string;
  url: string;
  description: string;
}

export async function scrapeAnywhereRemote(browser: Browser): Promise<ScrapeResult> {
  const jobs: RawJob[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  const scrapedAt = new Date().toISOString();

  for (const query of QUERIES) {
    const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    const page = await newPage(browser);

    try {
      const ok = await safeGoto(page, url);
      if (!ok) {
        errors.push(`[anywhere-remote] Failed to load: ${url}`);
        await page.close();
        await delay();
        continue;
      }

      // Try to load more results (up to 2 clicks)
      for (let i = 0; i < 2; i++) {
        try {
          const loadMoreBtn = await page.$('.load_more_jobs, a.loadmore, button.load-more');
          if (!loadMoreBtn) break;
          await loadMoreBtn.click();
          await delay(1500, 2500);
        } catch {
          break;
        }
      }

      // Extract job listings - WordPress job board structure
      const rawJobs = await page.evaluate((): RawJobData[] => {
        const results: RawJobData[] = [];
        const listings = document.querySelectorAll(
          'li.job_listing, article.job_listing, .job_listing',
        );

        listings.forEach((el) => {
          const titleEl = el.querySelector('h3 a, h2 a, .job-title a, a.job-link');
          const companyEl = el.querySelector('.company, .company-name, strong.company');
          const locationEl = el.querySelector('.location, .job-location');
          const dateEl = el.querySelector('time, .date, .posted-date');
          const descEl = el.querySelector('.job-description, .job_description, p');

          const url = titleEl instanceof HTMLAnchorElement ? titleEl.href : '';
          const title = titleEl?.textContent?.trim() ?? '';
          const company = companyEl?.textContent?.trim() ?? '';
          const location = locationEl?.textContent?.trim() ?? '';
          const dateText =
            dateEl instanceof HTMLTimeElement
              ? (dateEl.getAttribute('datetime') ?? dateEl.textContent?.trim() ?? '')
              : (dateEl?.textContent?.trim() ?? '');
          const description = descEl?.textContent?.trim().slice(0, 300) ?? '';

          if (title && url) {
            results.push({ title, company, location, dateText, url, description });
          }
        });

        return results;
      });

      for (const raw of rawJobs) {
        const resolvedUrl = raw.url.startsWith('http')
          ? raw.url
          : `${BASE_URL}${raw.url}`;

        if (seenUrls.has(resolvedUrl)) continue;
        seenUrls.add(resolvedUrl);

        jobs.push({
          title: raw.title,
          company: raw.company,
          location: raw.location,
          datePosted: parseRelativeDate(raw.dateText),
          url: resolvedUrl,
          description: raw.description,
          source: SOURCE,
          scrapedAt,
        });
      }

      console.log(`[anywhere-remote] "${query}": ${rawJobs.length} listings`);
    } catch (err) {
      const msg = `[anywhere-remote] Error scraping "${query}": ${err instanceof Error ? err.message : String(err)}`;
      console.error(msg);
      errors.push(msg);
    } finally {
      await page.close();
    }

    await delay();
  }

  console.log(`[anywhere-remote] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
  return { source: SOURCE, jobs, errors };
}
