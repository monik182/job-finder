import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { type RawJob, type FilteredJob, type SeenJobsStore } from '../types.js';

export function hashJob(job: RawJob): string {
  const key = [
    job.company.toLowerCase().trim(),
    job.title.toLowerCase().trim(),
    job.url,
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}

export function loadSeenJobs(filePath: string): SeenJobsStore {
  if (!existsSync(filePath)) {
    return { lastUpdated: new Date().toISOString(), hashes: [] };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'hashes' in parsed &&
      Array.isArray((parsed as Record<string, unknown>)['hashes'])
    ) {
      return parsed as SeenJobsStore;
    }
    return { lastUpdated: new Date().toISOString(), hashes: [] };
  } catch {
    return { lastUpdated: new Date().toISOString(), hashes: [] };
  }
}

export function saveSeenJobs(filePath: string, store: SeenJobsStore): void {
  writeFileSync(filePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

export function deduplicateJobs(
  jobs: FilteredJob[],
  store: SeenJobsStore,
): { newJobs: FilteredJob[]; updatedStore: SeenJobsStore } {
  const existingSet = new Set(store.hashes);
  const newJobs: FilteredJob[] = [];
  const newHashes: string[] = [];

  for (const job of jobs) {
    const hash = hashJob(job);
    if (!existingSet.has(hash)) {
      existingSet.add(hash);
      newJobs.push(job);
      newHashes.push(hash);
    }
  }

  const updatedStore: SeenJobsStore = {
    lastUpdated: new Date().toISOString(),
    hashes: [...store.hashes, ...newHashes],
  };

  return { newJobs, updatedStore };
}
