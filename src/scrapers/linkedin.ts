import { type Browser, type Page } from 'puppeteer-core';
import { type RawJob, type ScrapeResult } from '../types.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';

const SOURCE = 'linkedin' as const;
const LOGIN_URL = 'https://www.linkedin.com/login/';
const BASE_URL = 'https://www.linkedin.com/jobs/search/';
const LI_BASE_URL = 'https://www.linkedin.com';

// How many paginated pages to visit per keyword+geo combination (start with 1)
const MAX_PAGES = 1;
// Maximum jobs to extract per keyword+geo combination (start with 10)
const MAX_JOBS_PER_SEARCH = 10;

// Fixed search parameters applied to every search
// f_E=3,4       → Mid-Senior + Director experience level
// f_WT=2        → Remote
// f_JT=P,C,T    → Full-time, Contract, Temporary
// sortBy=DD     → Most recent
// f_TPR=r604800 → Past week
const FIXED_PARAMS: Record<string, string> = {
  f_E: '3,4',
  f_WT: '2',
  f_JT: 'P,C,T',
  sortBy: 'DD',
  refresh: 'true',
  f_TPR: 'r604800',
};

const GEO_IDS = [
  { id: '91000000', label: 'European Union' },
  { id: '91000011', label: 'Latin America' },
];

const KEYWORDS = [
  'react',
  'angular',
  'typescript',
  'frontend',
  'fullstack',
  'next.js',
  'node.js',
];

const SEL = {
  // Login
  emailInput: 'input[type="email"]',
  passwordInput: 'input[type="password"]',
  // Job list — each li contains a div with data-job-id
  jobListItems: 'main#main ul li',
  // Job detail panel
  detailTitle: 'div.job-details-jobs-unified-top-card__job-title h1 a',
  detailCompany: '.job-details-jobs-unified-top-card__company-name a',
  detailLocation: '.job-details-jobs-unified-top-card__bullet',
  detailDescription: 'div.jobs-description__content.jobs-description-content',
  // Pagination
  paginationContainer: 'div.jobs-search-pagination.jobs-search-results-list__pagination',
  paginationNext: 'button.jobs-search-pagination__button.jobs-search-pagination__button--next',
} as const;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function moveMouse(page: Page): Promise<void> {
  const x = randomInt(200, 1100);
  const y = randomInt(100, 700);
  await page.mouse.move(x, y, { steps: randomInt(8, 20) });
}

function buildUrl(keyword: string, geoId: string): string {
  const params = new URLSearchParams({ ...FIXED_PARAMS, keywords: keyword, geoId });
  return `${BASE_URL}?${params.toString()}`;
}

function isAuthWall(url: string): boolean {
  return url.includes('/login') || url.includes('/checkpoint') || url.includes('/authwall');
}

