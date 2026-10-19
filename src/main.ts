import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-500.css';
import { parseYahooChart } from '../shared/parse';
import { lastCompletedSession } from '../shared/session';
import { canonicalizeTicker, mapRelaySymbol } from '../shared/symbols';
import { exportAnimation } from './export';
import { buildAnimation, drawFrame, FRAME_COUNT, type Animation } from './render';

const form = document.querySelector<HTMLFormElement>('#form');
const tickerInput = document.querySelector<HTMLInputElement>('#ticker');
const playButton = document.querySelector<HTMLButtonElement>('#play');
const downloadButton = document.querySelector<HTMLButtonElement>('#download');
const statusLine = document.querySelector<HTMLParagraphElement>('#status');
const canvas = document.querySelector<HTMLCanvasElement>('#stage');

if (!form || !tickerInput || !playButton || !downloadButton || !statusLine || !canvas) {
  throw new Error('Page is missing its controls');
}

const ctx = canvas.getContext('2d', { alpha: false });
if (!ctx) throw new Error('Canvas is unavailable');

const stage: HTMLCanvasElement = canvas;
const context: CanvasRenderingContext2D = ctx;
const saveButton: HTMLButtonElement = downloadButton;
const status: HTMLParagraphElement = statusLine;

let animation: Animation | null = null;
let playing = false;
let clockStart = 0;
let exportAbort: AbortController | null = null;
let loadAbort: AbortController | null = null;

void document.fonts.ready.then(() => {
  drawIdle();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void loadTicker(tickerInput.value);
});

downloadButton.addEventListener('click', () => {
  if (exportAbort) {
    exportAbort.abort();
    return;
  }
  if (animation) void download(animation);
});

window.__anim = {
  get frameCount() {
    return FRAME_COUNT;
  },
  seek(frame: number) {
    if (!animation) return;
    playing = false;
    drawFrame(context, animation, frame);
  },
};

function drawIdle(): void {
  context.setTransform(stage.width / 1920, 0, 0, stage.height / 1080, 0, 0);
  context.fillStyle = '#07080b';
  context.fillRect(0, 0, 1920, 1080);
  context.fillStyle = '#9aa3b5';
  context.font = '500 28px Geist, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText('Enter a ticker to play its price.', 88, 540);
  context.setTransform(1, 0, 0, 1, 0, 0);
}

async function loadTicker(raw: string): Promise<void> {
  const display = canonicalizeTicker(raw);
  const mapped = display ? mapRelaySymbol(display) : null;
  if (!display || !mapped) {
    setStatus('Use a ticker like 0700.HK or NVDA.');
    document.body.dataset.state = 'error';
    return;
  }
  loadAbort?.abort();
  const abort = new AbortController();
  loadAbort = abort;
  playing = false;
  animation = null;
  saveButton.disabled = true;
  document.body.dataset.state = 'loading';
  setStatus(`Loading ${display}…`);
  try {
    const session = lastCompletedSession(mapped.market, new Date());
    const payload = await fetchChart(display, session, abort.signal);
    const series = parseYahooChart(payload, session);
    const next = buildAnimation({
      displaySymbol: series.displaySymbol,
      name: series.name,
      currency: series.currency,
      bars: series.bars,
    });
    if (abort.signal.aborted) return;
    animation = next;
    saveButton.disabled = false;
    document.body.dataset.state = 'ready';
    setStatus(`${labelFor(next.symbol)} · ${next.name} · ${next.prices.length.toLocaleString('en-US')} sessions`);
    startPlayback();
  } catch (error) {
    if (abort.signal.aborted) return;
    document.body.dataset.state = 'error';
    setStatus(error instanceof Error ? error.message : 'Could not load that ticker.');
  }
}

async function fetchChart(symbol: string, session: string, signal: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort);
  try {
    const response = await fetch(`/v1/chart/${encodeURIComponent(symbol)}?d=${session}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ? `Relay: ${body.error}` : `Relay returned ${response.status}`);
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(signal.aborted ? 'Cancelled' : 'The data relay timed out.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

function startPlayback(): void {
  playing = true;
  clockStart = performance.now();
  requestAnimationFrame(tick);
}

function tick(now: number): void {
  if (!playing || !animation) return;
  const frame = Math.min(FRAME_COUNT - 1, Math.floor(((now - clockStart) / 1000) * 60));
  drawFrame(context, animation, frame);
  if (frame >= FRAME_COUNT - 1) {
    playing = false;
    return;
  }
  requestAnimationFrame(tick);
}

async function download(current: Animation): Promise<void> {
  const abort = new AbortController();
  exportAbort = abort;
  saveButton.textContent = 'Cancel';
  playing = false;
  try {
    const result = await exportAnimation(current, (frame, total) => {
      setStatus(`Encoding ${frame.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`);
    }, abort.signal);
    const name = `${labelFor(current.symbol).replace(/\./g, '-')}-price.${result.extension}`;
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus(`Saved ${name}`);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      setStatus('Export cancelled.');
    } else {
      setStatus(error instanceof Error ? error.message : 'Export failed.');
    }
  } finally {
    exportAbort = null;
    saveButton.textContent = 'Download MP4';
  }
}

function setStatus(text: string): void {
  status.textContent = text;
}

function labelFor(symbol: string): string {
  return symbol.endsWith('.US') ? symbol.slice(0, -3) : symbol;
}

declare global {
  interface Window {
    __anim?: {
      readonly frameCount: number;
      seek(frame: number): void;
    };
  }
}
