import { Resend } from 'resend';
import { type AIClassifiedJob, type EmailReport, type JobSource } from '../types.js';

const SOURCE_LABELS: Record<JobSource, string> = {
  linkedin: 'LinkedIn',
  ycombinator: 'Work at a Startup (YC)',
  'anywhere-remote': 'Anywhere Remote Jobs',
  'working-nomads': 'Working Nomads',
};

function formatDate(iso: string | null): string {
  if (!iso) return 'Unknown date';
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function jobCard(job: AIClassifiedJob, showAiReason = false): string {
  const priorityStyle = job.isHighPriority
    ? 'border-left: 4px solid #f59e0b; background: #fffbeb;'
    : 'border-left: 4px solid #e2e8f0;';

  const priorityBadges = job.priorityReasons
    .map(
      (r) =>
        `<span style="display:inline-block;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:12px;font-size:12px;margin-right:4px;">⭐ ${r}</span>`,
    )
    .join('');

  const descTrimmed = job.description
    ? job.description.split(/\s+/).slice(0, 100).join(' ') + (job.description.split(/\s+/).length > 100 ? '…' : '')
    : '';
  const descHtml = descTrimmed
    ? `<p style="margin:6px 0 0;color:#64748b;font-size:13px;line-height:1.5;">${escapeHtml(descTrimmed)}</p>`
    : '';

  const aiReasonHtml =
    showAiReason && job.aiReason
      ? `<p style="margin:4px 0 0;font-size:11px;color:#9ca3af;font-style:italic;">AI note: ${escapeHtml(job.aiReason)}</p>`
      : '';

  return `
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:8px 0;${priorityStyle}">
      ${job.isHighPriority ? '<div style="font-size:11px;color:#92400e;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">⭐ High Priority</div>' : ''}
      <h3 style="margin:0 0 4px;font-size:16px;font-weight:600;">
        <a href="${job.url}" style="color:#1d4ed8;text-decoration:none;">${escapeHtml(job.title)}</a>
      </h3>
      <p style="margin:0;color:#374151;font-size:14px;">
        <strong>${escapeHtml(job.company)}</strong>
        ${job.location ? ` · <span style="color:#6b7280;">${escapeHtml(job.location)}</span>` : ''}
        ${job.datePosted ? ` · <span style="color:#9ca3af;font-size:12px;">${formatDate(job.datePosted)}</span>` : ''}
      </p>
      ${descHtml}
      ${aiReasonHtml}
      ${priorityBadges ? `<div style="margin-top:8px;">${priorityBadges}</div>` : ''}
    </div>`;
}

function sourceSection(source: JobSource, jobs: AIClassifiedJob[], showAiReason = false): string {
  if (jobs.length === 0) return '';
  const label = SOURCE_LABELS[source];
  const cards = jobs.map((j) => jobCard(j, showAiReason)).join('');
  return `
    <div style="margin-top:24px;">
      <h2 style="font-size:18px;font-weight:700;color:#111827;border-bottom:2px solid #e2e8f0;padding-bottom:8px;margin-bottom:0;">
        ${label} <span style="font-weight:400;color:#6b7280;font-size:14px;">(${jobs.length} job${jobs.length !== 1 ? 's' : ''})</span>
      </h2>
      ${cards}
    </div>`;
}

function weakSection(jobsBySource: Partial<Record<JobSource, AIClassifiedJob[]>>): string {
  const sourceOrder: JobSource[] = ['linkedin', 'ycombinator', 'anywhere-remote', 'working-nomads'];
  const sections = sourceOrder.map((s) => sourceSection(s, jobsBySource[s] ?? [], true)).join('');
  if (!sections.trim()) return '';
  return `
    <div style="margin-top:32px;border-top:2px dashed #e2e8f0;padding-top:16px;">
      <h2 style="font-size:16px;font-weight:600;color:#6b7280;margin:0 0 4px;">
        Other Matches
        <span style="font-weight:400;font-size:13px;"> — passed filters, lower AI confidence</span>
      </h2>
      ${sections}
    </div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtmlEmail(report: EmailReport): string {
  const sourceOrder: JobSource[] = ['linkedin', 'ycombinator', 'anywhere-remote', 'working-nomads'];
  const strongSections = sourceOrder
    .map((s) => sourceSection(s, report.strongBySource[s] ?? []))
    .join('');

  const errorSection =
    report.scraperErrors.length > 0
      ? `<div style="margin-top:24px;padding:12px;background:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
          <strong style="color:#dc2626;">⚠️ Scraper Warnings:</strong>
          <ul style="margin:8px 0 0;padding-left:20px;font-size:13px;color:#7f1d1d;">
            ${report.scraperErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}
          </ul>
        </div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f8fafc;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;">

    <!-- Header -->
    <div style="background:#1e293b;color:#ffffff;padding:24px 32px;">
      <h1 style="margin:0;font-size:22px;font-weight:700;">🔍 Job Search Results</h1>
      <p style="margin:4px 0 0;color:#94a3b8;font-size:14px;">${report.date}</p>
    </div>

    <!-- Summary bar -->
    <div style="background:#f0f9ff;border-bottom:1px solid #bae6fd;padding:12px 32px;display:flex;gap:24px;flex-wrap:wrap;">
      <span style="font-size:13px;color:#0369a1;">Found: <strong>${report.totalFound}</strong></span>
      <span style="margin-left: 10px"> | </span>
      <span style="font-size:13px;color:#0369a1;">After filters: <strong>${report.totalAfterFilter}</strong></span>
      <span style="margin-left: 10px"> | </span>
      <span style="font-size:13px;color:#0369a1;font-weight:700;">Strong: <strong style="color:#0284c7;">${report.totalStrong}</strong></span>
      <span style="margin-left: 10px"> | </span>
      <span style="font-size:13px;color:#6b7280;">Other: <strong>${report.totalWeak}</strong></span>
    </div>

    <!-- Job sections -->
    <div style="padding:16px 32px 32px;">
      ${strongSections}
      ${weakSection(report.weakBySource)}
      ${errorSection}
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;color:#9ca3af;font-size:12px;">
      <p style="margin:0;">Scraped ${report.totalFound} jobs · ${report.totalAfterFilter} passed filters · ${report.totalStrong} strong · ${report.totalWeak} other</p>
      <p style="margin:4px 0 0;">Sources: LinkedIn · Work at a Startup (YC) · Anywhere Remote Jobs · Working Nomads</p>
    </div>

  </div>
</body>
</html>`;
}

function buildNoJobsEmail(date: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,Arial,sans-serif;max-width:600px;margin:40px auto;padding:0 24px;color:#374151;">
  <h1 style="color:#1e293b;">🔍 Job Search Results — ${date}</h1>
  <p style="font-size:18px;">No new jobs today. Keep going 💪</p>
  <p style="color:#9ca3af;font-size:13px;">All scraped jobs were either filtered out or already seen. The script ran successfully.</p>
</body>
</html>`;
}

export async function sendEmail(report: EmailReport): Promise<void> {
  const apiKey = process.env['RESEND_API_KEY'];
  const to = process.env['MY_EMAIL'];
  const from = process.env['FROM_EMAIL'];

  if (!apiKey || !to || !from) {
    throw new Error('Missing email env vars: RESEND_API_KEY, MY_EMAIL, FROM_EMAIL');
  }

  const resend = new Resend(apiKey);

  const sourceLabel = report.source ? SOURCE_LABELS[report.source] : 'All Sources';
  const subject =
    report.totalNew > 0
      ? `🔍 [${sourceLabel}] Job Search Results - ${report.date} - ${report.totalStrong} strong, ${report.totalWeak} other`
      : `[${sourceLabel}] No new jobs today. Keep going 💪`;

  const html =
    report.totalNew > 0 ? buildHtmlEmail(report) : buildNoJobsEmail(report.date);

  const { error } = await resend.emails.send({ from, to, subject, html });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`[email] Sent: "${subject}"`);
}
