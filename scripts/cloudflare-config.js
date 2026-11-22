import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function cloudflareConfig(env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const database = env.CLOUDFLARE_D1_DATABASE_ID;
  const bucket = env.CLOUDFLARE_R2_BUCKET;
  if (!/^[a-f0-9]{32}$/i.test(account ?? '')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database ?? '')) {
    throw new Error('Set CLOUDFLARE_D1_DATABASE_ID to the destination database UUID');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? '')) throw new Error('Set CLOUDFLARE_R2_BUCKET');
  return {
    name: 'itmoguessr-bot',
    account_id: account,
    main: 'index.js',
    compatibility_date: '2026-11-22',
    workers_dev: true,
    // The destination stays idle until data, credentials and webhook are migrated.
    triggers: { crons: [] },
    d1_databases: [{ binding: 'DB', database_name: 'itmoguessr-bot', database_id: database, migrations_dir: 'drizzle' }],
    r2_buckets: [{ binding: 'MEDIA', bucket_name: bucket }],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = cloudflareConfig(process.env);
  await mkdir('.wrangler', { recursive: true });
  await writeFile('wrangler.generated.json', JSON.stringify(config, null, 2) + '\n');
  console.log('Cloudflare deployment configuration prepared; automatic publication is disabled.');
}
