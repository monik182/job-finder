import puppeteer, { type Browser } from 'puppeteer-core';

// macOS path to Chrome — adjust if Chrome is installed elsewhere
const LOCAL_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function isHeaded(): boolean {
  return process.env['HEADED'] === 'true';
}

async function launchLocal(): Promise<Browser> {
  return puppeteer.launch({
    headless: false,
    executablePath: LOCAL_CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    slowMo: 30, // slight slow-motion so actions are visible
  });
}

function getBrowserlessEndpoint(): string {
  const key = process.env['BROWSERLESS_API_KEY'];
  if (!key) throw new Error('BROWSERLESS_API_KEY environment variable is not set');
  return `wss://production-sfo.browserless.io?token=${key}&stealth=true&timeout=60000`;
}

async function connectOnce(): Promise<Browser> {
  return puppeteer.connect({ browserWSEndpoint: getBrowserlessEndpoint() });
}

export async function getBrowser(): Promise<Browser> {
  if (isHeaded()) {
    console.log('[browser] Launching local headed Chrome…');
    return launchLocal();
  }

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
    if (isHeaded()) {
      await browser.close();
    } else {
      await browser.disconnect();
    }
  } catch {
    // ignore
  }
}
