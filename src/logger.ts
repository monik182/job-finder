import { appendFileSync } from 'node:fs';
import { type JobSource, type ExcludedJob, type ScrapeResult } from './types.js';

export interface RunLogEntry {
  startedAt: string;
  finishedAt: string;
  seenJobsTotal: number;
  rawJobsFound: number;
  newJobsFound: number;
  excludedJobs: {
    bySource: Partial<Record<JobSource, number>>;
    total: number;
  };
  errors: {
    bySource: Partial<Record<JobSource, string[]>>;
    global: string[];
  };
}

export function buildRunLog(params: {
  startedAt: string;
  finishedAt: string;
  seenJobsTotal: number;
  rawJobsFound: number;
  newJobsFound: number;
  excludedJobs: ExcludedJob[];
  results: ScrapeResult[];
  globalErrors: string[];
}): RunLogEntry {
  const excludedBySource: Partial<Record<JobSource, number>> = {};
  for (const job of params.excludedJobs) {
    excludedBySource[job.source] = (excludedBySource[job.source] ?? 0) + 1;
  }

  const errorsBySource: Partial<Record<JobSource, string[]>> = {};
  for (const result of params.results) {
    if (result.errors.length > 0) {
      errorsBySource[result.source] = result.errors;
    }
  }

  return {
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    seenJobsTotal: params.seenJobsTotal,
    rawJobsFound: params.rawJobsFound,
    newJobsFound: params.newJobsFound,
    excludedJobs: {
      bySource: excludedBySource,
      total: params.excludedJobs.length,
    },
    errors: {
      bySource: errorsBySource,
      global: params.globalErrors,
    },
  };
}

export function appendRunLog(filePath: string, entry: RunLogEntry): void {
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}