export async function scrapeLinkedIn(browser: Browser): Promise<ScrapeResult> {
  const jobs: RawJob[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  const scrapedAt = new Date().toISOString();

  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  if (!email || !password) {
    return {
      source: SOURCE,
      jobs,
      errors: ['[linkedin] LINKEDIN_EMAIL or LINKEDIN_PASSWORD not set in environment'],
    };
  }

  const page = await newPage(browser);

  // ── Login ─────────────────────────────────────────────────────────────────

  try {
    const loginOk = await safeGoto(page, LOGIN_URL, 15_000);
    if (!loginOk) {
      errors.push('[linkedin] Failed to load login page');
      await page.close();
      return { source: SOURCE, jobs, errors };
    }

    await page.waitForSelector(SEL.emailInput, { timeout: 15_000 });
    await delay(randomInt(800, 1500), randomInt(800, 1500));
    await moveMouse(page);

    // Email
    await page.click(SEL.emailInput);
    await page.type(SEL.emailInput, email, { delay: randomInt(80, 150) });
    await delay(randomInt(600, 1200), randomInt(600, 1200));
    await moveMouse(page);

    // Password
    await page.click(SEL.passwordInput);
    await page.type(SEL.passwordInput, password, { delay: randomInt(80, 150) });
    await delay(randomInt(500, 900), randomInt(500, 900));
    await moveMouse(page);

    // "Keep me signed in" checkbox
    await page.evaluate(() => {
      const labels = document.querySelectorAll('label');
      for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        if (!label) continue;
        if (label.textContent?.includes('Keep me logged in')) {
          const forAttr = label.getAttribute('for');
          const checkbox = forAttr
            ? document.getElementById(forAttr)
            : label.querySelector('input[type="checkbox"]');
          if (checkbox && 'checked' in checkbox && !(checkbox as HTMLInputElement).checked) {
            (checkbox as HTMLInputElement).click();
          }
          break;
        }
      }
    });
    await delay(randomInt(300, 700), randomInt(300, 700));
    await moveMouse(page);

    // "Sign in" button (type="button", text "Sign in")
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        if (btn?.textContent?.trim().toLowerCase() === 'sign in') {
          (btn as HTMLButtonElement).click();
          break;
        }
      }
    });

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (isAuthWall(page.url())) {
      const msg = `[linkedin] Login may have failed — landed on: ${page.url()}`;
      console.error(msg);
      errors.push(msg);
      await page.close();
      return { source: SOURCE, jobs, errors };
    }

    console.log('[linkedin] Login successful');
    await delay(randomInt(2000, 3500), randomInt(2000, 3500));
  } catch (err) {
    const msg = `[linkedin] Login error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    errors.push(msg);
    await page.close();
    return { source: SOURCE, jobs, errors };
  }

  // ── Scrape: each geoId × each keyword ────────────────────────────────────

  for (const geo of GEO_IDS) {
    for (const keyword of KEYWORDS) {
      const searchUrl = buildUrl(keyword, geo.id);
      console.log(`[linkedin] Scraping "${keyword}" in ${geo.label}…`);

      try {
        const ok = await safeGoto(page, searchUrl, 30_000);
        if (!ok) {
          errors.push(`[linkedin] Failed to load: ${searchUrl}`);
          continue;
        }

        if (isAuthWall(page.url())) {
          const msg = `[linkedin] Auth wall hit for "${keyword}" in ${geo.label} — stopping`;
          console.warn(msg);
          errors.push(msg);
          await page.close();
          return { source: SOURCE, jobs, errors };
        }

        await moveMouse(page);
        await delay(randomInt(1000, 2000), randomInt(1000, 2000));

        let jobsThisSearch = 0;

        for (let pageNum = 0; pageNum < MAX_PAGES && jobsThisSearch < MAX_JOBS_PER_SEARCH; pageNum++) {
          // Wait for the job list to render
          try {
            await page.waitForSelector(SEL.jobListItems, { timeout: 15_000 });
          } catch {
            console.warn(`[linkedin] No job list for "${keyword}" in ${geo.label}, page ${pageNum + 1}`);
            break;
          }

          // Scroll within the list panel to trigger lazy-loading
          await page.evaluate(() => {
            const listPanel = document.querySelector<HTMLElement>('div.scaffold-layout__list');
            if (listPanel) listPanel.scrollTop += 600;
            else window.scrollBy(0, 400);
          });
          await delay(randomInt(1200, 2200), randomInt(1200, 2200));
          await moveMouse(page);

          const jobItems = await page.$$(SEL.jobListItems);

          for (const item of jobItems) {
            if (jobsThisSearch >= MAX_JOBS_PER_SEARCH) break;

            // Only process items that contain a job card (have a data-job-id somewhere)
            const isJobCard = await item.evaluate((el) =>
              !!(el.querySelector('[data-job-id]') || el.getAttribute('data-occludable-job-id')),
            );
            if (!isJobCard) continue;

            // Grab date from the time element before clicking
            const dateIso = await item.evaluate((el) => {
              const t = el.querySelector('time');
              return t?.getAttribute('datetime') ?? t?.textContent?.trim() ?? '';
            });

            // Scroll item into view and pause before clicking
            await item.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await delay(randomInt(400, 900), randomInt(400, 900));
            await moveMouse(page);
            await delay(randomInt(300, 600), randomInt(300, 600));

            try {
              await item.click();
            } catch {
              continue;
            }

            // Wait for detail panel to populate
            await delay(randomInt(1500, 2800), randomInt(1500, 2800));
            await moveMouse(page);

            try {
              await page.waitForSelector(SEL.detailTitle, { timeout: 10_000 });
            } catch {
              continue; // detail didn't load — skip
            }

            // Extract from detail panel
            const jobData = await page.evaluate(
              (selectors: typeof SEL, baseUrl: string) => {
                const titleEl = document.querySelector<HTMLAnchorElement>(selectors.detailTitle);
                const title = titleEl?.textContent?.trim() ?? '';
                const href = titleEl?.getAttribute('href') ?? '';
                const url = href.startsWith('http') ? href : `${baseUrl}${href}`;

                const company =
                  document.querySelector(selectors.detailCompany)?.textContent?.trim() ?? '';
                const location =
                  document.querySelector(selectors.detailLocation)?.textContent?.trim() ?? '';
                const description =
                  document.querySelector(selectors.detailDescription)?.textContent?.trim().slice(0, 3000) ?? '';

                return { title, url, company, location, description };
              },
              SEL,
              LI_BASE_URL,
            );

            if (!jobData.title || !jobData.url) continue;
            if (seenUrls.has(jobData.url)) continue;
            seenUrls.add(jobData.url);

            jobs.push({
              title: jobData.title,
              company: jobData.company,
              location: jobData.location,
              datePosted: parseRelativeDate(dateIso),
              url: jobData.url,
              description: jobData.description,
              source: SOURCE,
              scrapedAt,
            });

            jobsThisSearch++;
            console.log(`[linkedin]   ✓ "${jobData.title}" @ "${jobData.company}"`);
          }

          // Paginate if more pages remain
          if (pageNum < MAX_PAGES - 1 && jobsThisSearch < MAX_JOBS_PER_SEARCH) {
            try {
              await page.evaluate((sel: string) => {
                document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }, SEL.paginationContainer);

              await delay(randomInt(1000, 2000), randomInt(1000, 2000));
              await moveMouse(page);

              const nextBtn = await page.$(SEL.paginationNext);
              if (!nextBtn) break;

              await nextBtn.click();
              await delay(randomInt(2500, 4000), randomInt(2500, 4000));
            } catch {
              break;
            }
          }
        }

        console.log(`[linkedin] "${keyword}" in ${geo.label}: ${jobsThisSearch} jobs`);
      } catch (err) {
        const msg = `[linkedin] Error on "${keyword}" in ${geo.label}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(msg);
        errors.push(msg);
      }

      await delay(randomInt(5000, 9000), randomInt(5000, 9000));
    }

    // Extra pause between geographic regions
    await delay(randomInt(8000, 12000), randomInt(8000, 12000));
  }

  await page.close();
  console.log(`[linkedin] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
  return { source: SOURCE, jobs, errors };
}
