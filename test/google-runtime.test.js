import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildGoogle } from '../scripts/build-google.js';

const build = await buildGoogle();
const context = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
vm.runInContext(build.sqlBundle + '\n' + build.bundle, context);
const SQL = context.loadGoogleSqlite();

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
