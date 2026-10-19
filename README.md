# Stock animation

Enter a ticker. The page plays five years of that stock's share price, then downloads an MP4 encoded in the browser (1920×1080, 60 fps, 30 seconds).

```bash
npm install
npm test
npm run dev    # site on :5173; the page calls the same-origin /v1 relay
npx wrangler deploy
```

`npx wrangler deploy` from the repo root builds the site and deploys one Cloudflare Worker. That Worker serves the static app and the Yahoo relay at `GET /v1/chart/:symbol?d=YYYY-MM-DD`. The page fetches that path on the same origin. During `npm run dev`, Vite proxies `/v1` to the Worker on port 8787.
