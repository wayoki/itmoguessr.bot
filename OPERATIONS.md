# Operations

## Live runtime
The Telegram bot runs in Google Apps Script. GitHub contains the source, migrations, tests and builds. Private SQLite game data and code assets are stored in the owner-created Google Drive folder. Video files stay in Telegram and are reused by file_id; the runtime does not download or copy videos to Drive.

The source is deployed to the existing project recorded in google/deployment.json. The public webapp accepts Telegram requests only with the private webhook key; maintenance calls require ITMOGUESSR_MEDIA_KEY. Credentials, answer data and media must never be committed or placed in workflow artifacts.

## Scheduling
The Google bot project's every-minute scheduledCheck trigger is the primary clock. It loads the game runtime every minute during the first ten minutes of 09:00, 10:00, 19:00 and 20:00 Moscow time, and every five minutes otherwise. This includes the 09:30 weekly/monthly report slot. GitHub Actions runs CI only. The bot and its timer do not use GitHub maintenance secrets. Obsolete Sites maintenance and video-conversion workflows were removed.

The old ITMOGUESSR scheduling script has an intentional early return and no longer calls Sites. Render itmoguessr-media remains suspended. The old ChatGPT scheduling automation remains disabled. No Cloudflare account or R2 subscription is used by the bot runtime.

## Telegram uploads

In the private bot chat: /add → one Telegram photo or video → Google Maps pin, coordinates or location → difficulty (1–5) → own score (0–5000). Use /done to finish, /cancel to discard the current draft, and /moderation to manage /mute and /unmute. Existing Telegram file IDs stay in the queue. Closed-round ratings are persisted as one editable vote per voter and round.

## Verification and migration
On 22 November 2026, 30 rounds, 143 guesses, 7 Telegram locations and the existing notification/report state were imported. The final source snapshot was taken after freezing the old Sites runtime. The same Telegram bot and file IDs are preserved. A request through the new public webhook returned HTTP 200 directly and was recorded by the Google runtime. Telegram reported the Google webhook, zero pending updates and no webhook error.

The source Sites version 24 is retained as a frozen recovery copy. It no longer processes Telegram or schedule requests. Restore must reconcile any later Google writes before reverting the webhook; do not simply activate both runtimes. The temporary migration helper was removed from the live Google deployment (version 4). Source export credentials were invalidated in Sites environment revision 15 and the frozen recovery version was redeployed. The old authenticated export now returns HTTP 404.

## Limits
Apps Script and Drive quotas still apply. The SQLite snapshot guard is 8 MB base64. Keeping the bot running does not require ChatGPT or the owner's computer to remain open. The community panorama release replaces the immutable core asset in private Drive using the reviewed GitHub commit. The existing Apps Script deployment URL and timer stay in use.

Autonomous Google timer tick verified at Unix 1795355771 (22 November 2026, 16:56:11 Moscow). No manual wake call was used to produce this tick. Immutable code caching avoids downloading the SQLite module for every request; game data is always read under the script lock.
