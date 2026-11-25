# Google runtime

The bot runs in Apps Script. Private code assets and SQLite game data are stored in the owner's Google Drive. Videos are uploaded directly to the Telegram bot using /add and reused by file_id; the Google runtime never downloads or copies them. GitHub contains all source and runs tests/builds. The bot and timer run independently of the owner’s computer. No Cloudflare account or R2 subscription is used by the target runtime.

`npm ci && npm run build:google` produces reproducible assets under `google/dist`.
`sqlite.js.gz` is the Google-compatible asm.js build of sql.js; its MIT license accompanies it. The build converts asynchronous wrappers into synchronous Apps Script service calls. Integration tests exercise the converted bot and SQLite together.

The small Apps Script entry point is `google/dist/Code.gs`. Its source commit must be pinned to an immutable reviewed GitHub commit. Installation verifies SHA-256 for each downloaded asset before saving it in private Drive storage.

The installer starts paused, with no Telegram webhook or trigger changes. The existing production installation has completed its Telegram cutover; its project and endpoint are recorded in `google/deployment.json`. The old Sites runtime is frozen and its legacy Google scheduler is disabled. A new installation still requires explicit deployment authorization and a consistent data transfer.

OAuth scopes are limited to external requests, files created/opened by this app (`drive.file`), and managing its Apps Script trigger. The runtime must never log bot tokens, private keys, answer data or media credentials.

Apps Script has execution/runtime, URL Fetch and Drive quotas. The database is limited to an 8 MB base64 snapshot in this implementation. The Drive API service must be enabled for private database storage. No video download, FFmpeg job or media storage service is needed for Telegram uploads. A direct HTTP 200 webhook request and a later autonomous Google timer tick were verified after cutover.

`google/migration.gs` is a temporary, authenticated migration helper. It is not included in the regular build. Its expiring access key must be supplied only in the private Apps Script project, never committed, and the helper must be removed after verified cutover. It imports tables with triggers suspended and rollback on failure, preserves Telegram file IDs, and refuses to overwrite an active destination. The normal webhook returns a direct HTML acknowledgement to Telegram and allows retrying an interrupted update.

Immutable SQL/code modules are cached in the script cache with SHA-256 validation; partial/evicted entries fall back to private Drive. The mutable database is never cached. GitHub Actions runs CI only; no maintenance secret is copied to the executor or transmitted by an Actions schedule.

## Community panorama upgrade

Build the Google assets from the reviewed source and publish them to the repository's existing `google/dist` path. The owner-run `releaseCommunityPanoramas_` in `google/release.gs` checks the pinned core manifest, validates the migration against the current Drive snapshot, and preserves the bot's Apps Script URL. It enables Telegram callback queries on the existing webhook, updates the private core binding under the script lock, then opens and verifies the new runtime. Prior code assets remain available. Only aggregate row counts are logged.
