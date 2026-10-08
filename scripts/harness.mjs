// Arranca Vite (o usa ZIPA_URL) y abre Chrome con WebGPU vía Playwright.
import { createServer } from 'vite';
import { chromium } from 'playwright';

export async function startGame({ width = 1600, height = 900 } = {}) {
  let server = null;
  let base = process.env.ZIPA_URL;
  if (!base) {
    server = await createServer({ server: { port: 5174, strictPort: false }, logLevel: 'error' });
    await server.listen();
    base = server.resolvedUrls.local[0];
  }
  const browser = await chromium.launch({
    channel: process.env.ZIPA_BROWSER ?? 'chrome',
    headless: process.env.HEADED ? false : true,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return {
    base, page, errors,
    async open(query = '') {
      await page.goto(base + query + (process.env.WEBGL ? (query ? '&' : '?') + 'webgl' : ''));
      await page.waitForFunction(() => window.__zipa?.ready === true, null, { timeout: 120_000 });
    },
    state: () => page.evaluate(() => {
      const z = window.__zipa;
      return Object.fromEntries(Object.entries(z).filter(([, v]) => typeof v !== 'function'));
    }),
    async close() {
      await browser.close();
      if (server) await server.close();
    },
  };
}
