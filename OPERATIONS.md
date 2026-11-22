# Operations

## Hosting
GitHub contains bot source, migrations, tests and maintenance jobs.
Sites serves Telegram webhooks and retains D1 game data and private R2 media.
Player data, credentials and media files never belong in the public repository or workflow artifacts.
Worker changes still require an authenticated Sites deployment.

## Scheduling
The primary clock is the existing Google Apps Script minute trigger.
Its source is scripts/apps-schedule.gs. It calls the authenticated /schedule/check endpoint every minute during the first ten minutes of 09:00, 10:00, 19:00 and 20:00 Moscow time, and every five minutes otherwise. The 09:30 report slot is covered.
The server decides which rounds and weekly/monthly reports are due, using Europe/Moscow.
Repeated checks are safe because server-side processing is idempotent.

GitHub Actions schedule checks remain a secondary backup, requested every five minutes.
Do not rely on Actions cron for punctual publication: the observed schedule had multi-hour gaps.
Scheduled public-repository workflows can also be disabled after 60 days without repository activity.

## Actions
- CI: 30 game tests, 5 scheduler/video tests and a self-contained Worker build.
- Verify bot access: authenticated check without Telegram publication.
- Prepare Telegram videos: requested at minutes 7, 22, 37 and 52. FFmpeg converts up to two queued Drive videos and uploads to private R2.
- Check training schedule: secondary due-round/report check.
- Verify Actions cutover: access check, queue processing and a due-round check.

## Credentials
ITMOGUESSR_MEDIA_KEY in repository secrets must match MEDIA_PREPARER_KEY in Sites.
The existing Google script property ITMOGUESSR_SCHEDULE_KEY matches the runtime schedule digest.
Keep these credentials private. No key rotation is needed to restore the Google clock.

## Migration and verification
- Render service itmoguessr-media is suspended.
- MEDIA_WORKER_URL was removed; Sites version 23 uses environment revision 12.
- The previous ChatGPT scheduling automation remains disabled.
- Actions access, media queue and schedule checks succeeded:
  - https://github.com/wayoki/itmoguessr.bot/actions/runs/44932355775
  - https://github.com/wayoki/itmoguessr.bot/actions/runs/44956794766
  - https://github.com/wayoki/itmoguessr.bot/actions/runs/44956826408

## Recovery verified — 22 November 2026
The disabling early return was removed and the original Google scheduling logic was restored.
The saved editor source shows the active scheduledCheck body, with no early return.
Two independent live-database observations confirmed autonomous Google calls:
- last_apps_script_tick = 1795310121 (04:15:21 Europe/Moscow).
- last_apps_script_tick = 1795312821 (05:00:21 Europe/Moscow).
No manual schedule request was made to produce these observations.
The bot remains unpaused (paused = 0).
The GitHub copy now matches the restored scheduling logic.
Local checks passed for publication/reveal windows, the 09:30 report slot, and idle-hour filtering.
These checks verify timer connectivity and code paths; the next actual scheduled round remains the production publication check.

### Telegram uploads (target Google runtime)

The owner uses /add → one Telegram video → coordinates → own score (0–5000), then /done. Files stay in Telegram and are reused by file_id. Google persists only SQLite game data and runtime code. MEDIA_SOURCE is forced to telegram in the Google adapter, including when legacy Drive credentials are present. The target runtime has no source/prepared-video upload endpoints. The live Sites runtime remains in service until data migration and a verified Google cutover.
