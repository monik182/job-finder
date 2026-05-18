export type JobSource = 'linkedin' | 'ycombinator' | 'anywhere-remote';

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

export interface SeenJobsStore {
  lastUpdated: string;
  hashes: string[];
}

export interface ScrapeResult {
  source: JobSource;
  jobs: RawJob[];
  errors: string[];
}

export interface EmailReport {
  totalFound: number;
  totalAfterFilter: number;
  totalNew: number;
  jobsBySource: Partial<Record<JobSource, FilteredJob[]>>;
  date: string;
  scraperErrors: string[];
}
