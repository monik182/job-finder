import { type Browser } from 'puppeteer-core';
import { type RawJob, type ScrapeResult } from '../types.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';

const SOURCE = 'anywhere-remote' as const;
const BASE_URL = 'https://anywhereremotejobs.com';
const JOBS_URL =
  `${BASE_URL}/remote-jobs` +
  `?country%5B0%5D=Worldwide` +
  `&hide_reposts=1` +
  `&tech%5B0%5D=typescript` +
  `&tech%5B1%5D=angular` +
  `&tech%5B2%5D=react` +
  `&tech%5B3%5D=javascript` +
  `&tech%5B4%5D=generative-ai` +
  `&tech%5B5%5D=artificial-intelligence` +
  `&experience%5B0%5D=Senior` +
  `&experience%5B1%5D=Mid-level`;

// Selectors — update here if the site changes
const SEL = {
  // Page-level
  jobsContainer: 'section#jobs-list-container',
  jobArticle: 'section#jobs-list-container article',
  pagination: 'nav[aria-label="Job listings pagination"]',
  nextPage: 'nav[aria-label="Job listings pagination"] a[aria-label="Go to next page"]',
  // Per-article, scoped to each <article> element via :scope
  articleLink: ':scope > a',
  articleDate: ':scope div:last-child div:first-child',
  articleCompany: ':scope div:last-child div:nth-child(2) div span',
  articleTitle: ':scope div:last-child div:nth-child(2) h2',
  articleTagItems: ':scope div:last-child div:last-child div',
} as const;

interface RawJobData {
  title: string;
  company: string;
  dateText: string;
  url: string;
  tags: string;
}

export async function scrapeAnywhereRemote(browser: Browser): Promise<ScrapeResult> {
  const jobs: RawJob[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  const scrapedAt = new Date().toISOString();

  const MAX_PAGES = 3;
  let currentUrl: string | null = JOBS_URL;
  let pageNum = 1;

  while (currentUrl && pageNum <= MAX_PAGES) {
    const page = await newPage(browser);

    try {
      const ok = await safeGoto(page, currentUrl);
      if (!ok) {
        errors.push(`[anywhere-remote] Failed to load page ${pageNum}: ${currentUrl}`);
        await page.close();
        break;
      }

      // Wait for job container
      try {
        await page.waitForSelector(SEL.jobsContainer, { timeout: 15_000 });
      } catch {
        errors.push(`[anywhere-remote] Job container not found on page ${pageNum}`);
        await page.close();
        break;
      }

      const rawJobs = await page.evaluate(
        (selectors: typeof SEL, baseUrl: string): RawJobData[] => {
          const results: RawJobData[] = [];
          const articles = document.querySelectorAll(selectors.jobArticle);

          articles.forEach((article) => {
            const linkEl = article.querySelector(selectors.articleLink);
            const dateEl = article.querySelector(selectors.articleDate);
            const companyEl = article.querySelector(selectors.articleCompany);
            const titleEl = article.querySelector(selectors.articleTitle);
            const tagEls = article.querySelectorAll(selectors.articleTagItems);

            const relativeUrl =
              linkEl instanceof HTMLAnchorElement ? linkEl.getAttribute('href') ?? '' : '';
            const url = relativeUrl.startsWith('http')
              ? relativeUrl
              : `${baseUrl}${relativeUrl}`;

            const title = titleEl?.textContent?.trim() ?? '';
            const company = companyEl?.textContent?.trim() ?? '';
            const dateText = dateEl?.textContent?.trim() ?? '';
            const tags = Array.from(tagEls)
              .map((t) => t.textContent?.trim() ?? '')
              .filter(Boolean)
              .join(', ');

            if (title && url) {
              results.push({ title, company, dateText, url, tags });
            }
          });

          return results;
        },
        SEL,
        BASE_URL,
      );

      for (const raw of rawJobs) {
        if (seenUrls.has(raw.url)) continue;
        seenUrls.add(raw.url);

        jobs.push({
          title: raw.title,
          company: raw.company,
          location: 'Remote',
          datePosted: parseRelativeDate(raw.dateText),
          url: raw.url,
          description: raw.tags,
          source: SOURCE,
          scrapedAt,
        });
      }

      console.log(`[anywhere-remote] Page ${pageNum}: ${rawJobs.length} listings`);

      // Check for next page
      const nextUrl = await page.evaluate((nextSel: string, baseUrl: string): string | null => {
        const nextBtn = document.querySelector(nextSel);
        if (!(nextBtn instanceof HTMLAnchorElement)) return null;
        const href = nextBtn.getAttribute('href') ?? '';
        if (!href) return null;
        return href.startsWith('http') ? href : `${baseUrl}${href}`;
      }, SEL.nextPage, BASE_URL);

      currentUrl = nextUrl;
      pageNum++;
    } catch (err) {
      const msg = `[anywhere-remote] Error on page ${pageNum}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(msg);
      errors.push(msg);
      currentUrl = null;
    } finally {
      await page.close();
    }

    if (currentUrl) await delay();
  }

  console.log(`[anywhere-remote] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
  return { source: SOURCE, jobs, errors };
}
