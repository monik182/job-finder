import { writeFileSync, readFileSync } from 'node:fs';
import { type RawJob, type FilteredJob, type ExcludedJob, type ExcludedJobsStore } from '../types.js';

// ─── Time window configuration ────────────────────────────────────────────

const DEFAULT_HOURS = 72;
const MAX_HOURS = 6 * 30 * 24; // 6 months (4320 h)

function parseHoursArg(): number {
  const arg = process.argv.find((a) => a.startsWith('--hours='));
  if (!arg) return DEFAULT_HOURS;

  const parsed = parseFloat(arg.slice('--hours='.length));

  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HOURS;

  const hours = Math.ceil(parsed);
  return Math.min(hours, MAX_HOURS);
}

const HOURS_WINDOW = parseHoursArg();

// ─── Hard exclusion patterns ───────────────────────────────────────────────

const EXCLUDE_US_ONLY =
  /\b(US|U\.S\.|United States)\s+(citizen|citizenship|work\s*auth|only|resident|person)\b/i;
const EXCLUDE_CLEARANCE = /security\s+clearance|clearance\s+required|\bcleared\b/i;
const EXCLUDE_C_LEVEL =
  /\b(staff\s+engineer|principal\s+engineer|VP|vice\s+president|C-level|CTO|CEO|CPO|CMO|director)\b/i;
const EXCLUDE_INTERN =
  /\b(intern|internship|junior|jr\.?|entry[- ]level)\b/i;
const EXCLUDE_ON_SITE =
  /\b(on[- ]?site|hybrid|in[- ]office|in[- ]person|must\s+relocate)\b/i;
const EXCLUDE_INDIA =
  /\b(india|indian\s+market|india[- ]based|bangalore|bengaluru|mumbai|delhi|hyderabad|chennai|pune|kolkata|noida|gurugram|gurgaon)\b|\(IN\)|₹/i;
const EXCLUDE_UAE =
  /\b(UAE|united\s+arab\s+emirates|dubai|abu\s+dhabi|sharjah|ajman|ras\s+al[- ]khaimah|fujairah|umm\s+al[- ]quwain|gulf|GCC|saudi\s+arabia|riyadh|jeddah|qatar|doha|kuwait|bahrain|oman|muscat)\b/i;

// ─── Required inclusion patterns ──────────────────────────────────────────

const INCLUDE_TECH = /react|angular|next\.?js|node\.?js|typescript/i;
const INCLUDE_ROLE = /frontend|front[- ]end|fullstack|full[- ]stack/i;
const INCLUDE_CONTRACT = /contract|contractor|freelance|part[- ]?time/i;
const INCLUDE_REMOTE = /\bremote\b/i;
const INCLUDE_FULLTIME_EMEA_EXCEPTION = /remote.{0,30}(worldwide|global|emea|anywhere)/i;

// ─── Priority flag patterns ────────────────────────────────────────────────

const PRIORITY_CONTRACT = /\b(contractor|freelance)\b/i;
const PRIORITY_AI = /\b(ai|openai|automation|n8n|llm|machine\s+learning|artificial\s+intelligence)\b/i;
const PRIORITY_COMPANY_SIZE = /\b([5-9]\d|[1-4]\d\d)\s*employees?\b/i;

// Salary patterns: $80k, $80,000, $80/hr, $40 per hour, $40/hour
const SALARY_PATTERN =
  /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*k?\s*(?:\/|\s+per\s+)?\s*(hr|hour|yr|year|annual)?/gi;

function extractSalaryPriority(text: string): string | null {
  SALARY_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SALARY_PATTERN.exec(text)) !== null) {
    const rawNum = match[1]?.replace(/,/g, '') ?? '0';
    const unit = match[2]?.toLowerCase() ?? '';
    let amount = parseFloat(rawNum);

    // If value looks like "80k" style (the 'k' suffix in pattern)
    if (match[0]?.toLowerCase().includes('k') && amount < 10_000) {
      amount *= 1_000;
    }

    const isHourly = unit.startsWith('hr') || unit.startsWith('hour');
    const isAnnual = unit.startsWith('yr') || unit.startsWith('year') || unit === 'annual';

    // If no unit specified and amount < 10_000, assume hourly; otherwise annual
    const normalizedAnnual = isHourly
      ? amount * 2_000
      : isAnnual
        ? amount
        : amount < 500
          ? amount * 2_000 // likely hourly rate
          : amount;

    const normalizedHourly = isHourly
      ? amount
      : isAnnual
        ? amount / 2_000
        : amount >= 500
          ? amount / 2_000
          : amount;

    if (normalizedAnnual >= 80_000 || normalizedHourly >= 40) {
      return `salary $${Math.round(normalizedHourly)}/hr`;
    }
  }

  return null;
}

