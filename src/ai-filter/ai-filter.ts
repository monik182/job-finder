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

function parseAIResponse(text: string): { match: 'strong' | 'weak'; reason: string } | null {
  const isValidResponse = (parsed: unknown): parsed is { match: 'strong' | 'weak'; reason: string } => {
    if (!parsed || typeof parsed !== 'object') return false;
    const p = parsed as Record<string, unknown>;
    return (p['match'] === 'strong' || p['match'] === 'weak') && typeof p['reason'] === 'string';
  };

  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isValidResponse(parsed)) {
      return { match: parsed.match, reason: parsed.reason };
    }
  } catch {
    // fall through
  }

  // Try regex extraction of JSON block
  const match = /\{[^{}]*"match"\s*:\s*"(strong|weak)"[^{}]*\}/.exec(text);
  if (match?.[0]) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (isValidResponse(parsed)) {
        return { match: parsed.match, reason: parsed.reason };
      }
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
  const desc = job.description.slice(0, 400);

  const prompt = `You are a job relevance classifier. A user is looking for remote ${jobTitles} roles with skills: ${skills}.

Classify this job as "strong" or "weak":
- "strong": the role is primarily a ${jobTitles} position where ${skills} are central to the work
- "weak": the role passed keyword filters but is actually a backend, DevOps, data, QA, or other role where the target skills appear only incidentally

Title: ${job.title}
Company: ${job.company}
Description: ${desc}

Respond with JSON only: {"match": "strong" | "weak", "reason": "<one sentence>"}`;

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
      console.log(`[ai-filter] ${index}/${total} "${job.title} @ ${job.company}" → ${parsed.match}`);
      return { ...job, aiMatch: parsed.match, aiReason: parsed.reason };
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
  console.log(`[ai-filter] Done: ${strong} strong, ${weak} weak`);

  return results;
}
