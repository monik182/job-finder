import { type Browser, type Page } from 'puppeteer-core';
import { type RawJob, type ScrapeResult } from '../types.js';
import { type AppConfig, type GeoLocation, type ExperienceLevel, type ContractType } from '../config.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';

const SOURCE = 'linkedin' as const;
const LOGIN_URL = 'https://www.linkedin.com/login/';
const BASE_URL = 'https://www.linkedin.com/jobs/search/';
const LI_BASE_URL = 'https://www.linkedin.com';

// Fixed search parameters (f_E, f_JT, f_TPR are computed from config)
// f_WT=2 → Remote only
// sortBy=DD → Most recent
const BASE_FIXED_PARAMS: Record<string, string> = {
  f_WT: '2',
  sortBy: 'DD',
  refresh: 'true',
};

const LI_EXPERIENCE_MAP: Record<ExperienceLevel, number[]> = {
  junior: [1, 2],
  mid: [3, 4],
  senior: [4],
  lead: [4],
  staff: [4],
  principal: [4],
  director: [5],
  'c-level': [6],
};

const LI_CONTRACT_MAP: Partial<Record<ContractType, string>> = {
  'full-time': 'F',
  'part-time': 'P',
  contract: 'C',
  freelance: 'C',
  temporary: 'T',
};

function buildLinkedInParamsForExp(config: AppConfig, exp: ExperienceLevel): Record<string, string> {
  const expCodes = [...new Set(LI_EXPERIENCE_MAP[exp] ?? [])].sort((a, b) => a - b);

  // f_JT: from contractTypes; default F,C,T if unconfigured
  const jtCodes = config.filters.contractTypes.length > 0
    ? [...new Set(config.filters.contractTypes.map((ct) => LI_CONTRACT_MAP[ct]).filter(Boolean) as string[])]
    : ['F', 'C', 'T'];

  return {
    ...BASE_FIXED_PARAMS,
    f_E: expCodes.join(','),
    f_JT: jtCodes.join(','),
    f_TPR: `r${config.scraping.maxAgeDays * 86400}`,
  };
}

const GEO_ID_MAP: Record<GeoLocation, { id: string; label: string }> = {
  latam: { id: '91000011', label: 'Latin America' },
  usa: { id: '103644278', label: 'United States' },
  europe: { id: '91000000', label: 'European Union' },
  worldwide: { id: '92000000', label: 'Worldwide' },
};

// Selectors — update here if the site changes
const SEL = {
  // Login page
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

function buildUrl(keyword: string, geoId: string, fixedParams: Record<string, string>): string {
  const params = new URLSearchParams({ ...fixedParams, keywords: keyword, geoId });
  return `${BASE_URL}?${params.toString()}`;
}

function isAuthWall(url: string): boolean {
  return url.includes('/login') || url.includes('/checkpoint') || url.includes('/authwall');
}

export async function scrapeLinkedIn(
  browser: Browser,
  config: AppConfig,
  onProgress?: (newJobs: RawJob[]) => void,
): Promise<ScrapeResult> {
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

  // ── Login (up to 3 attempts) ──────────────────────────────────────────────

  const MAX_LOGIN_ATTEMPTS = 3;
  let loginSucceeded = false;
  let lastLoginError = '';

  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        console.warn(`[linkedin] Retrying login (attempt ${attempt}/${MAX_LOGIN_ATTEMPTS})…`);
        await delay(randomInt(2000, 4000), randomInt(2000, 4000));
      }

      const loginLoaded = await safeGoto(page, LOGIN_URL, 15_000);
      if (!loginLoaded) {
        lastLoginError = '[linkedin] Failed to load login page';
        continue;
      }

      await page.waitForSelector(SEL.emailInput, { timeout: 15_000, visible: true });
      await delay(randomInt(800, 1500), randomInt(800, 1500));
      await moveMouse(page);

      // Email — use evaluate to bypass headless clickability issues
      await page.evaluate((sel: string, val: string) => {
        const el = document.querySelector<HTMLInputElement>(sel);
        if (el) {
          el.focus();
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, SEL.emailInput, email);
      await delay(randomInt(600, 1200), randomInt(600, 1200));
      await moveMouse(page);

      // Password — same approach
      await page.evaluate((sel: string, val: string) => {
        const el = document.querySelector<HTMLInputElement>(sel);
        if (el) {
          el.focus();
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, SEL.passwordInput, password);
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
        lastLoginError = `[linkedin] Login may have failed — landed on: ${page.url()}`;
        console.error(lastLoginError);
        continue;
      }

      loginSucceeded = true;
      console.log(`[linkedin] Login successful${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      await delay(randomInt(2000, 3500), randomInt(2000, 3500));
      break;
    } catch (err) {
      lastLoginError = `[linkedin] Login error: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`${lastLoginError}${attempt < MAX_LOGIN_ATTEMPTS ? ' — will retry' : ''}`);
    }
  }

  if (!loginSucceeded) {
    errors.push(lastLoginError);
    await page.close();
    return { source: SOURCE, jobs, errors };
  }

  // ── Scrape: each geoId × each keyword × each experience ──────────────────

  const geoIds = config.filters.geoLocations
    .filter((loc) => loc in GEO_ID_MAP)
    .map((loc) => GEO_ID_MAP[loc]);

  const maxPages = config.scraping.maxPages;
  const maxJobsPerSearch = config.scraping.maxJobs;

  for (const geo of geoIds) {
    for (const keyword of config.filters.skills) {
      for (const exp of config.filters.experience) {
        const fixedParams = buildLinkedInParamsForExp(config, exp);
        const searchUrl = buildUrl(keyword, geo.id, fixedParams);
        console.log(`[linkedin] Scraping "${keyword}" / ${exp} in ${geo.label}…`);

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
        const batchJobs: RawJob[] = [];

        for (let pageNum = 0; pageNum < maxPages && jobsThisSearch < maxJobsPerSearch; pageNum++) {
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
            if (jobsThisSearch >= maxJobsPerSearch) break;

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

            const job: RawJob = {
              title: jobData.title,
              company: jobData.company,
              location: jobData.location,
              datePosted: parseRelativeDate(dateIso),
              url: jobData.url,
              description: jobData.description,
              source: SOURCE,
              scrapedAt,
            };
            jobs.push(job);
            batchJobs.push(job);

            jobsThisSearch++;
            console.log(`[linkedin]   ✓ "${jobData.title}" @ "${jobData.company}"`);
          }

          // Paginate if more pages remain
          if (pageNum < maxPages - 1 && jobsThisSearch < maxJobsPerSearch) {
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

        if (batchJobs.length > 0) onProgress?.(batchJobs);
        console.log(`[linkedin] "${keyword}" / ${exp} in ${geo.label}: ${jobsThisSearch} jobs`);
      } catch (err) {
        const msg = `[linkedin] Error on "${keyword}" / ${exp} in ${geo.label}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(msg);
        errors.push(msg);
      }

      await delay(randomInt(3000, 6000), randomInt(3000, 6000));
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
