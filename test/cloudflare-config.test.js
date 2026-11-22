import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareConfig } from '../scripts/cloudflare-config.js';

const destination = {
  CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000000',
  CLOUDFLARE_D1_DATABASE_ID: '11111111-2222-3333-4444-555555555555',
  CLOUDFLARE_R2_BUCKET: 'itmoguessr-media',
};

test('destination binds the existing Worker without enabling its scheduler', () => {
  const config = cloudflareConfig(destination);
  assert.equal(config.main, 'index.js');
  assert.equal(config.d1_databases[0].binding, 'DB');
  assert.equal(config.r2_buckets[0].binding, 'MEDIA');
  assert.deepEqual(config.triggers.crons, []);
  assert.equal(JSON.stringify(config).includes('chatgpt.site'), false);
  assert.equal('vars' in config, false);
});

test('incomplete destination fails before a deployment can run', () => {
  for (const key of Object.keys(destination)) {
    assert.throws(() => cloudflareConfig({ ...destination, [key]: '' }), /Set CLOUDFLARE/);
  }
});
