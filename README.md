# Pulse – Universal Content Aggregator
Requires Node 18+.
```
npm install
npm start        # http://localhost:3000
```
The console prints an **admin token**; paste it into Dashboard. Set `ADMIN_TOKEN=yourtoken` to keep it stable.
Env: `PORT`, `DB_PATH` (default data.db), `SYNC_MINUTES` (30), `BATCH` (200 sitemap pages per pass), `CORS_ORIGIN`.

How it works: homepage `<link rel=alternate>` feeds, common feed paths (with `?paged=N` history), robots.txt + default sitemaps (nested, newest first). Sitemap pages are scraped via OpenGraph/JSON-LD, `BATCH` at a time; sync re-queues itself until the backlog is done. robots.txt is honored. By default only excerpts (≤500 chars) are stored; tick "Full text allowed" per site only if the publisher permits it. Errors (blocked, no feed, timeouts) show in the Dashboard. Private/internal IPs are blocked (SSRF protection).
