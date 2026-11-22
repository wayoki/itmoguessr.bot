# Operations

## Hosting
GitHub contains bot source, migrations, tests and maintenance jobs.
Sites serves Telegram webhooks and retains D1 game data and private R2 media.
Player data, credentials and media files never belong in the public repository or workflow artifacts.
Worker changes still require an authenticated Sites deployment.

## Scheduling
The intended primary clock is the existing Google Apps Script minute trigger.
Its source is scripts/apps-schedule.gs: scheduledCheck calls the authenticated /schedule/check endpoint on every invocation.
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

## Recovery status — 22 November 2026
The corrected minute-clock source is committed and passes a local syntax/call test.
Applying that source in Google Apps Script and verifying autonomous timer calls remains outstanding.
The browser editor did not reliably accept or persist edits; do not treat UI attempts as a completed deployment.
At the latest database check, last_apps_script_tick was still 1795283721.
Before declaring recovery complete, save the corrected script with the existing minute trigger and observe last_apps_script_tick advance on at least two autonomous executions.
