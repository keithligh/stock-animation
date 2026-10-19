import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const mode = process.argv[2] ?? 'frames';
const ticker = process.argv[3] ?? 'NVDA';
const outDir = path.resolve(process.argv[4] ?? '/tmp/stock-frames');
await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ??
    ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome'].find((candidate) => existsSync(candidate)),
  headless: true,
  downloadBehavior: { policy: 'allow', downloadPath: outDir },
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1440,1000',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
  ],
});
const page = await browser.newPage();
const client = await page.createCDPSession();
await client.send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: outDir,
  eventsEnabled: true,
});
client.on('Browser.downloadWillBegin', (event) => {
  console.log('download begin', event.suggestedFilename, event.url?.slice(0, 32));
});
client.on('Browser.downloadProgress', (event) => {
  if (event.state !== 'inProgress') console.log('download', event.state, event.receivedBytes);
});
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
page.setDefaultTimeout(540_000);
const base = process.env.CAPTURE_BASE ?? 'http://127.0.0.1:5173/';

try {
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  if (ticker === 'NVDA') {
    await page.screenshot({ path: path.join(outDir, 'empty-page.png') });
  }
  await page.$eval('#ticker', (input, value) => {
    input.value = value;
  }, ticker);
  await page.click('#play');
  await page.waitForFunction(
    () => document.body.dataset.state === 'ready' || document.body.dataset.state === 'error',
  );
  const state = await page.$eval('body', (body) => body.dataset.state ?? '');
  const status = await page.$eval('#status', (node) => node.textContent ?? '');
  if (state !== 'ready') throw new Error(`Load failed: ${status}`);

  const frameCount = await page.evaluate(() => window.__anim?.frameCount ?? 0);
  const hookFrame = await page.evaluate(() => window.__anim?.hookFrame ?? 72);
  const calloutFrame = await page.evaluate(() => window.__anim?.calloutFrame ?? 0);
  const points = [
    ['hook', hookFrame],
    ['callout', calloutFrame],
    ['middle', Math.floor(frameCount / 2)],
    ['end', frameCount - 1],
  ];
  for (const [name, frame] of points) {
    await page.evaluate((index) => window.__anim?.seek(index), frame);
    await saveCanvas(page, path.join(outDir, `${ticker}-${name}.png`));
  }
  await page.evaluate(() => window.__anim?.finish());
  await page.screenshot({ path: path.join(outDir, `${ticker}-page.png`) });
  if (ticker === 'NVDA') {
    for (const width of [1280, 1920]) {
      await page.setViewport({ width, height: width === 1920 ? 1080 : 860, deviceScaleFactor: 1 });
      await page.screenshot({ path: path.join(outDir, `${ticker}-page-${width}.png`) });
    }
  }
  console.log('frames', status);

  if (mode === 'mp4') {
    const support = await page.evaluate(async () => {
      if (typeof VideoEncoder === 'undefined') return 'missing';
      const configs = [
        ['avc1.64002A', 60],
        ['avc1.640028', 30],
        ['vp09.00.10.08', 60],
      ];
      const results = [];
      for (const [codec, framerate] of configs) {
        const result = await VideoEncoder.isConfigSupported({
          codec,
          width: 1920,
          height: 1080,
          bitrate: 5_000_000,
          framerate,
        }).catch(() => ({ supported: false }));
        results.push(`${codec}:${result.supported === true}`);
      }
      return results.join(' ');
    });
    console.log('encoders', support);

    const before = new Set(await readdir(outDir));
    await page.click('#download');
    const saved = await waitForExport(page, outDir, before, status);
    console.log('export', saved);
  }
} finally {
  await browser.close();
}

async function saveCanvas(page, file) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector('#stage');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing canvas');
    return canvas.toDataURL('image/png');
  });
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(file, Buffer.from(encoded, 'base64'));
}

async function waitForExport(page, directory, before, readyStatus) {
  const deadline = Date.now() + 540_000;
  let last = '';
  let stuck = 0;
  while (Date.now() < deadline) {
    const status = await page.$eval('#status', (node) => node.textContent ?? '');
    if (status !== last) {
      console.log('status', status);
      last = status;
      stuck = 0;
    } else {
      stuck += 1;
    }
    const file = await findNewMedia(directory, before);
    if (status.startsWith('Saved ')) {
      const named = path.join(directory, status.slice('Saved '.length).trim());
      const ready = await stableMedia(file ?? named);
      if (ready) return `${status} -> ${ready}`;
    }
    const encoding = status.startsWith('Encoding') || status.startsWith('Loading') || status === readyStatus;
    if (!encoding && stuck > 6) throw new Error(status || 'export failed');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`export timed out at: ${last}`);
}

async function stableMedia(file) {
  let previous = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const info = await stat(file).catch(() => null);
    if (info && info.size > 100_000 && info.size === previous) return file;
    previous = info?.size ?? -1;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function findNewMedia(directory, before) {
  const names = await readdir(directory);
  const created = names.filter(
    (name) => !before.has(name) && (name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.crdownload')),
  );
  const ready = created.find((name) => name.endsWith('.mp4') || name.endsWith('.webm'));
  return ready ? path.join(directory, ready) : null;
}
