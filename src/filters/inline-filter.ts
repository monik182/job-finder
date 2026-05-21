import { type RawJob, type ExcludedJob, type InlineFilterStats } from '../types.js';
import { type AppConfig } from '../config.js';
import { hashJob } from '../dedup/dedup.js';
import { buildHardExclusionContext, getHardExclusionReasons, type HardExclusionContext } from './filter-jobs.js';

export interface InlineJobFilter {
  /** Check one job. Returns the job if kept, null if excluded/seen. */
  check(job: RawJob): RawJob | null;

  /** Check a batch of jobs. Returns only the kept ones. */
  checkBatch(jobs: RawJob[]): RawJob[];

  /** Count of jobs that passed inline checks (across all calls). */
  readonly keptCount: number;

  /** Accumulated inline filter stats. */
  readonly stats: InlineFilterStats;
}

export function createInlineFilter(
  config: AppConfig,
  persistedHashes: Set<string>,
): InlineJobFilter {
  const ctx: HardExclusionContext = buildHardExclusionContext(config);
  const runSeenHashes = new Set<string>();
  // Catches same job across different searches/URLs (e.g. reposted with new URL)
  const seenTitleCompany = new Set<string>();

  let keptCount = 0;
  const stats: InlineFilterStats = {
    skippedAsSeen: 0,
    skippedByHardExclusion: 0,
    excludedJobs: [],
  };

  function check(job: RawJob): RawJob | null {
    const hash = hashJob(job);

    if (persistedHashes.has(hash) || runSeenHashes.has(hash)) {
      stats.skippedAsSeen++;
      return null;
    }

    const titleCompanyKey = `${job.company.toLowerCase().trim()}|${job.title.toLowerCase().trim()}`;
    if (seenTitleCompany.has(titleCompanyKey)) {
      stats.skippedAsSeen++;
      return null;
    }

    const reasons = getHardExclusionReasons(job, config, ctx);
    if (reasons.length > 0) {
      stats.skippedByHardExclusion++;
      stats.excludedJobs.push({
        title: job.title,
        company: job.company,
        url: job.url,
        source: job.source,
        datePosted: job.datePosted || 'unknown',
        excludedAt: new Date().toISOString(),
        reasons,
      });
      return null;
    }

    runSeenHashes.add(hash);
    seenTitleCompany.add(titleCompanyKey);
    keptCount++;
    return job;
  }

  function checkBatch(jobs: RawJob[]): RawJob[] {
    const kept: RawJob[] = [];
    for (const job of jobs) {
      const result = check(job);
      if (result) kept.push(result);
    }
    return kept;
  }

  return {
    check,
    checkBatch,
    get keptCount() { return keptCount; },
    get stats() { return stats; },
  };
}
