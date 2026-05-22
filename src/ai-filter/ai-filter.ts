import Anthropic from '@anthropic-ai/sdk';
import { type AIClassifiedJob, type FilteredJob } from '../types.js';
import { type AppConfig } from '../config.js';

async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length) as T[];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      const task = tasks[i];
      if (task) {
        results[i] = await task();
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

interface AIResponse {
  match: 'strong' | 'weak' | 'excluded';
  reason: string;
  isRecruiter?: boolean;
}

function parseAIResponse(text: string): AIResponse | null {
  const isValidResponse = (parsed: unknown): parsed is AIResponse => {
    if (!parsed || typeof parsed !== 'object') return false;
    const p = parsed as Record<string, unknown>;
    return (
      (p['match'] === 'strong' || p['match'] === 'weak' || p['match'] === 'excluded') &&
      typeof p['reason'] === 'string'
    );
  };

  const extractResponse = (raw: unknown): AIResponse | null => {
    const p = raw as Record<string, unknown>;
    if (!isValidResponse(raw)) return null;
    return { match: raw.match, reason: raw.reason, isRecruiter: p['isRecruiter'] === true ? true : undefined };
  };

  // Try direct JSON parse first
  try {
    const result = extractResponse(JSON.parse(text) as unknown);
    if (result) return result;
  } catch {
    // fall through
  }

  // Try regex extraction of JSON block
  const match = /\{[^{}]*"match"\s*:\s*"(strong|weak|excluded)"[^{}]*\}/.exec(text);
  if (match?.[0]) {
    try {
      const result = extractResponse(JSON.parse(match[0]) as unknown);
      if (result) return result;
    } catch {
      // fall through
    }
  }

  return null;
}

async function classifyJob(
  job: FilteredJob,
  config: AppConfig,
  client: Anthropic,
  index: number,
  total: number,
): Promise<AIClassifiedJob> {
  const skills = config.filters.skills.join(', ');
  const jobTitles = config.filters.jobTitle.join(', ');
  const allowedLanguages = config.filters.language.join(', ');
  const desc = job.description.slice(0, 400);

  const isReposted = job.isReposted ? '\nReposted: yes' : '';

  const prompt = `You are a job relevance classifier. Evaluate this job listing on the following criteria.

CRITERIA 1 — Language:
Allowed languages: ${allowedLanguages}
- If the job post itself is written in a language other than [${allowedLanguages}], classify as "excluded".
- If the job post requires the candidate to speak a language other than [${allowedLanguages}] (even if the post is in English), classify as "excluded".
- A job that requires English OR Spanish (or both) is acceptable.

CRITERIA 2 — Reposted jobs:
- If the job is marked as reposted, classify as "excluded" with reason "reposted job listing".

CRITERIA 3 — Role relevance (only apply if not excluded by criteria 1 or 2):
The user is looking for remote ${jobTitles} roles using: ${skills}.
- "strong": the role is primarily a ${jobTitles} position where ${skills} are central to the work.
- "weak": the role passed keyword filters but is actually a backend, DevOps, data, QA, or other role where the target skills appear only incidentally.

CRITERIA 4 — Recruiting company detection:
Determine if the company posting the job is a recruiting/staffing agency rather than the actual employer. Signs include: the company name contains words like "staffing", "recruiting", "talent", "placement", "consultancy"; the description mentions placing candidates at client companies; the job is generic/templated. Set "isRecruiter" to true if so.

Title: ${job.title}
Company: ${job.company}${isReposted}
Description: ${desc}

Respond with JSON only: {"match": "strong" | "weak" | "excluded", "reason": "<one sentence>", "isRecruiter": true | false}`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });

    const contentBlock = message.content[0];
    const text = contentBlock?.type === 'text' ? contentBlock.text : '';
    const parsed = parseAIResponse(text);

    if (parsed) {
      console.log(`[ai-filter] ${index}/${total} "${job.title} @ ${job.company}" → ${parsed.match}${parsed.isRecruiter ? ' [recruiter]' : ''}`);
      return { ...job, aiMatch: parsed.match, aiReason: parsed.reason, isRecruiter: parsed.isRecruiter || undefined };
    }

    console.warn(`[ai-filter] ${index}/${total} "${job.title}" — could not parse response, defaulting to strong`);
    return { ...job, aiMatch: 'strong', aiReason: 'AI classification unavailable' };
  } catch (err) {
    console.warn(`[ai-filter] ${index}/${total} "${job.title}" — API error, defaulting to strong:`, err);
    return { ...job, aiMatch: 'strong', aiReason: 'AI classification unavailable' };
  }
}

export async function classifyJobs(
  jobs: FilteredJob[],
  config: AppConfig,
): Promise<AIClassifiedJob[]> {
  if (!process.env['ANTHROPIC_API_KEY']?.trim()) {
    console.log('[ai-filter] ANTHROPIC_API_KEY not set — skipping AI classification (all jobs default to strong)');
    return jobs.map((job) => ({ ...job, aiMatch: 'strong' as const, aiReason: 'AI filter not configured' }));
  }

  if (jobs.length === 0) {
    return [];
  }

  console.log(`[ai-filter] Classifying ${jobs.length} jobs with Claude Haiku...`);
  const client = new Anthropic();

  const tasks = jobs.map((job, i) => () => classifyJob(job, config, client, i + 1, jobs.length));
  const results = await withConcurrencyLimit(tasks, 5);

  const strong = results.filter((j) => j.aiMatch === 'strong').length;
  const weak = results.filter((j) => j.aiMatch === 'weak').length;
  const excluded = results.filter((j) => j.aiMatch === 'excluded').length;
  console.log(`[ai-filter] Done: ${strong} strong, ${weak} weak, ${excluded} excluded (language)`);

  return results;
}
