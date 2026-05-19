import { type Browser } from 'puppeteer-core';
import { type RawJob, type ScrapeResult } from '../types.js';
import { type AppConfig, type ExperienceLevel, type ContractType, type GeoLocation, getSearchTerms } from '../config.js';
import { newPage, delay, safeGoto, parseRelativeDate } from './utils.js';

const SOURCE = 'working-nomads' as const;
const BASE_URL = 'https://www.workingnomads.com';

const EXPERIENCE_MAP: Record<ExperienceLevel, string> = {
  junior: 'entry-level',
  mid: 'mid-level',
  senior: 'senior',
  lead: 'senior',
  staff: 'senior',
  principal: 'senior',
  director: 'senior',
  'c-level': 'senior',
};

// usa needs both 'usa' and 'north-america' params
const GEO_MAP: Partial<Record<GeoLocation, string[]>> = {
  latam: ['latin-america'],
  usa: ['usa', 'north-america'],
  europe: ['europe'],
  worldwide: ['anywhere'],
};

const CONTRACT_MAP: Partial<Record<ContractType, string>> = {
  'full-time': 'full-time',
  'part-time': 'part-time',
  contract: 'contract',
  freelance: 'contract',
  // 'temporary' has no equivalent — omitted
};

// Selectors — update here if the site changes
const SEL = {
  jobsList: 'div.jobs-list',
  jobItem: 'a.job-desktop[id^="job-"]',
  showMore: 'div.show-more',
  // scoped to each job item element
  title: 'div.job-wrapper div.job-cols div.job-left-col h4',
  company: 'div.job-wrapper div.job-cols div.job-left-col div.company',
  date: 'div.job-wrapper div.job-cols div.job-right-col div.date',
  boxes: 'div.job-wrapper div.boxes',
} as const;

interface RawJobData {
  title: string;
  company: string;
  dateText: string;
  url: string;
  location: string;
  description: string;
}

function buildJobsUrl(config: AppConfig, skill: string): string {
  // When remote=true, use 'anywhere' — otherwise map configured geo locations
  const locationParam = config.filters.remote
    ? 'anywhere'
    : (() => {
      const locations = [...new Set(
        config.filters.geoLocations.flatMap((geo) => GEO_MAP[geo] ?? []),
      )];
      return locations.length > 0 ? locations.join(',') : 'anywhere';
    })();

  // Collect unique experience param values
  const experienceValues = [...new Set(
    config.filters.experience.map((lvl) => EXPERIENCE_MAP[lvl]),
  )];

  // Collect unique position type param values (omit if contractTypes is empty = allow all)
  const positionTypes = [...new Set(
    config.filters.contractTypes
      .map((ct) => CONTRACT_MAP[ct])
      .filter((v): v is string => v !== undefined),
  )];

  const params = new URLSearchParams();
  params.set('location', locationParam);
  params.set('postedDate', String(config.scraping.maxAgeDays));

  if (experienceValues.length > 0) {
    params.set('experienceLevel', experienceValues.join(','));
  }

  if (positionTypes.length > 0) {
    params.set('positionType', positionTypes.join(','));
  }

  params.set('tag', skill);
  params.set('sort', 'date');

  return `${BASE_URL}/jobs?${params.toString()}`;
}

export async function scrapeWorkingNomads(
  browser: Browser,
  config: AppConfig,
  onProgress?: (newJobs: RawJob[]) => void,
): Promise<ScrapeResult> {
  const jobs: RawJob[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  const scrapedAt = new Date().toISOString();

  const maxPages = config.scraping.maxPages;

  for (const skill of getSearchTerms(config)) {
    const url = buildJobsUrl(config, skill);
    console.log(`[working-nomads] Searching: ${url}`);
    const page = await newPage(browser);

    try {
      const ok = await safeGoto(page, url);
      if (!ok) {
        errors.push(`[working-nomads] Failed to load page for skill "${skill}": ${url}`);
        // await page.close();
        continue;
      }

      // Wait for job list
      try {
        await page.waitForSelector(SEL.jobsList, { timeout: 15_000 });
      } catch {
        errors.push(`[working-nomads] Job list not found for skill "${skill}"`);
        // await page.close();
        continue;
      }

      let pageNum = 1;

      while (pageNum <= maxPages) {
        const rawJobs = await page.evaluate(
          (selectors: typeof SEL, baseUrl: string): RawJobData[] => {
            const results: RawJobData[] = [];
            const items = document.querySelectorAll(selectors.jobItem);

            items.forEach((item) => {
              const relativeHref = item instanceof HTMLAnchorElement
                ? (item.getAttribute('href') ?? '')
                : '';
              const url = relativeHref.startsWith('http')
                ? relativeHref
                : `${baseUrl}${relativeHref}`;

              const title = item.querySelector(selectors.title)?.textContent?.trim() ?? '';
              const company = item.querySelector(selectors.company)?.textContent?.trim() ?? '';
              const dateText = item.querySelector(selectors.date)?.textContent?.trim() ?? '';
              const boxesEl = item.querySelector(selectors.boxes);
              const boxTexts = boxesEl
                ? Array.from(boxesEl.children).map((el) => el.textContent?.trim() ?? '').filter(Boolean)
                : [];

              const location = boxTexts[0] ?? 'Remote';
              const description = boxTexts.join(', ');

              if (title && url) {
                results.push({ title, company, dateText, url, location, description });
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
            location: raw.location,
            datePosted: parseRelativeDate(raw.dateText),
            url: raw.url,
            description: raw.description,
            source: SOURCE,
            scrapedAt,
          };
          jobs.push(job);
          batchJobs.push(job);
        }

        if (batchJobs.length > 0) onProgress?.(batchJobs);
        console.log(`[working-nomads] skill="${skill}" page ${pageNum}: ${rawJobs.length} listings`);

        // Try to click "Show more" for next page
        if (pageNum >= maxPages) break;

        const hasMore = await page.evaluate((showMoreSel: string): boolean => {
          const btn = document.querySelector(showMoreSel);
          return btn !== null && (btn as HTMLElement).offsetParent !== null;
        }, SEL.showMore);

        if (!hasMore) break;

        await page.click(SEL.showMore);
        await delay(2000, 4000);
        pageNum++;
      }
    } catch (err) {
      const msg = `[working-nomads] Error scraping skill "${skill}": ${err instanceof Error ? err.message : String(err)}`;
      console.error(msg);
      errors.push(msg);
    } finally {
      await page.close();
    }

    if (getSearchTerms(config).indexOf(skill) < getSearchTerms(config).length - 1) {
      await delay(5000, 9000);
    }
  }

  console.log(`[working-nomads] Total: ${jobs.length} jobs (${seenUrls.size} unique)`);
  return { source: SOURCE, jobs, errors };
}
