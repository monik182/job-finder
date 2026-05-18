import puppeteer, { type Browser } from 'puppeteer-core';

function getBrowserlessEndpoint(): string {
  const key = process.env['BROWSERLESS_API_KEY'];
  if (!key) throw new Error('BROWSERLESS_API_KEY environment variable is not set');
  return `wss://production-sfo.browserless.io?token=${key}&stealth=true&timeout=60000`;
}

async function connectOnce(): Promise<Browser> {
  const endpoint = getBrowserlessEndpoint();
  return puppeteer.connect({ browserWSEndpoint: endpoint });
}

export async function getBrowser(): Promise<Browser> {
  try {
    return await connectOnce();
  } catch (firstError) {
    console.error('[browser] Initial connection failed, retrying in 10s...', firstError);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return connectOnce();
  }
}

export async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await browser.disconnect();
  } catch {
    // ignore disconnect errors
  }
}
