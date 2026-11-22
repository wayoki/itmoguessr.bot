# Google runtime

The bot runs in Apps Script. Private code assets, SQLite game data and prepared videos are stored in the owner's Google Drive. GitHub contains all source and runs tests/builds and FFmpeg jobs. No Cloudflare account or R2 subscription is used by the target runtime.

`npm ci && npm run build:google` produces reproducible assets under `google/dist`.
`sqlite.js.gz` is the Google-compatible asm.js build of sql.js; its MIT license accompanies it. The build converts asynchronous wrappers into synchronous Apps Script service calls. Integration tests exercise the converted bot and SQLite together.

The small Apps Script entry point is `google/dist/Code.gs`. Its source commit must be pinned to an immutable reviewed GitHub commit. Installation verifies SHA-256 for each downloaded asset before saving it in private Drive storage.

The installer starts paused, with no Telegram webhook or trigger changes. Source authorization, a consistent data/secret/media transfer, live Google checks and a verified Telegram cutover are required before the Sites runtime can be disabled. Installation alone is not migration completion.

OAuth scopes are limited to external requests, files created/opened by this app (`drive.file`), and managing its Apps Script trigger. The runtime must never log bot tokens, private keys, answer data or media credentials.

Apps Script has execution/runtime, URL Fetch and Drive quotas. The database is limited to an 8 MB base64 snapshot in this implementation. Prepared uploads are capped at 30 MB; original large videos are downloaded and converted on GitHub, not inside Apps Script. The next production round is still required as the live scheduling check after cutover.
