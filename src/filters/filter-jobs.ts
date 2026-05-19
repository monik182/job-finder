import { writeFileSync, readFileSync } from 'node:fs';
import { type RawJob, type FilteredJob, type ExcludedJob, type ExcludedJobsStore } from '../types.js';
import { type AppConfig, type ContractType } from '../config.js';

// ─── Hard exclusion patterns (static, not config-driven) ──────────────────────

const EXCLUDE_US_ONLY =
  /\b(US|U\.S\.|United States)\s+(citizen|citizenship|work\s*auth|only|resident|person)\b/i;
const EXCLUDE_CLEARANCE = /security\s+clearance|clearance\s+required|\bcleared\b/i;
const EXCLUDE_C_LEVEL =
  /\b(staff\s+engineer|principal\s+engineer|VP|vice\s+president|C-level|CTO|CEO|CPO|CMO|director)\b/i;
const EXCLUDE_INTERN =
  /\b(intern|internship|junior|jr\.?|entry[- ]level)\b/i;
const EXCLUDE_ON_SITE =
  /\b(on[- ]?site|in[- ]office|in[- ]person|must\s+relocate)\b/i;
const EXCLUDE_HYBRID = /\bhybrid\b/i;
const EXCLUDE_INDIA =
  /\b(india|indian\s+market|india[- ]based|bangalore|bengaluru|mumbai|delhi|hyderabad|chennai|pune|kolkata|noida|gurugram|gurgaon)\b|\(IN\)|₹/i;
const EXCLUDE_UAE =
  /\b(UAE|united\s+arab\s+emirates|dubai|abu\s+dhabi|sharjah|ajman|ras\s+al[- ]khaimah|fujairah|umm\s+al[- ]quwain|gulf|GCC|saudi\s+arabia|riyadh|jeddah|qatar|doha|kuwait|bahrain|oman|muscat)\b/i;
const INCLUDE_REMOTE = /\bremote\b/i;

// ─── Contract type patterns ────────────────────────────────────────────────────

const CONTRACT_TYPE_PATTERNS: Record<ContractType, RegExp> = {
  'full-time': /\b(full[- ]time|permanent)\b/i,
  'part-time': /\bpart[- ]time\b/i,
  'contract': /\b(contract(or)?|freelance)\b/i,
  'freelance': /\bfreelance\b/i,
  'temporary': /\b(temp(orary)?|temporal)\b/i,
};

// ─── Priority flag patterns ────────────────────────────────────────────────────

const PRIORITY_CONTRACT = /\b(contractor|freelance)\b/i;
const PRIORITY_AI = /\b(ai|openai|automation|n8n|llm|machine\s+learning|artificial\s+intelligence)\b/i;
const PRIORITY_COMPANY_SIZE = /\b([5-9]\d|[1-4]\d\d)\s*employees?\b/i;

const SALARY_PATTERN =
  /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*k?\s*(?:\/|\s+per\s+)?\s*(hr|hour|yr|year|annual)?/gi;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MAX_HOURS = 6 * 30 * 24; // 6 months (4320 h)

function getHoursWindow(config: AppConfig): number {
  const arg = process.argv.find((a) => a.startsWith('--hours='));
  if (arg) {
    const parsed = parseFloat(arg.slice('--hours='.length));
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.ceil(parsed), MAX_HOURS);
    }
  }
  return config.scraping.maxAgeDays * 24;
}

function buildSkillsRegex(skills: string[]): RegExp {
  const escaped = skills.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]'));
  return new RegExp(escaped.join('|'), 'i');
}

function buildJobTitleRegex(jobTitle: string[]): RegExp {
  const escaped = jobTitle.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]'));
  return new RegExp(escaped.join('|'), 'i');
}

interface SalaryAmounts {
  hourly: number;
  annual: number;
  monthly: number;
}

function extractSalaryAmounts(text: string): SalaryAmounts | null {
  SALARY_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SALARY_PATTERN.exec(text)) !== null) {
    const rawNum = match[1]?.replace(/,/g, '') ?? '0';
    const unit = match[2]?.toLowerCase() ?? '';
    let amount = parseFloat(rawNum);

    if (match[0]?.toLowerCase().includes('k') && amount < 10_000) {
      amount *= 1_000;
    }

    const isHourly = unit.startsWith('hr') || unit.startsWith('hour');
    const isAnnual = unit.startsWith('yr') || unit.startsWith('year') || unit === 'annual';

    let hourly: number;
    let annual: number;

    if (isHourly) {
      hourly = amount;
      annual = amount * 2_000;
    } else if (isAnnual) {
      annual = amount;
      hourly = amount / 2_000;
    } else if (amount < 500) {
      hourly = amount;
      annual = amount * 2_000;
    } else {
      annual = amount;
      hourly = amount / 2_000;
    }

    const monthly = annual / 12;
    return { hourly, annual, monthly };
  }

  return null;
}

