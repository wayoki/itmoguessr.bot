import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildGoogle } from '../scripts/build-google.js';

const build = await buildGoogle();
const context = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
vm.runInContext(build.sqlBundle + '\n' + build.bundle, context);
const SQL = context.loadGoogleSqlite();
const migrationSource = await readFile('google/migration.gs', 'utf8');

function fixture() {
  const sent = [];
  const core = context.createGoogleCore({
    Response: Object.assign(function(body, options) { this.body = body; this.status = options?.status ?? 200; }, { json: data => ({ data }) }),
    uuid: () => 'test-id',
    telegram(env, method, body) { sent.push({ method, body }); return { message_id: 100 + sent.length }; },
    driveFetch() { throw new Error('No Drive request expected'); },
  });
  const sqlite = new SQL.Database();
  sqlite.run(build.schema);
  const snapshots = [];
  const env = { DB: new core.GoogleDatabase(sqlite, bytes => snapshots.push(Uint8Array.from(bytes))),
    BOT_TOKEN: 'test', WEBHOOK_SECRET: 'secret', ADMIN_IDS: '1', TELEGRAM_CHANNEL: '@club',
    SCHEDULE_ENABLED: 'true', PUBLIC_GUESS_SCORE_FROM_ROUND: '1' };
  const request = message => ({ headers: { get: () => 'secret' }, json: () => ({ update_id: message.message_id, message }) });
  const owner = (id, extra) => ({ message_id: id, chat: { id: 1, type: 'private' }, from: { id: 1 }, ...extra });
  return { core, env, sent, sqlite, snapshots, request, owner };
}

test('Google runtime retains location upload, a single guess, scoring and idempotent reveal', () => {
  const { core, env, sent, sqlite, request, owner, snapshots } = fixture();
  const ctx = { waitUntil: value => value };
  for (const message of [owner(1, { text: '/add' }), owner(2, { video: { file_id: 'video-token', file_unique_id: 'video-unique', file_size: 50000000 } }),
    owner(3, { text: '55.75, 37.61' }), owner(4, { text: '4500' }), owner(5, { text: '/done' })]) core.webhook(env, ctx, request(message));
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM locations').first('n'), 1);
  core.webhook(env, ctx, request(owner(4, { text: '4500' })));
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM locations').first('n'), 1);
  const end = Math.floor(Date.now() / 1000) + 300;
  core.publish(env, 'manual:test', end);
  assert.equal(sent.filter(x => x.method === 'sendVideo').length, 1);
  assert.equal(sent.find(x => x.method === 'sendVideo').body.video, 'video-token');
  core.publish(env, 'manual:test', end);
  assert.equal(sent.filter(x => x.method === 'sendVideo').length, 1);
  const player = (id, extra) => ({ message_id: id, chat: { id: 2, type: 'private' }, from: { id: 2, first_name: 'Test' }, ...extra });
  core.webhook(env, ctx, request(player(6, { text: '/start round_v2_1' })));
  const reply = core.webhook(env, ctx, request(player(7, { location: { latitude: 55.75, longitude: 37.61 } })));
  assert.match(reply.data.text, /5000/);
  core.webhook(env, ctx, request(player(8, { location: { latitude: 0, longitude: 0 } })));
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM guesses').first('n'), 1);
  env.DB.prepare('UPDATE rounds SET ends=? WHERE id=1').bind(Math.floor(Date.now() / 1000) - 1).run();
  env.DB.prepare("INSERT INTO settings VALUES('paused','1')").run();
  core.tick(env, 'apps_script');
  const locations = sent.filter(x => x.method === 'sendLocation').length;
  assert.equal(locations, 1);
  core.tick(env, 'apps_script');
  assert.equal(sent.filter(x => x.method === 'sendLocation').length, locations);
  assert.equal(env.DB.prepare("SELECT status FROM rounds WHERE id=1").first('status'), 'closed');
  assert.ok(snapshots.length > 0);
  const restored = new SQL.Database(snapshots.at(-1));
  assert.equal(restored.exec('SELECT COUNT(*) FROM guesses')[0].values[0][0], 1);
  restored.close(); sqlite.close();
});

test('Telegram-only mode ignores legacy Drive credentials, including an empty queue after restore', () => {
  const { core, env, sent, sqlite, snapshots, request, owner } = fixture();
  env.MEDIA_SOURCE = 'telegram';
  env.DRIVE_SERVICE_ACCOUNT = '{invalid legacy configuration';
  const ctx = { waitUntil: value => value };
  for (const message of [owner(1, { text: '/add' }), owner(2, { video: { file_id: 'telegram-only-video', file_unique_id: 'telegram-only-unique' } }),
    owner(3, { location: { latitude: 55.75, longitude: 37.61 } }), owner(4, { text: '4500' }), owner(5, { text: '/done' })]) core.webhook(env, ctx, request(message));
  assert.match(core.inventory(env), /Готовы: 1/);
  assert.match(core.webhook(env, ctx, request(owner(6, { text: '/sync' }))).data.text, /Синхронизация с Drive не нужна/);
  const restored = new SQL.Database(snapshots.at(-1));
  env.DB = new core.GoogleDatabase(restored, () => {});
  core.publish(env, 'manual:telegram-only', Math.floor(Date.now() / 1000) + 300);
  assert.equal(sent.filter(x => x.method === 'sendVideo').at(-1).body.video, 'telegram-only-video');
  assert.match(core.inventory(env), /Готовы: 0/);
  core.publish(env, 'manual:empty-telegram', Math.floor(Date.now() / 1000) + 300);
  assert.equal(sent.filter(x => x.method === 'sendVideo').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(core.scanLocations(env, {}, 12))), { locations: [], next: null, done: true });
  restored.close(); sqlite.close();
});

