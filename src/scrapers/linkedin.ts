import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, type CookieParam } from 'puppeteer-core';
import { type RawJob, type ScrapeResult, type InlineFilterStats } from '../types.js';
import { type AppConfig, type GeoLocation, type ExperienceLevel, type ContractType, getSearchTerms } from '../config.js';
import { type InlineJobFilter } from '../filters/inline-filter.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';
import { getBrowser, closeBrowser } from '../browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = resolve(__dirname, '..', '..', 'linkedin-cookies.json');

function loadCookies(): CookieParam[] | null {
  if (!existsSync(COOKIES_PATH)) return null;
  try {
    return JSON.parse(readFileSync(COOKIES_PATH, 'utf-8')) as CookieParam[];
  } catch {
    return null;
  }
}

async function saveCookies(page: Page): Promise<void> {
  const cookies = await page.cookies();
  writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('[linkedin] Cookies saved to linkedin-cookies.json');
}

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
  detailDate: 'div.job-details-jobs-unified-top-card__primary-description-container > div > span span:nth-child(3)',
  detailCompany: '.job-details-jobs-unified-top-card__company-name a',
  detailLocation: '.job-details-jobs-unified-top-card__bullet',
  detailDescription: 'div.jobs-description__content.jobs-description-content',
  // Pagination
  paginationContainer: 'div.jobs-search-pagination.jobs-search-results-list__pagination',
  paginationNext: 'button.jobs-search-pagination__button.jobs-search-pagination__button--next',
} as const;

const HEADED = process.env['HEADED'] === 'true';

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Capped delay — in headless mode, max 1s. In headed mode, uses the original range. */
function liDelay(min: number, max: number): Promise<void> {
  if (!HEADED) return delay(Math.min(min, 500), Math.min(max, 1000));
  return delay(min, max);
}

async function moveMouse(page: Page): Promise<void> {
  if (!HEADED) return; // skip in headless — no human to simulate
  try {
    const x = randomInt(200, 1100);
    const y = randomInt(100, 700);
    await page.mouse.move(x, y, { steps: randomInt(8, 20) });
  } catch { /* ignore — cosmetic only */ }
}

function buildUrl(keyword: string, geoId: string, fixedParams: Record<string, string>): string {
  const params = new URLSearchParams({ ...fixedParams, keywords: keyword, geoId });
  return `${BASE_URL}?${params.toString()}`;
}

function isAuthWall(url: string): boolean {
  return url.includes('/login') || url.includes('/checkpoint') || url.includes('/authwall');
}

/** Check whether the page is still usable (not closed, frame not detached). */
function isPageAlive(page: Page): boolean {
  try {
    if (page.isClosed()) return false;
    // Accessing mainFrame() will throw if the frame is detached
    const frame = page.mainFrame();
    // A detached frame has no execution context — url() can still work but
    // evaluate() won't, so we just check the obvious signal.
    return !frame.detached;
  } catch {
    return false;
  }
}

/** Returns true if the error message indicates a detached frame / dead session. */
function isDetachedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /detached Frame|Target closed|Session closed|Protocol error|frame was detached/i.test(msg);
}

const EMPTY_INLINE_STATS: InlineFilterStats = { skippedAsSeen: 0, skippedByHardExclusion: 0, excludedJobs: [] };

