import { type Browser } from 'puppeteer-core';
import { type RawJob, type ScrapeResult } from '../types.js';
import { type AppConfig } from '../config.js';
import { newPage, delay, safeGoto } from './utils.js';

const SOURCE = 'ycombinator' as const;
const LOGIN_URL =
  'https://account.ycombinator.com/?continue=https%3A%2F%2Fwww.workatastartup.com%2F';
const BASE_COMPANIES_URL =
  'https://www.workatastartup.com/companies?demographic=any&hasEquity=any&hasSalary=any&industry=any&interviewProcess=any&jobType=any&layout=list-compact&sortBy=created_desc&tab=any&usVisaNotRequired=true';

function buildBaseUrl(config: AppConfig): string {
  const params = new URLSearchParams(BASE_COMPANIES_URL.split('?')[1]);
  if (config.filters.remote) {
    params.append('remote', 'yes');
    params.append('remote', 'only');
  }
  return `https://www.workatastartup.com/companies?${params.toString()}`;
}

function buildQueries(config: AppConfig): Array<{ param: string; value: string }> {
  const queries: Array<{ param: string; value: string }> = [];
  const addedValues = new Set<string>();

  // Add skill queries (skip role words already covered by role_type)
  const roleWords = new Set(config.filters.jobTitle.map((t) => t.toLowerCase()));
  for (const skill of config.filters.skills) {
    const normalized = skill.toLowerCase();
    if (roleWords.has(normalized)) continue;
    if (addedValues.has(normalized)) continue;
    queries.push({ param: 'query', value: skill });
    addedValues.add(normalized);
  }

  return queries;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Selectors — update here if the site changes
const SEL = {
  // Login page
  emailInput: 'input#ycid-input',
  passwordInput: 'input#password-input',
  submitButton: 'div.actions button[type="submit"]',
  submitButtonFallback: 'button[type="submit"]',
  // Companies listing page
  directoryList: 'div.directory-list',
  companyCards: 'div.directory-list > div',
  // Per-card, scoped to each company card
  companyName: 'div:first-child div:last-child div:first-child div:last-child div:first-child a span:first-child',
  jobItems: 'div.px-3.pb-3.pt-3 div div div',
  // Per-job-item, scoped to each job item
  jobTitle: 'div:first-child div:first-child a',
  jobTags: 'div:first-child div:last-child',
  jobLink: 'div.mt-2.flex.flex-none.items-center a',
} as const;

interface RawJobData {
  title: string;
  company: string;
  tags: string;
  url: string;
}

export async function scrapeYCombinator(
  browser: Browser,
  config: AppConfig,
  onProgress?: (newJobs: RawJob[]) => void,
): Promise<ScrapeResult> {
  const jobs: RawJob[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  const scrapedAt = new Date().toISOString();

  const email = process.env.YC_EMAIL;
  const password = process.env.YC_PASSWORD;
  if (!email || !password) {
    return {
      source: SOURCE,
      jobs,
      errors: ['[ycombinator] YC_EMAIL or YC_PASSWORD not set in environment'],
    };
  }

  const page = await newPage(browser);

  // --- Login ---
  try {
    const loginOk = await safeGoto(page, LOGIN_URL, 10_000);
    if (!loginOk) {
      errors.push('[ycombinator] Failed to load login page');
      await page.close();
      return { source: SOURCE, jobs, errors };
    }

    await page.waitForSelector(SEL.emailInput, { timeout: 15_000 });

    // Human-like pause before starting to type
    await delay(randomInt(800, 1500), randomInt(800, 1500));

    await page.click(SEL.emailInput);
    await page.type(SEL.emailInput, email, { delay: randomInt(80, 150) });

    await delay(randomInt(600, 1200), randomInt(600, 1200));

    await page.click(SEL.passwordInput);
    await page.type(SEL.passwordInput, password, { delay: randomInt(80, 150) });

    await delay(randomInt(500, 900), randomInt(500, 900));

    // Click submit — prefer the scoped selector, fall back to generic
    const submitSelector = await page.$(SEL.submitButton)
      ? SEL.submitButton
      : SEL.submitButtonFallback;
    await page.click(submitSelector);

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 });

    const currentUrl = page.url();
    if (!currentUrl.includes('workatastartup.com')) {
      errors.push(`[ycombinator] Login may have failed — landed on: ${currentUrl}`);
      await page.close();
      return { source: SOURCE, jobs, errors };
    }

    console.log('[ycombinator] Login successful');
    await delay(randomInt(2000, 3500), randomInt(2000, 3500));
  } catch (err) {
    const msg = `[ycombinator] Login error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    errors.push(msg);
    await page.close();
    return { source: SOURCE, jobs, errors };
  }

  const queries = buildQueries(config);
  const jobsPerCombination = config.scraping.maxJobs;
  const minWait = config.scraping.minDelayMs;
  const baseUrl = buildBaseUrl(config);

  // --- Scrape each query combination ---
  for (const { param, value } of queries) {
    const url = `${baseUrl}&${param}=${encodeURIComponent(value)}`;

    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (err) {
        errors.push(`[ycombinator] Failed to load: ${url} — ${err instanceof Error ? err.message : String(err)}`);
        await delay(minWait, minWait + 3000);
        continue;
      }

      // React needs time to hydrate after domcontentloaded — wait for the list
      try {
        await page.waitForSelector(SEL.directoryList, { timeout: 30_000 });
      } catch {
        console.warn(`[ycombinator] "${param}=${value}": directory-list not found`);
        await delay(minWait, minWait + 3000);
        continue;
      }

      // Scroll to load enough jobs (infinite scroll, ~10 per scroll)
      let prevCount = 0;
      for (let i = 0; i < 5; i++) {
        const count: number = await page.evaluate(
          (cardsSel: string) => document.querySelectorAll(cardsSel).length,
          SEL.companyCards,
        );
        if (count >= jobsPerCombination) break;
        if (i > 0 && count === prevCount) break; // no new content loaded
        prevCount = count;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(randomInt(1500, 2500), randomInt(1500, 2500));
      }

      const rawJobs = await page.evaluate(
        (selectors: typeof SEL, baseUrl: string, maxJobs: number): RawJobData[] => {
          const results: RawJobData[] = [];
          const companyCards = Array.from(document.querySelectorAll(selectors.companyCards));

          for (const card of companyCards) {
            if (results.length >= maxJobs) break;

            const company = card.querySelector(selectors.companyName)?.textContent?.trim() ?? '';

            const jobItems = Array.from(card.querySelectorAll(selectors.jobItems));

            for (const jobItem of jobItems) {
              if (results.length >= maxJobs) break;

              const title = jobItem.querySelector(selectors.jobTitle)?.textContent?.trim() ?? '';
              const tags = jobItem.querySelector(selectors.jobTags)?.textContent?.trim() ?? '';

              const anchor = jobItem.querySelector(selectors.jobLink) as HTMLAnchorElement | null;
              if (!anchor) continue;
              const href = anchor.getAttribute('href') ?? '';
              const url = href.startsWith('http') ? href : baseUrl + href;

              if (title) results.push({ title, company, tags, url });
            }
          }

          return results;
        },
        SEL,
        'https://www.workatastartup.com',
        jobsPerCombination,
      );

      const batchJobs: RawJob[] = [];
      for (const raw of rawJobs) {
        if (seenUrls.has(raw.url)) continue;
        seenUrls.add(raw.url);

        const job: RawJob = {
          title: raw.title,
          company: raw.company,
          location: raw.tags,
          datePosted: scrapedAt,
          url: raw.url,
          description: raw.tags,
          source: SOURCE,
          scrapedAt,
        };
        jobs.push(job);
        batchJobs.push(job);
      }

      if (batchJobs.length > 0) onProgress?.(batchJobs);
      console.log(`[ycombinator] "${param}=${value}": ${rawJobs.length} listings`);
    } catch (err) {
      const msg = `[ycombinator] Error scraping "${param}=${value}": ${err instanceof Error ? err.message : String(err)}`;
      console.error(msg);
      errors.push(msg);
    }

    await delay(Math.max(minWait, 5000), Math.max(minWait, 9000));
  }

  await page.close();
  console.log(`[ycombinator] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
  return { source: SOURCE, jobs, errors };
}
