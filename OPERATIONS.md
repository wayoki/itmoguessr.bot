# Operations

## Hosting
GitHub contains the current bot source, database migrations, tests and maintenance jobs.
The existing Sites deployment serves Telegram webhooks and retains D1 game data and private R2 media.
Player data and video files are never committed or uploaded as public workflow artifacts.
Actions builds and tests Worker source; changes to the Worker itself still require an authenticated Sites deployment.

## Actions
- Tests and build: 30 game tests, 5 scheduler/video tests and a self-contained Worker build.
- Verify bot access: manual authenticated access check with no Telegram publication.
- Check training schedule: minutes 2, 7, 12, …, 57 of every hour; checks due rounds and weekly/monthly reports. Game times remain in Europe/Moscow.
- Prepare Telegram videos: minutes 7, 22, 37 and 52; FFmpeg converts up to two queued Drive videos and saves outputs to private R2. Temporary runner files disappear with the job.
- Verify Actions cutover: authenticated access, real queue processing and a due-round check. Runs manually, or when its own workflow configuration changes on main.

GitHub can delay scheduled runs. Public-repository schedules are disabled after 60 days without repository activity.

## Credentials
The repository secret ITMOGUESSR_MEDIA_KEY must match MEDIA_PREPARER_KEY in the bot's Sites runtime.
Neither value belongs in source files or workflow logs. Telegram and Drive credentials remain in Sites.
Without the secret, scheduled jobs report that maintenance is inactive and make no production calls.
Manual jobs fail explicitly if credentials are absent.

## Migration record — 21 November 2026
- End-to-end Actions verification passed: https://github.com/wayoki/itmoguessr.bot/actions/runs/44932355775
- Private media access and due-round checks succeeded; the video queue contained no files requiring conversion.
- The Render media service itmoguessr-media is suspended.
- MEDIA_WORKER_URL was removed from the Sites runtime and version 23 was redeployed with environment revision 12.
- The old Apps Script scheduledCheck function now returns immediately. Its trigger and original source are retained for reversible recovery, and do not call the bot.
- The old ChatGPT scheduling automation was already disabled and remains disabled.
- Database contents, pause state and Telegram webhook were preserved.

If recovering the old Render pipeline, resume the service, update its media-key digest to match the current key, and restore MEDIA_WORKER_URL.
Re-enabling the old Apps Script scheduler requires removing the early return in scheduledCheck. Do not re-enable it during normal Actions operation.

## Automatic verification — 22 November 2026 (Europe/Moscow)
- Schedule-triggered round/report check succeeded: https://github.com/wayoki/itmoguessr.bot/actions/runs/44956794766
- Schedule-triggered media preparation succeeded: https://github.com/wayoki/itmoguessr.bot/actions/runs/44956826408
- The credentials-required steps executed successfully, rather than being skipped. The media queue had zero pending conversions and zero errors.
- Both automatic jobs completed around 01:27 Moscow time. At the 03:52 verification, these were still the most recent scheduled runs. Treat the configured 5/15-minute cron intervals as requested cadence, not a punctuality guarantee.
- The proposed temporary Google fallback was not deployed: the saved scheduledCheck early return remains in place because real Actions schedule events are now verified.
