import { type Browser, type Page } from 'puppeteer-core';
import { type RawJob, type ScrapeResult } from '../types.js';
import { type AppConfig, type ExperienceLevel, getSearchTerms } from '../config.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';

const SOURCE = 'anywhere-remote' as const;
const BASE_URL = 'https://anywhereremotejobs.com';

const ANYWHERE_REMOTE_EXPERIENCE_MAP: Record<ExperienceLevel, string> = {
  junior: 'Junior',
  mid: 'Mid-level',
  senior: 'Senior',
  lead: 'Senior',
  staff: 'Senior',
  principal: 'Senior',
  director: 'Senior',
  'c-level': 'Senior',
};

const ANYWHERE_REMOTE_GEO_MAP: Partial<Record<import('../config.js').GeoLocation, string>> = {
  latam: 'LATAM',
  usa: 'United States',
  europe: 'European Union',
  worldwide: 'Worldwide',
};

function buildJobsUrl(country: string, skill: string, experience: string): string {
  const params = new URLSearchParams();
  params.append('country[0]', country);
  params.append('hide_reposts', '1');
  params.append('search', skill);
  params.append('experience[0]', experience);
  return `${BASE_URL}/remote-jobs?${params.toString()}`;
}

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

async function scrapeOneCombination(
  page: Page,
  country: string,
  skill: string,
  exp: ExperienceLevel,
  config: AppConfig,
  seenUrls: Set<string>,
  scrapedAt: string,
  errors: string[],
  onProgress?: (newJobs: RawJob[]) => void,
): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  const maxPages = config.scraping.maxPages;
  const minWait = config.scraping.minDelayMs;
  const expValue = ANYWHERE_REMOTE_EXPERIENCE_MAP[exp];

  let currentUrl: string | null = buildJobsUrl(country, skill, expValue);
  console.log(`[anywhere-remote] Scraping "${skill}" / ${exp} in ${country}: ${currentUrl}`);
  let pageNum = 1;

  while (currentUrl && pageNum <= maxPages) {
    const ok = await safeGoto(page, currentUrl);
    if (!ok) {
      errors.push(`[anywhere-remote] Failed to load page ${pageNum}: ${currentUrl}`);
      break;
    }

    try {
      await page.waitForSelector(SEL.jobsContainer, { timeout: 15_000 });
    } catch {
      errors.push(`[anywhere-remote] Job container not found on page ${pageNum}`);
      break;
    }

    try {
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

      const batchJobs: RawJob[] = [];
      for (const raw of rawJobs) {
        if (seenUrls.has(raw.url)) continue;
        seenUrls.add(raw.url);

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
      console.log(`[anywhere-remote] Page ${pageNum}: ${rawJobs.length} listings`);

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
      break;
    }

    if (currentUrl) await delay(minWait, minWait + 3000);
  }

  return jobs;
}

export async function scrapeAnywhereRemote(
  browser: Browser,
  config: AppConfig,
  onProgress?: (newJobs: RawJob[]) => void,
): Promise<ScrapeResult> {
  const jobs: RawJob[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  const scrapedAt = new Date().toISOString();
  const minWait = config.scraping.minDelayMs;

  const locations = config.filters.geoLocations
    .map((loc) => ANYWHERE_REMOTE_GEO_MAP[loc])
    .filter((c): c is string => c !== undefined);
  const countryList = locations.length > 0 ? locations : ['Worldwide'];

  let firstCombination = true;
  for (const country of countryList) {
    for (const skill of getSearchTerms(config)) {
      for (const exp of config.filters.experience) {
        if (!firstCombination) await delay(minWait, minWait + 3000);
        firstCombination = false;

        // Fresh page per combination — avoids detached frame issues across navigations
        const page = await newPage(browser);
        try {
          const newJobs = await scrapeOneCombination(
            page, country, skill, exp, config, seenUrls, scrapedAt, errors, onProgress,
          );
          jobs.push(...newJobs);
        } finally {
          // await page.close().catch(() => {});
        }
      }
    }
  }

  console.log(`[anywhere-remote] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
  return { source: SOURCE, jobs, errors };
}
