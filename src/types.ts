export type JobSource = 'linkedin' | 'ycombinator' | 'anywhere-remote' | 'working-nomads';

export interface RawJob {
  title: string;
  company: string;
  location: string;
  datePosted: string | null;
  url: string;
  description: string;
  source: JobSource;
  scrapedAt: string;
}

export interface FilteredJob extends RawJob {
  isHighPriority: boolean;
  priorityReasons: string[];
}

export type AIMatch = 'strong' | 'weak' | 'excluded';

export interface AIClassifiedJob extends FilteredJob {
  aiMatch: AIMatch;
  aiReason: string;
}

export interface SeenJobsStore {
  lastUpdated: string;
  hashes: string[];
}

export interface ExcludedJob {
  title: string;
  company: string;
  url: string;
  source: JobSource;
  datePosted: string;
  excludedAt: string;
  reasons: string[];
}

export interface ExcludedJobsStore {
  lastUpdated: string;
  jobs: ExcludedJob[];
}

export interface InlineFilterStats {
  skippedAsSeen: number;
  skippedByHardExclusion: number;
  excludedJobs: ExcludedJob[];
}

export interface ScrapeResult {
  source: JobSource;
  jobs: RawJob[];
  errors: string[];
  inlineStats: InlineFilterStats;
}

export interface EmailReport {
  totalFound: number;
  totalAfterFilter: number;
  totalNew: number;
  totalStrong: number;
  totalWeak: number;
  strongBySource: Partial<Record<JobSource, AIClassifiedJob[]>>;
  weakBySource: Partial<Record<JobSource, AIClassifiedJob[]>>;
  date: string;
  scraperErrors: string[];
}