function isPostedWithinWindow(datePosted: string | null, scrapedAt: string): boolean {
  if (!datePosted) return false;
  const posted = new Date(datePosted).getTime();
  const scraped = new Date(scrapedAt).getTime();
  if (isNaN(posted) || isNaN(scraped)) return false;
  const windowMs = (HOURS_WINDOW + 1) * 60 * 60 * 1_000; // +1h buffer for clock skew
  return scraped - posted <= windowMs;
}

function isRemote(job: RawJob): boolean {
  const combined = `${job.location} ${job.description}`.toLowerCase();
  return INCLUDE_REMOTE.test(combined);
}

export interface FilterResult {
  filtered: FilteredJob[];
  excluded: ExcludedJob[];
}

export function filterJobs(jobs: RawJob[]): FilterResult {
  const filtered: FilteredJob[] = [];
  const excluded: ExcludedJob[] = [];
  const excludedAt = new Date().toISOString();

  for (const job of jobs) {
    const combined = `${job.title} ${job.description}`;
    const exclusionReasons: string[] = [];

    // ── Pass 1: Hard exclusions ────────────────────────────────────────────
    if (EXCLUDE_US_ONLY.test(combined)) exclusionReasons.push('us-only');
    if (EXCLUDE_CLEARANCE.test(combined)) exclusionReasons.push('clearance-required');
    if (EXCLUDE_C_LEVEL.test(job.title)) exclusionReasons.push('c-level-title');
    if (EXCLUDE_INTERN.test(job.title)) exclusionReasons.push('intern-or-junior');
    if (EXCLUDE_ON_SITE.test(combined)) exclusionReasons.push('on-site-or-hybrid');
    if (EXCLUDE_INDIA.test(`${job.location} ${combined}`)) exclusionReasons.push('india-market');
    if (EXCLUDE_UAE.test(`${job.location} ${combined}`)) exclusionReasons.push('uae-gulf-market');

    // ── Pass 2: Required inclusions ────────────────────────────────────────
    if (!INCLUDE_TECH.test(combined)) exclusionReasons.push('no-tech-match');
    if (!INCLUDE_ROLE.test(combined)) exclusionReasons.push('no-role-match');
    if (!isRemote(job)) exclusionReasons.push('not-remote');
    if (!isPostedWithinWindow(job.datePosted, job.scrapedAt)) exclusionReasons.push('too-old');

    // Contract type check disabled — keeping for future use
    // const isContractType = INCLUDE_CONTRACT.test(combined);
    // const isFullTimeEmea = INCLUDE_FULLTIME_EMEA_EXCEPTION.test(combined);
    // if (!isContractType && !isFullTimeEmea) exclusionReasons.push('no-contract-type');

    if (exclusionReasons.length > 0) {
      excluded.push({
        title: job.title,
        company: job.company,
        url: job.url,
        source: job.source,
        excludedAt,
        reasons: exclusionReasons,
      });
      continue;
    }

    // ── Pass 3: Priority flags ─────────────────────────────────────────────
    const priorityReasons: string[] = [];

    if (PRIORITY_CONTRACT.test(combined)) priorityReasons.push('contractor/freelance');
    if (PRIORITY_AI.test(combined)) priorityReasons.push('AI/automation');
    if (PRIORITY_COMPANY_SIZE.test(combined)) priorityReasons.push('startup size');

    const salaryReason = extractSalaryPriority(combined);
    if (salaryReason) priorityReasons.push(salaryReason);

    filtered.push({
      ...job,
      isHighPriority: priorityReasons.length > 0,
      priorityReasons,
    });
  }

  return { filtered, excluded };
}

export function saveExcludedJobs(path: string, newExclusions: ExcludedJob[]): void {
  let store: ExcludedJobsStore;

  try {
    store = JSON.parse(readFileSync(path, 'utf-8')) as ExcludedJobsStore;
  } catch {
    store = { lastUpdated: new Date().toISOString(), jobs: [] };
  }

  store.jobs.push(...newExclusions);
  store.lastUpdated = new Date().toISOString();

  writeFileSync(path, JSON.stringify(store, null, 2), 'utf-8');
}
