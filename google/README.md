# Google runtime

The bot runs in Apps Script. Private code assets and SQLite game data are stored in the owner's Google Drive. Videos are uploaded directly to the Telegram bot using /add and reused by file_id; the Google runtime never downloads or copies them. GitHub contains all source and runs tests/builds. No Cloudflare account or R2 subscription is used by the target runtime.

`npm ci && npm run build:google` produces reproducible assets under `google/dist`.
`sqlite.js.gz` is the Google-compatible asm.js build of sql.js; its MIT license accompanies it. The build converts asynchronous wrappers into synchronous Apps Script service calls. Integration tests exercise the converted bot and SQLite together.

The small Apps Script entry point is `google/dist/Code.gs`. Its source commit must be pinned to an immutable reviewed GitHub commit. Installation verifies SHA-256 for each downloaded asset before saving it in private Drive storage.

The installer starts paused, with no Telegram webhook or trigger changes. Source authorization, a consistent data/secret transfer, live Google checks and a verified Telegram cutover are required before the Sites runtime can be disabled. Installation alone is not migration completion.

OAuth scopes are limited to external requests, files created/opened by this app (`drive.file`), and managing its Apps Script trigger. The runtime must never log bot tokens, private keys, answer data or media credentials.

Apps Script has execution/runtime, URL Fetch and Drive quotas. The database is limited to an 8 MB base64 snapshot in this implementation. The Drive API service must be enabled for private database storage. No video download, FFmpeg job or media storage service is needed for Telegram uploads. The next production round is still required as the live scheduling check after cutover.

`google/migration.gs` is a temporary, authenticated migration helper. It is not included in the regular build. Its expiring access key must be supplied only in the private Apps Script project, never committed, and the helper must be removed after verified cutover. It imports tables with triggers suspended and rollback on failure, preserves Telegram file IDs, and refuses to overwrite an active destination. The normal webhook returns a direct HTML acknowledgement to Telegram and allows retrying an interrupted update.