export async function scrapeLinkedIn(
  browser: Browser,
  config: AppConfig,
  onProgress?: (newJobs: RawJob[]) => void,
  inlineFilter?: InlineJobFilter,
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
      inlineStats: EMPTY_INLINE_STATS,
    };
  }

  let currentBrowser = browser;
  let page = await newPage(currentBrowser);

  // ── Auth: try saved cookies first, fall back to login ────────────────────

  let loginSucceeded = false;
  let activeCookies: Awaited<ReturnType<typeof page.cookies>> | null = null;

  // ── Session refresh helper ───────────────────────────────────────────────
  // Spins up a fresh Browserless session and restores cookies.
  // Returns true on success, pushes to `errors` on failure.
  async function refreshSession(reason: string): Promise<boolean> {
    console.log(`[linkedin] Refreshing session — ${reason}`);
    await closeBrowser(currentBrowser);
    try {
      currentBrowser = await getBrowser();
      page = await newPage(currentBrowser);
      if (activeCookies) {
        await page.setCookie(...activeCookies);
        const ok = await safeGoto(page, 'https://www.linkedin.com/feed/', 15_000);
        if (!ok || isAuthWall(page.url())) {
          errors.push(`[linkedin] Auth failed after session refresh (${reason})`);
          return false;
        }
        console.log('[linkedin] Session refreshed');
        await liDelay(randomInt(1000, 2000), randomInt(1000, 2000));
        return true;
      }
      errors.push('[linkedin] No cookies available for session refresh');
      return false;
    } catch (e) {
      errors.push(`[linkedin] Session refresh failed (${reason}): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  // ── Recovery helper ──────────────────────────────────────────────────────
  // Tries to get back to a working state after a crash / detached frame.
  async function recoverPage(): Promise<boolean> {
    console.warn('[linkedin] Page died — attempting recovery…');
    try {
      // Timeout page.close() — it can hang indefinitely on detached CDP sessions
      try { await Promise.race([page.close(), new Promise(r => setTimeout(r, 3000))]); } catch { /* already dead */ }

      // Try creating a new page on the existing browser first
      try {
        page = await newPage(currentBrowser);
      } catch {
        // Browser session is dead — reconnect entirely
        console.warn('[linkedin] Browser disconnected — reconnecting…');
        currentBrowser = await getBrowser();
        page = await newPage(currentBrowser);
      }

      if (activeCookies) {
        await page.setCookie(...activeCookies);
        const ok = await safeGoto(page, 'https://www.linkedin.com/feed/', 15_000);
        if (ok && !isAuthWall(page.url())) {
          console.log('[linkedin] Recovery successful');
          await liDelay(randomInt(1500, 2500), randomInt(1500, 2500));
          return true;
        }
      }
    } catch (e) {
      console.error('[linkedin] Recovery failed:', e instanceof Error ? e.message : String(e));
    }
    return false;
  }

  const savedCookies = loadCookies();
  if (savedCookies) {
    console.log('[linkedin] Found saved cookies — attempting cookie-based auth…');
    await page.setCookie(...savedCookies);
    const ok = await safeGoto(page, 'https://www.linkedin.com/feed/', 15_000);
    if (ok && !isAuthWall(page.url())) {
      console.log('[linkedin] Cookie auth successful');
      loginSucceeded = true;
      activeCookies = await page.cookies();
      await liDelay(randomInt(1500, 2500), randomInt(1500, 2500));
    } else {
      console.warn('[linkedin] Cookies expired or invalid — falling back to login');
    }
  }

  if (!loginSucceeded) {
    const MAX_LOGIN_ATTEMPTS = 3;
    let lastLoginError = '';

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          console.warn(`[linkedin] Retrying login (attempt ${attempt}/${MAX_LOGIN_ATTEMPTS})…`);
          await liDelay(randomInt(2000, 4000), randomInt(2000, 4000));
        }

        const loginLoaded = await safeGoto(page, LOGIN_URL, 15_000);
        if (!loginLoaded) {
          lastLoginError = '[linkedin] Failed to load login page';
          continue;
        }

        await page.waitForSelector(SEL.emailInput, { timeout: 15_000, visible: true });
        await liDelay(randomInt(800, 1500), randomInt(800, 1500));
        await moveMouse(page);

        await page.click(SEL.emailInput);
        await page.type(SEL.emailInput, email, { delay: randomInt(80, 150) });
        await liDelay(randomInt(600, 1200), randomInt(600, 1200));
        await moveMouse(page);

        await page.click(SEL.passwordInput);
        await page.type(SEL.passwordInput, password, { delay: randomInt(80, 150) });
        await liDelay(randomInt(500, 900), randomInt(500, 900));
        await moveMouse(page);

        // "Sign in" button
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
        await saveCookies(page);
        activeCookies = await page.cookies();
        await liDelay(randomInt(2000, 3500), randomInt(2000, 3500));
        break;
      } catch (err) {
        lastLoginError = `[linkedin] Login error: ${err instanceof Error ? err.message : String(err)}`;
        try {
          const screenshotPath = `debug-linkedin-login-attempt-${attempt}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          console.error(`[linkedin] Screenshot saved: ${screenshotPath}`);
        } catch { /* ignore screenshot errors */ }
        console.error(`${lastLoginError}${attempt < MAX_LOGIN_ATTEMPTS ? ' — will retry' : ''}`);
      }
    }

    if (!loginSucceeded) {
      errors.push(lastLoginError);
      await page.close();
      return { source: SOURCE, jobs, errors, inlineStats: inlineFilter?.stats ?? EMPTY_INLINE_STATS };
    }
  }

  // ── Scrape: each geoId × each keyword × each experience ──────────────────

  const geoIds = config.filters.geoLocations
    .filter((loc) => loc in GEO_ID_MAP)
    .map((loc) => GEO_ID_MAP[loc]);

  const maxPages = config.scraping.maxPages;
  const maxJobsPerSearch = config.scraping.maxJobs;
  const minWait = config.scraping.minDelayMs;

  // Track total searches so we know when to refresh (every search gets a fresh session)
  let searchCount = 0;

  for (const geo of geoIds) {
    for (const keyword of getSearchTerms(config)) {
      for (const exp of config.filters.experience) {
        // ── Refresh session before every search (except the very first) ────
        // Browserless sessions expire after ~60s. A single search (navigate +
        // scroll + click jobs + paginate) consumes most of that budget, so we
        // give each search its own fresh session.
        if (searchCount > 0) {
          const ok = await refreshSession(`before "${keyword}" / ${exp} in ${geo.label}`);
          if (!ok) {
            // Auth is broken — no point continuing
            errors.push('[linkedin] Stopping: could not refresh session');
            try { await page.close(); } catch { /* ignore */ }
            console.log(`[linkedin] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
            return { source: SOURCE, jobs, errors, inlineStats: inlineFilter?.stats ?? EMPTY_INLINE_STATS };
          }
        }
        searchCount++;

        const fixedParams = buildLinkedInParamsForExp(config, exp);
        const searchUrl = buildUrl(keyword, geo.id, fixedParams);
        console.log(`[linkedin] Scraping "${keyword}" / ${exp} in ${geo.label}: ${searchUrl}`);

        try {
          // Guard: make sure page is still alive before navigating
          if (!isPageAlive(page)) {
            console.warn('[linkedin] Page not alive before navigation — recovering');
            const recovered = await recoverPage();
            if (!recovered) {
              errors.push(`[linkedin] Could not recover before "${keyword}" / ${exp}`);
              continue;
            }
          }

          const ok = await safeGoto(page, searchUrl, 30_000);
          if (!ok) {
            errors.push(`[linkedin] Failed to load: ${searchUrl}`);
            continue;
          }

          if (isAuthWall(page.url())) {
            const msg = `[linkedin] Auth wall hit for "${keyword}" in ${geo.label} — stopping`;
            console.warn(msg);
            errors.push(msg);
            try { await page.close(); } catch { /* ignore */ }
            return { source: SOURCE, jobs, errors, inlineStats: inlineFilter?.stats ?? EMPTY_INLINE_STATS };
          }

          await moveMouse(page);
          await liDelay(minWait, minWait + 2000);

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
            try {
              await page.evaluate(() => {
                const listPanel = document.querySelector<HTMLElement>('div.scaffold-layout__list');
                if (listPanel) listPanel.scrollTop += 600;
                else window.scrollBy(0, 400);
              });
            } catch (scrollErr) {
              if (isDetachedError(scrollErr)) {
                console.warn('[linkedin] Frame detached during scroll — breaking page loop');
                break;
              }
            }
            await liDelay(randomInt(1200, 2200), randomInt(1200, 2200));
            await moveMouse(page);

            // Re-query job items fresh each page (never hold stale ElementHandles across waits)
            let jobItems;
            try {
              jobItems = await page.$$(SEL.jobListItems);
            } catch (queryErr) {
              if (isDetachedError(queryErr)) {
                console.warn('[linkedin] Frame detached querying job items — breaking page loop');
                break;
              }
              throw queryErr;
            }

            for (const item of jobItems) {
              if (jobsThisSearch >= maxJobsPerSearch) break;

              // Guard: bail early if the page died mid-iteration
              if (!isPageAlive(page)) {
                console.warn('[linkedin] Page died mid-iteration — breaking');
                break;
              }

              // Only process items that contain a job card (have a data-job-id somewhere)
              let isJobCard = false;
              try {
                isJobCard = await item.evaluate((el) =>
                  !!(el.querySelector('[data-job-id]') || el.getAttribute('data-occludable-job-id')),
                );
              } catch (e) {
                // If the element handle is stale / frame detached, skip this item
                if (isDetachedError(e)) continue;
                continue;
              }
              if (!isJobCard) continue;

              // Grab date from the time element before clicking
              let dateIso = '';
              try {
                dateIso = await item.evaluate((el) => {
                  const t = el.querySelector('time');
                  return t?.getAttribute('datetime') ?? t?.textContent?.trim() ?? '';
                });
              } catch { /* best-effort */ }

              // Scroll item into view and pause before clicking
              try {
                await item.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
              } catch (e) {
                if (isDetachedError(e)) continue;
                continue;
              }
              await liDelay(randomInt(400, 900), randomInt(400, 900));
              await moveMouse(page);
              await liDelay(randomInt(300, 600), randomInt(300, 600));

              try {
                await item.click();
              } catch (e) {
                if (isDetachedError(e)) {
                  console.warn('[linkedin] Frame detached on click — breaking item loop');
                  break;
                }
                continue;
              }

              // Wait for detail panel to populate
              await liDelay(randomInt(1500, 2800), randomInt(1500, 2800));
              await moveMouse(page);

              try {
                await page.waitForSelector(SEL.detailTitle, { timeout: 10_000 });
              } catch (e) {
                if (isDetachedError(e)) {
                  console.warn('[linkedin] Frame detached waiting for detail — breaking item loop');
                  break;
                }
                continue; // detail didn't load — skip
              }

              // Extract from detail panel
              let jobData;
              try {
                jobData = await page.evaluate(
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
                    const detailDateText =
                      document.querySelector(selectors.detailDate)?.textContent?.trim() ?? '';

                    return { title, url, company, location, description, detailDateText };
                  },
                  SEL,
                  LI_BASE_URL,
                );
              } catch (e) {
                if (isDetachedError(e)) {
                  console.warn('[linkedin] Frame detached during extraction — breaking item loop');
                  break;
                }
                continue;
              }

              if (!jobData.title || !jobData.url) continue;
              if (seenUrls.has(jobData.url)) continue;
              seenUrls.add(jobData.url);

              const job: RawJob = {
                title: jobData.title,
                company: jobData.company,
                location: jobData.location,
                datePosted: parseRelativeDate(jobData.detailDateText) ?? parseRelativeDate(dateIso) ?? new Date().toISOString(),
                url: jobData.url,
                description: jobData.description,
                source: SOURCE,
                scrapedAt,
              };

              if (inlineFilter && !inlineFilter.check(job)) continue;

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

                await liDelay(randomInt(1000, 2000), randomInt(1000, 2000));
                await moveMouse(page);

                const nextBtn = await page.$(SEL.paginationNext);
                if (!nextBtn) break;

                await nextBtn.click();
                await liDelay(minWait, minWait + 2000);
              } catch (e) {
                if (isDetachedError(e)) {
                  console.warn('[linkedin] Frame detached during pagination — breaking page loop');
                }
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

          if (isDetachedError(err) || !isPageAlive(page)) {
            const recovered = await recoverPage();
            if (!recovered) {
              console.warn('[linkedin] Recovery failed — stopping scrape');
              return { source: SOURCE, jobs, errors, inlineStats: inlineFilter?.stats ?? EMPTY_INLINE_STATS };
            }
          }
        }

        // Brief pause between experience levels (the session refresh above is the main pause)
        await liDelay(randomInt(1000, 2000), randomInt(1000, 2000));
      }
    }

    // Extra pause between geographic regions
    await liDelay(Math.max(minWait, 2000), Math.max(minWait, 4000));
  }

  try { await page.close(); } catch { /* ignore */ }
  console.log(`[linkedin] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
  return { source: SOURCE, jobs, errors, inlineStats: inlineFilter?.stats ?? EMPTY_INLINE_STATS };
}