test('Google database rolls back a failed multi-statement operation without persisting it', () => {
  const { env, snapshots, sqlite } = fixture();
  assert.throws(() => env.DB.batch([
    env.DB.prepare("INSERT INTO settings VALUES('transaction','1')"),
    env.DB.prepare("INSERT INTO settings VALUES('transaction','2')"),
  ]));
  assert.equal(env.DB.prepare("SELECT value FROM settings WHERE key='transaction'").first(), null);
  assert.equal(snapshots.length, 0);
  sqlite.close();
});

test('Google transformed webhook still denies unauthorized requests and owners', () => {
  const { core, env, request, owner, sqlite } = fixture();
  const response = core.webhook(env, { waitUntil() {} }, { headers: { get: () => 'wrong' }, json: () => { throw new Error('must not parse'); } });
  assert.equal(response.status, 403);
  const reply = core.webhook(env, { waitUntil() {} }, request({ ...owner(1, { text: '/add' }), from: { id: 99 } }));
  assert.match(reply.data.text, /владельцу/);
  sqlite.close();
});

test('migration preserves Telegram IDs and notifications without executing import triggers', () => {
  const source = fixture(), destination = fixture();
  const ctx = { waitUntil: value => value };
  for (const message of [source.owner(1, { text: '/add' }), source.owner(2, { video: { file_id: 'persistent-telegram-video', file_unique_id: 'persistent-unique' } }),
    source.owner(3, { text: '55.75, 37.61' }), source.owner(4, { text: '4500' })]) source.core.webhook(source.env, ctx, source.request(message));
  source.core.publish(source.env, 'manual:migration', Math.floor(Date.now() / 1000) + 300);
  const names = ['rounds','guesses','selected','settings','outbox','prepared_media','retired_locations','weekly_reports','monthly_reports','locations','location_upload_sessions'];
  const data = { version: 1, env: { BOT_TOKEN: 'private-test-token', WEBHOOK_SECRET: 'private-test-secret' },
    tables: Object.fromEntries(names.map(name => [name, source.env.DB.prepare('SELECT * FROM ' + name).all().results])) };
  const properties = {};
  let persisted = 0;
  const sandbox = vm.createContext({ console, Date, PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key], setProperties: values => Object.assign(properties, values) }) },
    withGoogleRuntime_: action => action({ sqlite: destination.sqlite, env: { DATA_FOLDER_ID: 'private' }, persist() { persisted++; } }),
    driveCreate_() {}, Utilities: { base64Encode: () => 'private-test-backup' }, bytesSigned_: x => x,
  });
  vm.runInContext(migrationSource, sandbox);
  sandbox.migrateSource_ = () => data;
  const result = vm.runInContext('migrateImport_()', sandbox);
  assert.equal(result.counts.rounds, 1);
  assert.equal(destination.env.DB.prepare('SELECT file_id FROM locations').first('file_id'), 'persistent-telegram-video');
  assert.equal(destination.env.DB.prepare('SELECT COUNT(*) AS n FROM outbox').first('n'), data.tables.outbox.length);
  assert.equal(destination.env.DB.prepare("SELECT value FROM settings WHERE key='paused'").first('value'), '1');
  assert.equal(properties.BOT_TOKEN, 'private-test-token');
  assert.ok(!JSON.stringify(result).includes('private-test-token'));
  assert.equal(persisted, 1);
  data.tables.locations[0].unexpected_column = 'reject';
  assert.throws(() => vm.runInContext('migrateImport_()', sandbox), /UnexpectedColumn/);
  assert.equal(persisted, 1);
  assert.equal(destination.env.DB.prepare('SELECT file_id FROM locations').first('file_id'), 'persistent-telegram-video');
  properties.GOOGLE_BOT_ACTIVE = 'true';
  assert.throws(() => vm.runInContext('migrateImport_()', sandbox), /AlreadyActive/);
  source.sqlite.close(); destination.sqlite.close();
});

test('Telegram acknowledgement uses a direct HTML response rather than a content redirect', async () => {
  const sandbox = vm.createContext({ HtmlService: { createHtmlOutput: value => ({ http: 200, body: value }) } });
  vm.runInContext(await readFile('google/bootstrap.gs', 'utf8'), sandbox);
  const ack = vm.runInContext('telegramAck_()', sandbox);
  assert.equal(ack.http, 200);
  assert.equal(ack.body, 'OK');
});
