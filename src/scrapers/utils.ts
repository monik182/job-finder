import { type Browser, type Page } from 'puppeteer-core';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1366, height: 768 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return page;
}

export function delay(min = 2000, max = 5000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function safeGoto(
  page: Page,
  url: string,
  timeout = 30_000,
): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForNavigation({ timeout: 10_000 });
    return true;
  } catch (err) {
    console.error(`[scraper] Failed to load ${url}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

export function parseRelativeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // ISO date passthrough
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  const now = new Date();

  // "just now" or "today"
  if (/just now|today/i.test(trimmed)) {
    return now.toISOString();
  }

  // "X minutes/hours ago"
  const minutesMatch = trimmed.match(/(\d+)\s+minute/i);
  if (minutesMatch) {
    const mins = parseInt(minutesMatch[1] ?? '0', 10);
    return new Date(now.getTime() - mins * 60_000).toISOString();
  }

  const hoursMatch = trimmed.match(/(\d+)\s+hour/i);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1] ?? '0', 10);
    return new Date(now.getTime() - hours * 3_600_000).toISOString();
  }

  // "X days ago"
  const daysMatch = trimmed.match(/(\d+)\s+day/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1] ?? '0', 10);
    return new Date(now.getTime() - days * 86_400_000).toISOString();
  }

  // "1 week ago"
  const weeksMatch = trimmed.match(/(\d+)\s+week/i);
  if (weeksMatch) {
    const weeks = parseInt(weeksMatch[1] ?? '0', 10);
    return new Date(now.getTime() - weeks * 7 * 86_400_000).toISOString();
  }

  return null;
}
