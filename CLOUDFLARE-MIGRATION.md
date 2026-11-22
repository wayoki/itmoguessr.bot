# Own Cloudflare migration

Target: an account-owned Worker, D1 database and private R2 bucket, deployed from GitHub.
The existing Sites deployment remains production until the cutover is verified.

## Prepared
- Manual workflow: Deploy to own Cloudflare.
- Configuration generator validates real account/database/bucket identifiers.
- The new Worker has no cron trigger. Deployment does not change Telegram webhooks, Google scheduling, credentials or database rows.
- Source stays compatible with the original Cloudflare Worker runtime.

## Access needed
The repository needs CLOUDFLARE_ACCOUNT_ID and a scoped CLOUDFLARE_API_TOKEN in Actions secrets.
The token must be restricted to the destination account, with Workers Scripts, D1 and Workers R2 Storage edit access as needed for deployment and migration.
Create/enter credentials in Cloudflare and GitHub directly, never in chat or committed files.
After resources are created, set repository variables CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_R2_BUCKET.
R2 activation or billing prompts require the account owner; do not accept a paid plan automatically.

## Remaining cutover
1. Create the destination D1 database and private R2 bucket; verify account ownership and access.
2. Transfer a consistent schema/data snapshot, private R2 objects and runtime secrets over authenticated connections. Never publish them as repository files or public workflow artifacts.
3. Keep the destination paused. Compare row counts, active rounds, outbox states and media references. Verify health and authenticated maintenance access.
4. Briefly pause production processing, transfer the final delta, then switch the Telegram webhook and the Google schedule URL to the destination.
5. Point GitHub maintenance jobs at the destination. Confirm Telegram delivery, timer calls and a due-round cycle before disabling Sites.
6. Remove temporary migration access after verification. Keep a private rollback snapshot.

Status: deployment preparation only. Data, secrets and live Telegram traffic have not been migrated yet.