function extractSalaryPriority(text: string): string | null {
  const amounts = extractSalaryAmounts(text);
  if (!amounts) return null;
  if (amounts.annual >= 80_000 || amounts.hourly >= 40) {
    return `salary $${Math.round(amounts.hourly)}/hr`;
  }
  return null;
}

function isSalaryBelowMinimum(text: string, salary: AppConfig['filters']['salary']): boolean {
  const hasAnySalaryMin = salary.hour !== null || salary.month !== null || salary.annual !== null;
  if (!hasAnySalaryMin) return false;

  const amounts = extractSalaryAmounts(text);
  if (!amounts) return false; // no salary info → don't exclude

  if (salary.hour !== null && amounts.hourly >= salary.hour) return false;
  if (salary.month !== null && amounts.monthly >= salary.month) return false;
  if (salary.annual !== null && amounts.annual >= salary.annual) return false;

  return true; // salary found but below all configured minimums
}

function isPostedWithinWindow(datePosted: string | null, scrapedAt: string, hoursWindow: number): boolean {
  if (!datePosted) return false;
  const posted = new Date(datePosted).getTime();
  const scraped = new Date(scrapedAt).getTime();
  if (isNaN(posted) || isNaN(scraped)) return false;
  const windowMs = (hoursWindow + 1) * 60 * 60 * 1_000;
  return scraped - posted <= windowMs;
}

// ─── Main filter ──────────────────────────────────────────────────────────────

export interface FilterResult {
  filtered: FilteredJob[];
  excluded: ExcludedJob[];
}

export function filterJobs(jobs: RawJob[], config: AppConfig): FilterResult {
  const filtered: FilteredJob[] = [];
  const excluded: ExcludedJob[] = [];
  const excludedAt = new Date().toISOString();

  const hoursWindow = getHoursWindow(config);
  const { filters } = config;

  const skillsRegex = buildSkillsRegex(filters.skills);
  const jobTitleRegex = buildJobTitleRegex(filters.jobTitle);

  const excludedCompaniesLower = filters.excludedCompanies.map((c) => c.toLowerCase());

  for (const job of jobs) {
    const combined = `${job.title} ${job.description}`;
    const locationCombined = `${job.location} ${job.description}`;
    const fullText = `${job.location} ${combined}`;
    const exclusionReasons: string[] = [];

    // ── Pass 1: Hard exclusions ────────────────────────────────────────────
    if (filters.excludeUsOnly && EXCLUDE_US_ONLY.test(combined)) exclusionReasons.push('us-only');
    if (filters.excludeClearance && EXCLUDE_CLEARANCE.test(combined)) exclusionReasons.push('clearance-required');
    if (filters.excludeCLevel && EXCLUDE_C_LEVEL.test(job.title)) exclusionReasons.push('c-level-title');
    if (filters.excludeInternOrJunior && EXCLUDE_INTERN.test(job.title)) exclusionReasons.push('intern-or-junior');
    if (filters.excludeOnSite && EXCLUDE_ON_SITE.test(combined)) exclusionReasons.push('on-site');
    if (filters.excludeHybrid && EXCLUDE_HYBRID.test(combined)) exclusionReasons.push('hybrid');
    if (filters.excludeIndia && EXCLUDE_INDIA.test(fullText)) exclusionReasons.push('india-market');
    if (filters.excludeUae && EXCLUDE_UAE.test(fullText)) exclusionReasons.push('uae-gulf-market');

    if (
      excludedCompaniesLower.length > 0 &&
      excludedCompaniesLower.includes(job.company.toLowerCase())
    ) {
      exclusionReasons.push('excluded-company');
    }

    // ── Pass 2: Required inclusions ────────────────────────────────────────
    const skillsMatch = skillsRegex.test(combined);
    const jobTitleMatch = jobTitleRegex.test(combined);
    if (!skillsMatch && !jobTitleMatch) exclusionReasons.push('no-skills-or-title-match');

    if (filters.remote && !INCLUDE_REMOTE.test(locationCombined)) exclusionReasons.push('not-remote');
    if (!isPostedWithinWindow(job.datePosted, job.scrapedAt, hoursWindow)) exclusionReasons.push('too-old');

    if (filters.contractTypes.length > 0) {
      const hasMatch = filters.contractTypes.some((ct) => CONTRACT_TYPE_PATTERNS[ct].test(combined));
      if (!hasMatch) exclusionReasons.push('no-contract-type');
    }

    if (isSalaryBelowMinimum(combined, filters.salary)) {
      exclusionReasons.push('salary-below-minimum');
    }

    if (exclusionReasons.length > 0) {
      excluded.push({
        title: job.title,
        company: job.company,
        url: job.url,
        source: job.source,
        datePosted: job.datePosted || 'unknown',
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

export function saveRawJobs(filePath: string, jobs: RawJob[]): void {
  const store = { savedAt: new Date().toISOString(), count: jobs.length, jobs };
  writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
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
