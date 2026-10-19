# Stock animation

Enter a ticker. The page plays what $10,000 became over five years of daily closes, then downloads an MP4 encoded in the browser (1920×1080, 60 fps, 15 seconds).

```bash
npm install
npm test
npm run dev    # site on :5173, Yahoo relay on :8787
npm run build
```

Yahoo sends no CORS header, so the page reads `GET /v1/chart/:sym?d=YYYY-MM-DD` from the worker in `workers/api`. Deploy that worker with `npx wrangler deploy -c workers/api/wrangler.toml`. The site is the static `dist/` from `npm run build`.
