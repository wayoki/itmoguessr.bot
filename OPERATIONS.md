# Operations

GitHub stores the current Worker source, migrations, tests and maintenance jobs.
The existing Sites deployment keeps the Telegram webhook, D1 game data and private R2 media.
Actions does not replace these persistent services. Player data and videos must never be committed or uploaded as public workflow artifacts.

## Jobs

- `Tests and build`: runs game tests, scheduler tests and a self-contained Worker build on pushes and pull requests. It never calls production.
- `Verify bot access`: manually checks authenticated media access without publishing Telegram messages.
- `Check training schedule`: checks due rounds and weekly/monthly reports every five minutes, at minutes 2, 7, 12, and so on. Game times remain in Europe/Moscow. Actions can start late and public repositories disable schedules after 60 days without repository activity.
- `Prepare Telegram videos`: runs FFmpeg every 15 minutes; downloads and encoded files exist only in the runner's temporary storage. Prepared media is uploaded to the existing private R2 bucket.

## Required secret and cutover

Create the repository secret `ITMOGUESSR_MEDIA_KEY` with the same value as `MEDIA_PREPARER_KEY` in the existing bot's Sites runtime. Do not put this value in a file, workflow, issue or chat. The Telegram token and Drive service-account credentials remain in Sites and are not needed by these jobs.

Scheduled jobs perform no production requests when the secret is absent. A manual run fails explicitly when configuration is missing.

1. Add the secret, then run `Verify bot access`.
2. Run `Prepare Telegram videos` and `Check training schedule`; confirm both succeed.
3. Remove `MEDIA_WORKER_URL` from the Sites runtime and redeploy the current saved version, preserving all other environment variables. This stops the old Apps Script path from waking Render.
4. Remove only the `scheduledCheck` time trigger in the existing Apps Script project after a successful scheduled Actions run is observed.
5. Suspend the old Render media service. Do not delete it before the new workflow is verified.

Until these steps are complete, the existing scheduler and Render service are the fallback. The database, Telegram webhook and existing rounds must not be reset.

The GitHub workflows build and test the Worker; they do not automatically deploy Worker source to Sites. Publishing a Worker change still uses the authenticated Sites deployment workflow.
