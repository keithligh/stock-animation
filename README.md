# Stock animation

Play five years of a share price, then download a 1920×1080 MP4 encoded in the browser.

Enter a ticker such as `NVDA`, `AAPL`, or `0700.HK`. The page loads the last completed session and plays a 30-second, 60 fps film. When the film finishes, Download MP4 encodes the frames on your machine. The video is not uploaded.

## Features

- US and Hong Kong tickers, including share classes such as `BRK.B`
- Opens on the first close and ends on the latest close
- Replay, then download after that play finishes
- Shared edge cache so visitors do not each call Yahoo

## How it works

The page requests `GET /v1/chart/:symbol?d=YYYY-MM-DD` on the same origin. A Cloudflare Worker checks that `d` is the last completed session, plus or minus one calendar day, and maps the ticker onto Yahoo Finance.

Chart JSON is cached on Cloudflare's edge so every visitor shares the same Yahoo pool; Yahoo is only called on miss. Workers Cache sits in front of the Worker, and the cache key includes `d`. The Worker also stores one [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) entry per Yahoo symbol and session date, with `Cache-Control: public, max-age=...` set by `cacheMaxAgeSeconds` (until the next local 16:00 close, plus 30 minutes). A hit returns the stored JSON and does not call Yahoo. A miss fetches once and writes the cache.

The browser draws the film on a 1920×1080 canvas and encodes the MP4 locally with [mediabunny](https://github.com/Vanilagy/mediabunny).

Same-origin requests are allowed. Other origins must be listed in `ALLOWED_ORIGIN`.

## Quick start

```bash
npm install
npm test
npm run dev
```

The site listens on port 5173. Vite proxies `/v1` to the Worker on port 8787.

## Deploy

```bash
npx wrangler deploy
```

Run that from the repo root. It builds the static app and deploys one Worker, which serves both the site and the Yahoo relay. Add any extra browser origins to `ALLOWED_ORIGIN` in `wrangler.toml`.

## Stack

- TypeScript, Vite, and a canvas renderer
- [mediabunny](https://github.com/Vanilagy/mediabunny) for in-browser MP4 encoding
- Cloudflare Workers for the site, the relay, and the shared edge cache

## License

[MIT](LICENSE) © 2026 Keith Li

Created by [Keith Li](https://www.linkedin.com/in/keithlihk). Source: [github.com/keithligh/stock-animation](https://github.com/keithligh/stock-animation).
