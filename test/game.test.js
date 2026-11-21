import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker, { activeSlots, coordinates, filenameCoordinates, filenameLocation, leaderboard, monthlyWindow, multipart, resetTestRounds, score, weeklySummary, weeklyWindow, remainingWeekSlots, weekCoverage, weekCoverageText } from "../index.js";

const clubMigration = "0003_start_club_rounds.sql";
const authorPointsMigration = "0006_round_author_points.sql";
const roundColumns = "id,slot,folder,latitude,longitude,chat,ends,message_id,status,updated";
const applyMigration = (sql, name) => sql.exec(readFileSync(new URL("../drizzle/" + name, import.meta.url), "utf8"));

function database() {
  const sql = new DatabaseSync(":memory:");
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) applyMigration(sql, entry.tag + ".sql");
  let batchTail = Promise.resolve();
  const DB = {
    prepare(query) {
      return {
        bind(...values) {
          const statement = sql.prepare(query);
          return {
            first: async (field) => {
              const row = statement.get(...values);
              return row ? field ? row[field] : row : null;
            },
            run: async () => statement.run(...values),
            all: async () => ({ results: statement.all(...values) }),
          };
        },
      };
    },
    batch: (statements) => {
      const operation = batchTail.then(async () => {
      sql.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
        sql.exec("COMMIT");
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
      });
      batchTail = operation.catch(() => {});
      return operation;
    },
  };
  return { sql, DB };
}

test("coordinates and World scoring", () => {
  assert.deepEqual(coordinates(" 35.0116, 135.7681"), [35.0116, 135.7681]);
  for (const name of ["hello", "91, 0", "0, 181", "Infinity, 0", "2, 3, 4"]) {
    assert.equal(coordinates(name), null);
  }
  assert.deepEqual(filenameCoordinates("35.0116, 135.7681.MP4"), [35.0116, 135.7681]);
  assert.deepEqual(filenameCoordinates("48.6 -123.5__telegram.mp4"), [48.6, -123.5]);
  assert.equal(filenameCoordinates("135.7681, 35.0116.mp4"), null);
  assert.deepEqual(filenameCoordinates("56.62567, 23.34348.mov"), [56.62567, 23.34348]);
  assert.deepEqual(filenameLocation("56.62567, -23.34348, 3850.mp4"), {
    point: [56.62567, -23.34348], authorPoints: 3850,
  });
  assert.equal(filenameLocation("50, 25, 0__telegram.MP4").authorPoints, 0);
  assert.equal(filenameLocation("50, 25, 5000.jpg").authorPoints, 5000);
  for (const invalid of ["50,25,5001.mp4", "50,25,-1.mp4", "50,25,1.5.mp4", "50,25,.mp4", "91,25,1.mp4"]) {
    assert.equal(filenameLocation(invalid), null);
  }
  assert.deepEqual(score(0, 0, 0, 0), { km: 0, points: 5000 });
  assert.equal(score(0, 0, 0, 180).points, 0);
  assert.ok(Math.abs(score(0, 0, 0, 1).km - 111.195) < 0.001);
});

test("evening slot survives midnight and closes at nine Moscow time", () => {
  const unix = (date) => Date.parse(date) / 1000;
  assert.equal(activeSlots(unix("2026-11-05T20:15:00+03:00"))[0].key, "evening:2026-11-05");
  assert.equal(activeSlots(unix("2026-11-06T08:59:00+03:00"))[0].key, "evening:2026-11-05");
  assert.equal(activeSlots(unix("2026-11-06T09:00:00+03:00")).length, 0);
  assert.equal(activeSlots(unix("2026-11-06T10:00:00+03:00"))[0].key, "morning:2026-11-06");
});

test("weekly report starts Sunday at 9:30 Moscow time and includes all of Saturday", () => {
  const unix = (date) => Date.parse(date) / 1000;
  assert.equal(weeklyWindow(unix("2026-11-14T23:59:59+03:00")), null);
  assert.equal(weeklyWindow(unix("2026-11-15T09:29:59+03:00")), null);
  assert.deepEqual(weeklyWindow(unix("2026-11-15T09:30:00+03:00")), {
    start: unix("2026-11-08T00:00:00+03:00"), end: unix("2026-11-15T00:00:00+03:00"),
  });
  assert.equal(weeklyWindow(unix("2026-11-16T09:30:00+03:00")), null);
  assert.equal(weeklyWindow(unix("2026-12-06T09:30:00+03:00")), null);
  assert.notEqual(weeklyWindow(unix("2026-12-13T09:30:00+03:00")), null);
});

test("monthly report starts on the first at 9:30 Moscow time and replaces the first Sunday report", () => {
  const unix = (date) => Date.parse(date) / 1000;
  assert.equal(monthlyWindow(unix("2026-12-01T09:29:59+03:00")), null);
  assert.deepEqual(monthlyWindow(unix("2026-12-01T09:30:00+03:00")), {
    start: unix("2026-11-01T00:00:00+03:00"), end: unix("2026-12-01T00:00:00+03:00"),
  });
  assert.equal(monthlyWindow(unix("2026-12-02T09:30:00+03:00")), null);
  assert.notEqual(monthlyWindow(unix("2026-11-01T09:30:00+03:00")), null);
  assert.equal(weeklyWindow(unix("2026-11-01T09:30:00+03:00")), null);
});

test("weekly top three ranks activity, mean score and percentage improvement", () => {
  const rows = [
    { user: 1, name: "<Первый>", submitted: 103, points: 3000 },
    { user: 1, name: "Старое имя", submitted: 102, points: 2000 },
    { user: 1, name: "Старое имя", submitted: 101, points: 1000 },
    { user: 2, name: "Точный", submitted: 102, points: 5000 },
    { user: 2, name: "Точный", submitted: 101, points: 4000 },
    { user: 3, name: "Третий", submitted: 101, points: 1000 },
    { user: 4, name: "Дебютант", submitted: 101, points: 1 },
    { user: 1, name: "Первый", submitted: 99, points: 1000 },
    { user: 2, name: "Точный", submitted: 99, points: 3000 },
    { user: 3, name: "Третий", submitted: 99, points: 0 },
  ];
  const { text, mentions } = weeklySummary(rows, 100, true);
  const [, activity, accuracy, progress] = text.split("\n\n");
  assert.match(activity, /1\. .*&lt;Первый&gt;.*\(3 сыгранных раунда за неделю\)/);
  assert.match(accuracy, /1\. .*Точный.*\(4\s500 очков в среднем\)/);
  assert.match(progress, /1\. .*&lt;Первый&gt;.*на 100%\)\n2\. .*Точный.*на 50%\)$/);
  for (const section of [activity, accuracy]) assert.equal(section.split("\n").length, 4);
  assert.equal(mentions.length, 8);
  assert.equal(mentions.filter(({ user }) => user === 1).length, 3);
  assert.doesNotMatch(weeklySummary(rows, 100, false).text, /Самые прогрессирующие/);
});

test("multipart uses Telegram-safe names, inline round ID and no answer coordinates", () => {
  for (const [field, type, extension] of [["photo","image/jpeg","jpg"], ["video","video/mp4","mp4"], ["animation","image/gif","gif"]]) {
    const result = multipart({ format: ["",field,extension], media: { mimeType: type, videoMediaMetadata: { width: 1920, height: 1080 } }, point: [35.0116,135.7681] },
      { chat: "@swidfkjew", id: 4, ends: Date.parse("2026-11-08T09:00:00+03:00") / 1000 });
    const header = new TextDecoder().decode(result.header);
    assert.ok(header.includes(`name="${field}"; filename="round-4.${extension}"`));
    assert.ok(header.includes("https://t.me/itmoguessr_bot?start=round_v2_4"));
    assert.match(header, /"text":"Guess!"/);
    assert.match(header, /Раунд #4 \(до 08\.11, 9:00 МСК\)/);
    assert.ok(!header.includes("35.0116"));
    if (field === "video") assert.match(header, /name="width"\r\n\r\n1920/);
  }
});

test("webhook enforces secret and accepts a single guess, then reveals once", async (t) => {
  const { sql, DB } = database();
  const sent = [];
  const tasks = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /\/send(Message|Location)$/);
    sent.push({ method: url.split("/").at(-1), ...JSON.parse(options.body) });
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
  const env = { DB, BOT_TOKEN: "test-token", WEBHOOK_SECRET: "secret", ADMIN_IDS: "42", SCHEDULER_EMAIL: "owner@example.test" };
  const ctx = { waitUntil: (task) => tasks.push(task) };
  const request = (url, headers, data) => worker.fetch(new Request("https://bot.example" + url, {
    method: "POST", headers, body: JSON.stringify(data),
  }), env, ctx);
  const tg = (data, user = 42, secret = "secret") => request("/telegram", { "X-Telegram-Bot-Api-Secret-Token": secret }, {
    update_id: 10, message: { from: { id: user, first_name: "<Игрок>", username: "test_player" }, chat: { type: "private", id: user }, ...data },
  });
  const now = Math.floor(Date.now() / 1000);
  sql.prepare(`INSERT INTO rounds(${roundColumns}) VALUES(1,'test','drive-folder',48.8566,2.3522,'@swidfkjew',?,55,'active',?)`).run(now + 3600, now);
  assert.equal((await tg({ text: "/start round_v2_1" }, 42, "wrong")).status, 403);
  assert.match((await (await tg({ text: "/start round_1" })).json()).text, /приём ответов.*закрыт/i);
  assert.match((await (await tg({ text: "/start round_v2_1" })).json()).text, /Раунд #1/);
  const point = { location: { latitude: 48.8566, longitude: 2.3522 } };
  const results = await Promise.all([tg(point), tg(point)]);
  const replies = await Promise.all(results.map((result) => result.json()));
  assert.equal(replies.filter(({ text }) => text === "5000 / 5000 (0 километров)").length, 1);
  assert.equal(replies.filter(({ text }) => text.includes("использовал")).length, 1);
  await Promise.all(tasks.splice(0));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /href="https:\/\/t\.me\/test_player\?profile">&lt;Игрок&gt;<\/a>/);
  assert.match(sent[0].text, /набрал 5000 очков \(дистанция 0 км\) в раунде #1$/);
  assert.doesNotMatch(sent[0].text, /48\.8566|2\.3522|maps/);

  assert.match((await (await tg({ text: "/close 1" }, 43)).json()).text, /администраторам/);
  assert.match((await (await tg({ text: "/close 1" })).json()).text, /закрыт/);
  await Promise.all(tasks.splice(0));
  assert.equal(sent.length, 4);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM outbox WHERE kind='result'").get().n, 0);
  const map = sent.find(({ method }) => method === "sendLocation");
  assert.equal(map.latitude, 48.8566);
  assert.match(map.reply_markup.inline_keyboard[0][0].url, /^https:\/\/www.google.com\/maps/);
  const rank = sent.find(({ text }) => text?.includes("Раунд #1 завершён."));
  assert.match(rank.text, /^Раунд #1 завершён\.\n\n<b>1\. .*Игрок.*5000<\/b>$/);
  const maintenance = () => request("/mcp", { "oai-authenticated-user-email": "owner@example.test" },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_training_schedule" } });
  assert.equal((await (await maintenance()).json()).result.isError, undefined);
  assert.equal(sent.length, 4);
  assert.match((await (await tg(point)).json()).text, /приём ответов.*закрыт/i);
  assert.equal(sql.prepare("SELECT points FROM guesses").get().points, 5000);
  assert.match((await (await tg({ text: "/correct 1 56.62567, 23.34348" }, 43)).json()).text, /администраторам/);
  assert.match((await (await tg({ text: "/correct 1 56.62567, 23.34348" })).json()).text, /исправлена/);
  await Promise.all(tasks.splice(0));
  const corrections = sent.slice(4);
  assert.equal(corrections.length, 2);
  assert.equal(corrections[0].latitude, 56.62567);
  assert.equal(corrections[0].longitude, 23.34348);
  assert.ok(corrections.slice(1).every(({ text }) => text.includes("Исправление раунда #1")));
  assert.doesNotMatch(corrections[1].text, /5000/);
  assert.match((await (await tg({ text: "/correct 1 56.62567, 23.34348" })).json()).text, /уже сохранены/);
  await Promise.all(tasks.splice(0));
  assert.equal(sent.length, 6);
  sql.close();
});

test("random selection reaches the second Drive page and keeps the filename score until reveal", async (t) => {
  const { sql, DB } = database();
  const calls = [];
  const telegramTexts = [];
  const background = [];
  t.mock.method(Math, "random", () => 0.99);
  const format = new TextEncoder();
  const fixture = format.encode("test mp4 fixture");
  const keys = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const pem = "-----BEGIN PRIVATE KEY-----\n" +
    Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64") +
    "\n-----END PRIVATE KEY-----";
  const oldStream = globalThis.FixedLengthStream;
  globalThis.FixedLengthStream = class extends TransformStream {
    constructor() { super(); }
  };
  t.after(() => {
    if (oldStream === undefined) delete globalThis.FixedLengthStream;
    else globalThis.FixedLengthStream = oldStream;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const api = new URL(url);
    if (api.hostname === "oauth2.googleapis.com") {
      assert.ok(options.body.get("assertion").split(".").length === 3);
      return Response.json({ access_token: "fake-access", expires_in: 3600 });
    }
    if (api.hostname === "www.googleapis.com") {
      assert.equal(options.headers.Authorization, "Bearer fake-access");
      if (api.pathname.endsWith("/demo-root")) {
        return Response.json({ mimeType: "application/vnd.google-apps.folder" });
      }
      if (["/fake-file", "/fake-photo"].some((suffix) => api.pathname.endsWith(suffix))) {
        assert.equal(api.searchParams.get("alt"), "media");
        return new Response(fixture);
      }
      if (api.searchParams.get("q").startsWith("'demo-root'")) {
        if (!api.searchParams.get("pageToken")) {
          return Response.json({ nextPageToken: "second-page", files: [
            { id: "demo-folder", name: "35.0116, 135.7681", mimeType: "application/vnd.google-apps.folder" },
          ] });
        }
        return Response.json({ files: [
          { id: "fake-photo", name: "45.0116, 125.7681, 4321.png", mimeType: "image/png", size: String(fixture.length), capabilities: { canDownload: true } },
          { id: "pending-video", name: "65.0, 10.0.mov", mimeType: "video/quicktime", size: String(fixture.length), version: "1", capabilities: { canDownload: true } },
        ] });
      }
      return Response.json({
        files: [{ id: "fake-file", mimeType: "video/mp4", size: String(fixture.length), capabilities: { canDownload: true } }],
      });
    }
    calls.push(api.pathname.split("/").at(-1));
    if (api.pathname.endsWith("/sendVideo") || api.pathname.endsWith("/sendPhoto")) {
      const media = await new Response(options.body).text();
      const video = api.pathname.endsWith("/sendVideo");
      assert.ok(media.includes(video ? 'name="video"; filename="round-2.mp4"' : 'name="photo"; filename="round-1.png"'));
      assert.match(media, /test mp4 fixture/);
      assert.ok(media.includes(video ? "round_v2_2" : "round_v2_1"));
      assert.doesNotMatch(media, /35\.0116|45\.0116/);
      assert.match(media, /-1001234567890/);
    } else if (api.pathname.endsWith("/sendMessage")) {
      telegramTexts.push(JSON.parse(options.body).text);
    }
    return Response.json({ ok: true, result: { message_id: 321 } });
  });
  const env = {
    DB, BOT_TOKEN: "test-token", WEBHOOK_SECRET: "secret", ADMIN_IDS: "42", DRIVE_ROOT: "demo-root",
    TELEGRAM_CHANNEL: "-1001234567890",
    DRIVE_SERVICE_ACCOUNT: JSON.stringify({ type: "service_account", client_email: "fake@example.test", private_key: pem }),
  };
  const ctx = { waitUntil: (promise) => background.push(promise) };
  const command = (text, updateId = 5) => worker.fetch(new Request("https://bot.example/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({ update_id: updateId, message: { chat: { type: "private", id: 42 }, from: { id: 42 }, text } }),
  }), env, ctx);
  assert.match((await (await command("/next")).json()).text, /запускаю раунд/);
  await Promise.all(background.splice(0));
  await command("/next");
  await Promise.all(background.splice(0));
  assert.deepEqual(calls, ["sendPhoto", "sendMessage"]);
  const round = sql.prepare("SELECT status,message_id,author_points FROM rounds WHERE id=1").get();
  assert.equal(round.status, "active");
  assert.equal(round.message_id, 321);
  assert.equal(round.author_points, 4321);
  await command("/next", 6);
  await Promise.all(background.splice(0));
  assert.deepEqual(calls, ["sendPhoto", "sendMessage", "sendVideo", "sendMessage"]);
  const second = sql.prepare("SELECT status,author_points FROM rounds WHERE id=2").get();
  assert.equal(second.status, "active");
  assert.equal(second.author_points, null);
  assert.match((await (await command("/close 1", 7)).json()).text, /закрыт/);
  await Promise.all(background.splice(0));
  assert.match(telegramTexts.find((text) => text.startsWith("Раунд #1 завершён.")), /1\. <a href="https:\/\/t\.me\/wayoki\?profile">макс\.<\/a> — 4321/);
  sql.close();
});

test("leaderboard keeps ten players, links the display name and resolves equal scores by distance", () => {
  const players = Array.from({ length: 12 }, (_, i) => ({
    user: i + 1, username: i === 0 ? "first_player" : null, name: "<player>", latitude: i / 1e6,
    longitude: 0, submitted: 10 - i,
  })).reverse();
  const text = leaderboard({ id: 5, latitude: 0, longitude: 0 }, players);
  assert.match(text, /<b>1\. <a href="https:\/\/t\.me\/first_player\?profile">&lt;player&gt;<\/a> — 5000<\/b>/);
  assert.match(text, /2\. <a href="tg:\/\/user\?id=2">&lt;player&gt;<\/a>/);
  assert.match(text, /^Раунд #5 завершён\./);
  assert.equal(text.split("\n").filter((line) => /^(?:<b>)?\d+\./.test(line)).length, 10);
  assert.ok(!text.includes("<player>"));
});

test("the author's filename score ranks with the players and appears only in the top ten", () => {
  const round = { id: 5, latitude: 0, longitude: 0, author_points: 5000 };
  const players = [
    { user: 42, name: "Owner's guess", latitude: 0, longitude: 0, submitted: 1 },
    { user: 43, username: "WAYOKI", name: "Owner's alternate entry", latitude: 0, longitude: 0, submitted: 1 },
    { user: 44, name: "Exact", latitude: 0, longitude: 0, submitted: 2 },
    { user: 45, name: "Far", latitude: 0, longitude: 1, submitted: 2 },
  ];
  const ranked = leaderboard(round, players, "42");
  assert.match(ranked, /1\. .*Exact.*5000<\/b>\n2\. .*макс\..*5000\n3\. .*Far/);
  assert.doesNotMatch(ranked, /Owner/);

  const topPlayers = Array.from({ length: 12 }, (_, i) => ({
    user: i + 100, name: "Player " + (i + 1), latitude: 0, longitude: 0, submitted: i,
  }));
  const below = leaderboard({ ...round, author_points: 0 }, topPlayers, "42");
  assert.match(below, /10\. .*Player 10[^\n]*$/);
  assert.doesNotMatch(below, /wayoki|Player 11|Player 12/);
});

test("club reset clears test rounds and players once, preserves the pause and excludes old media", async () => {
  const { sql, DB } = database();
  sql.exec(`INSERT INTO rounds(${roundColumns}) VALUES(6,'old-slot','file:old',40,20,'@old',30,3,'active',31);
    INSERT INTO selected VALUES(42,6);
    INSERT INTO guesses(round,user,name,latitude,longitude,announcement,submitted) VALUES(6,42,'Player',40,20,'@old',28);
    INSERT INTO settings VALUES('drive_cursor_v2','{}'),('correction:6','1');`);
  assert.equal(await resetTestRounds({ DB }), false);
  assert.equal(sql.prepare("SELECT id FROM rounds").get().id, 6);
  sql.exec("INSERT INTO settings VALUES('paused','1')");
  assert.equal(await resetTestRounds({ DB }), true);
  for (const table of ["rounds", "guesses", "selected", "outbox"]) {
    assert.equal(sql.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
  assert.equal(sql.prepare("SELECT folder FROM retired_locations").get().folder, "file:old");
  assert.deepEqual(sql.prepare("SELECT key FROM settings ORDER BY key").all().map(row => row.key), ["club_launched", "paused"]);
  sql.exec("INSERT INTO rounds(slot,folder,latitude,longitude,chat,ends,status,updated) VALUES('new-slot','file:new',40,20,'@new',30,'active',31)");
  assert.equal(await resetTestRounds({ DB }), true);
  assert.equal(sql.prepare("SELECT id FROM rounds").get().id, 1);
  sql.close();
});

test("authenticated schedule wake reveals an expired round exactly once", async (t) => {
  const { sql, DB } = database();
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    sent.push({ method: url.split("/").at(-1), ...JSON.parse(options.body) });
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
  const now = Math.floor(Date.now() / 1000);
  sql.prepare(`INSERT INTO rounds(${roundColumns}) VALUES(1,'morning:test','drive-folder',48,2,'@swidfkjew',?,55,'active',?)`).run(now - 1, now - 3600);
  const env = { DB, BOT_TOKEN: "test-token", MEDIA_PREPARER_KEY: "media-secret" };
  const wake = () => worker.fetch(new Request("https://bot.example/media/wake", {
    method: "POST", headers: { "X-ITMOGUESSR-Media-Key": "media-secret" },
  }), env, {});
  assert.equal((await wake()).status, 200);
  assert.equal((await wake()).status, 200);
  assert.deepEqual(sent.map(({ method }) => method), ["sendLocation", "sendMessage"]);
  assert.match(sent[1].text, /Раунд #1 завершён/);
  assert.equal(sql.prepare("SELECT status FROM rounds").get().status, "closed");
  assert.ok(Number(sql.prepare("SELECT value FROM settings WHERE key='last_tick'").get().value) >= now);
  sql.close();
});

test("Sunday schedule publishes the previous week's report once", async (t) => {
  const { sql, DB } = database();
  const sent = [];
  t.mock.method(Date, "now", () => Date.parse("2026-11-15T09:30:00+03:00"));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /\/sendMessage$/);
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: { message_id: 111 } });
  });
  const cutoff = Date.parse("2026-11-15T00:00:00+03:00") / 1000;
  sql.prepare(`INSERT INTO rounds(${roundColumns}) VALUES(1,'evening:2026-11-14','file:video',48,2,'@club',?,55,'closed',?)`)
    .run(cutoff + 9 * 3600, cutoff - 4 * 3600);
  const guess = sql.prepare("INSERT INTO guesses(round,user,name,latitude,longitude,announcement,submitted,points) VALUES(1,?,?,48,2,'@club',?,5000)");
  guess.run(42, "Суббота", cutoff - 1);
  guess.run(43, "Воскресенье", cutoff);
  sql.exec("UPDATE outbox SET status='sent'");
  const env = { DB, BOT_TOKEN: "test-token", TELEGRAM_CHANNEL: "@club", MEDIA_PREPARER_KEY: "secret", SCHEDULE_ENABLED: "true" };
  const wake = () => worker.fetch(new Request("https://bot.example/media/wake", {
    method: "POST", headers: { "X-ITMOGUESSR-Media-Key": "secret" },
  }), env, {});
  assert.equal((await wake()).status, 200);
  assert.equal((await wake()).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, "@club");
  assert.match(sent[0].text, /Итоги недели!.*Суббота/s);
  assert.doesNotMatch(sent[0].text, /Воскресенье|Самые прогрессирующие/);
  assert.equal(sql.prepare("SELECT message_id FROM weekly_reports WHERE status='sent'").get().message_id, 111);
  const stored = sql.prepare("SELECT mentions FROM weekly_reports").get();
  assert.deepEqual(JSON.parse(stored.mentions).map(({ user }) => user), [42, 42]);
  sql.close();
});

test("first-of-month schedule uses all month scores and published weekly mentions without duplicates", async (t) => {
  const { sql, DB } = database();
  const sent = [];
  const unix = (date) => Date.parse(date) / 1000;
  t.mock.method(Date, "now", () => Date.parse("2026-12-01T09:30:00+03:00"));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /\/sendMessage$/);
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: { message_id: 112 } });
  });
  const player = { user: 42, name: "Макс", username: "test_player" };
  const other = { user: 43, name: "Вне месяца" };
  const round = sql.prepare(`INSERT INTO rounds(${roundColumns}) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const guess = sql.prepare("INSERT INTO guesses(round,user,name,username,latitude,longitude,announcement,submitted,points) VALUES(?,?,?,?,48,2,'@club',?,?)");
  for (const [index, date, points] of [
    [1, "2026-11-07T12:00:00+03:00", 2000],
    [2, "2026-11-15T12:00:00+03:00", 4000],
    [3, "2026-11-30T12:00:00+03:00", 3000],
    [4, "2026-12-01T00:00:00+03:00", 5000],
  ]) {
    const at = unix(date);
    round.run(index, `slot:${index}`, `file:${index}`, 48, 2, "@club", at, index, "closed", at);
    guess.run(index, player.user, player.name, player.username, at, points);
  }
  sql.exec("UPDATE outbox SET status='sent'");
  const report = sql.prepare("INSERT INTO weekly_reports(week_start,text,mentions,status,updated) VALUES(?,'old',?,?,?)");
  report.run(1, JSON.stringify([player, player]), "sent", unix("2026-11-15T09:30:00+03:00"));
  report.run(2, JSON.stringify([player]), "sent", unix("2026-11-22T09:30:00+03:00"));
  report.run(3, JSON.stringify([other]), "pending", unix("2026-11-29T09:30:00+03:00"));
  report.run(4, JSON.stringify([other]), "sent", unix("2026-12-01T00:00:00+03:00"));
  const env = { DB, BOT_TOKEN: "test-token", TELEGRAM_CHANNEL: "@club", MEDIA_PREPARER_KEY: "secret", SCHEDULE_ENABLED: "true" };
  const wake = () => worker.fetch(new Request("https://bot.example/media/wake", {
    method: "POST", headers: { "X-ITMOGUESSR-Media-Key": "secret" },
  }), env, {});
  assert.equal((await wake()).status, 200);
  assert.equal((await wake()).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, "@club");
  assert.match(sent[0].text, /Итоги месяца!.*3 сыгранных раунда за месяц.*3\s000 очков в среднем.*улучшил показатели на 50%.*Самые отметившиеся.*test_player\?profile">Макс<\/a> — 3 упоминания/s);
  assert.doesNotMatch(sent[0].text, /Вне месяца/);
  assert.equal(sql.prepare("SELECT message_id FROM monthly_reports WHERE status='sent'").get().message_id, 112);
  sql.close();
});

test("public guess scores start at the configured round", async (t) => {
  const { sql, DB } = database();
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    sent.push(JSON.parse(options.body).text);
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
  const now = Math.floor(Date.now() / 1000);
  const round = sql.prepare(`INSERT INTO rounds(${roundColumns}) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const guess = sql.prepare("INSERT INTO guesses(round,user,name,latitude,longitude,announcement,submitted,points,distance) VALUES(?,42,'Игрок',48,2,'@club',?,3,12.345)");
  for (const id of [4, 5]) {
    round.run(id, `slot:${id}`, `file:${id}`, 48, 2, "@club", now + 3600, id, "active", now);
    guess.run(id, now);
  }
  const response = await worker.fetch(new Request("https://bot.example/media/wake", {
    method: "POST", headers: { "X-ITMOGUESSR-Media-Key": "media-secret" },
  }), { DB, BOT_TOKEN: "test-token", MEDIA_PREPARER_KEY: "media-secret", PUBLIC_GUESS_SCORE_FROM_ROUND: "5" }, {});
  assert.equal(response.status, 200);
  assert.match(sent[0], /сделал guess в раунде #4$/);
  assert.match(sent[1], /набрал 3 очка \(дистанция 12,35 км\) в раунде #5$/);
  sql.close();
});

test("migration preserves the old round and sent notifications", () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../drizzle/0000_game.sql", import.meta.url), "utf8"));
  sql.exec("INSERT INTO rounds VALUES(1,'old-slot','old-folder',40,20,'@old',30,3,'closed',31)");
  sql.exec("INSERT INTO outbox VALUES(1,1,0,'reveal','@old','sent',31,7)");
  sql.exec(readFileSync(new URL("../drizzle/0001_reveal_and_prepared_media.sql", import.meta.url), "utf8"));
  applyMigration(sql, authorPointsMigration);
  applyMigration(sql, "0007_telegram_locations.sql");
  assert.deepEqual(sql.prepare("SELECT id,status,message_id FROM outbox").all().map((r) => ({ ...r })),
    [{ id: 1, status: "sent", message_id: 7 }]);
  assert.equal(sql.prepare("SELECT folder FROM rounds").get().folder, "old-folder");
  assert.equal(sql.prepare("SELECT author_points FROM rounds").get().author_points, null);
  sql.close();
});

test("preparer routes require their own secret", async () => {
  const { DB, sql } = database();
  const env = { DB, MEDIA_PREPARER_KEY: "correct", WEBHOOK_SECRET: "telegram-only" };
  for (const path of ["/media/queue", "/media/id/1", "/media/wake"]) {
    const response = await worker.fetch(new Request("https://bot.example" + path,
      { headers: { "X-ITMOGUESSR-Media-Key": "telegram-only" } }), env, {});
    assert.equal(response.status, 403);
  }
  sql.close();
});

test("Google scheduling wakes Render after a 502 and retries the video job", async (t) => {
  const { DB, sql } = database();
  t.after(() => sql.close());
  const key = "a".repeat(64);
  const requests = [];
  const statuses = [502, 200, 202];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([new URL(url).pathname, options.method ?? "GET",
      options.headers?.["X-ITMOGUESSR-Media-Key"]]);
    return new Response(null, { status: statuses.shift() });
  });
  const response = await worker.fetch(new Request("https://bot.example/schedule/check", {
    method: "POST", body: key, headers: { "Content-Length": String(key.length) },
  }), {
    DB, APPS_SCRIPT_SCHEDULE_DIGEST: createHash("sha256").update(key).digest("hex"),
    MEDIA_WORKER_URL: "https://media.example", MEDIA_PREPARER_KEY: "media-test",
  }, {});
  assert.equal(response.status, 200);
  assert.deepEqual(requests, [
    ["/run", "POST", "media-test"],
    ["/health", "GET", undefined],
    ["/run", "POST", "media-test"],
  ]);
  assert.ok(sql.prepare("SELECT value FROM settings WHERE key='last_apps_script_tick'").get());
});

test("Google schedule key is accepted only on the scheduling route", async () => {
  const { DB, sql } = database();
  const key = "a".repeat(64);
  const env = { DB, APPS_SCRIPT_SCHEDULE_DIGEST: createHash("sha256").update(key).digest("hex") };
  const post = (path, body) => worker.fetch(new Request("https://bot.example" + path, {
    method: "POST", body, headers: { "Content-Length": String(body.length), "X-ITMOGUESSR-Media-Key": body },
  }), env, {});
  assert.equal((await post("/schedule/check", "b".repeat(64))).status, 403);
  assert.equal((await post("/schedule/check", env.APPS_SCRIPT_SCHEDULE_DIGEST)).status, 403);
  assert.equal((await post("/media/wake", key)).status, 403);
  assert.equal((await post("/telegram", key)).status, 403);
  assert.equal((await post("/schedule/check", key)).status, 200);
  assert.ok(sql.prepare("SELECT value FROM settings WHERE key='last_apps_script_tick'").get().value);
  sql.close();
});

test("admin recovers a confirmed publication without reposting or extending its deadline", async (t) => {
  const { sql, DB } = database();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Recovery must not send a new post"); });
  const now = Math.floor(Date.now() / 1000);
  const insert = sql.prepare(`INSERT INTO rounds(${roundColumns}) VALUES(?,? ,?,0,0,'-1004332056270',?,NULL,'uncertain',?)`);
  insert.run(21, "evening:test", "file:recover", now + 3600, now);
  insert.run(22, "evening:expired", "file:expired", now - 1, now);
  const request = async (text, user = 42) => (await worker.fetch(new Request("https://bot.example/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({ update_id: 99, message: { from: { id: user }, chat: { type: "private", id: user }, text } }),
  }), { DB, WEBHOOK_SECRET: "secret", ADMIN_IDS: "42" }, { waitUntil() {} })).json();
  assert.match((await request("/recover 21", 43)).text, /администраторам/);
  assert.equal(sql.prepare("SELECT status FROM rounds WHERE id=21").get().status, "uncertain");
  assert.match((await request("/recover 22")).text, /не выполнено/);
  assert.match((await request("/recover 21")).text, /восстановлен/);
  assert.equal(sql.prepare("SELECT status FROM rounds WHERE id=21").get().status, "active");
  assert.equal(sql.prepare("SELECT ends FROM rounds WHERE id=21").get().ends, now + 3600);
  assert.match((await request("/start round_v2_21")).text, /Раунд #21/);
  assert.match((await request("/recover 21")).text, /не выполнено/);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM rounds").get().n, 2);
});

function uploadHarness(DB, extra = {}) {
  const env = { DB, BOT_TOKEN: "test-token", WEBHOOK_SECRET: "secret", ADMIN_IDS: "42,43", ...extra };
  const tasks = [];
  let messageId = 0;
  const send = async (data, user = 42, options = {}) => {
    const response = await worker.fetch(new Request("https://bot.example/telegram", {
      method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": options.secret || "secret" },
      body: JSON.stringify({ update_id: options.id || ++messageId, message: {
        message_id: options.id || messageId, chat: { type: options.chatType || "private", id: user },
        from: { id: user }, ...data,
      } }),
    }), env, { waitUntil: (task) => tasks.push(task) });
    const text = await response.text();
    try { return JSON.parse(text); } catch { return text; }
  };
  return { send, tasks, env };
}
const testVideo = (id = "panorama") => ({ video: {
  file_id: "telegram-file-" + id, file_unique_id: id, file_size: 52_428_800,
  duration: 25, width: 1920, height: 1080,
} });

test("owner repeatedly adds 50 MB panoramas, preserving coordinates and author score without Drive", async (t) => {
  const { sql, DB } = database();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Uploads must not download or call Drive"); });
  const { send } = uploadHarness(DB);
  assert.match((await send({ text: "/add@itmoguessr_bot" })).text, /включён/);
  assert.match((await send(testVideo())).text, /координаты/);
  assert.match((await send({ text: "55.7558, 37.6173" })).text, /очков/);
  assert.match((await send({ text: "2305" })).text, /Сохранено.*55.7558, 37.6173/);
  assert.equal(sql.prepare("SELECT author_points FROM locations").get().author_points, 2305);
  // A fresh handler invocation reads the persisted mode, not in-memory state.
  assert.match((await send(testVideo("second"))).text, /координаты/);
  await send({ location: { latitude: -10, longitude: 0 } });
  assert.match((await send({ text: "0" })).text, /0 \/ 5000/);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM locations").get().n, 2);
  await send({ text: "/done" });
  assert.equal(sql.prepare("SELECT step FROM location_upload_sessions").get().step, "off");
  sql.close();
});

test("upload mode rejects other admins, group chats and unauthorized webhook requests", async () => {
  const { sql, DB } = database();
  const { send } = uploadHarness(DB);
  assert.match((await send({ text: "/add" }, 43)).text, /только владельцу/);
  assert.equal(await send({ text: "/add" }, 42, { chatType: "group" }), "OK");
  assert.equal(await send({ text: "/add" }, 42, { secret: "wrong" }), "Forbidden");
  assert.equal(sql.prepare("SELECT count(*) AS n FROM location_upload_sessions").get().n, 0);
  const custom = uploadHarness(DB, { LOCATION_OWNER_ID: "44" });
  assert.match((await custom.send({ text: "/add" }, 42)).text, /только владельцу/);
  assert.match((await custom.send({ text: "/add" }, 44)).text, /включён/);
  sql.close();
});

test("upload validation, cancellation and retry never create duplicate or unfinished locations", async () => {
  const { sql, DB } = database();
  const { send } = uploadHarness(DB);
  await send({ text: "/add" });
  assert.match((await send({ document: { file_id: "doc", mime_type: "video/mp4" } })).text, /как видео/);
  assert.match((await send({ ...testVideo(), media_group_id: "album" })).text, /по одному/);
  await send(testVideo());
  const replayId = sql.prepare("SELECT last_message FROM location_upload_sessions").get().last_message;
  assert.match((await send(testVideo(), 42, { id: replayId })).text, /уже обработано/);
  assert.equal(sql.prepare("SELECT step FROM location_upload_sessions").get().step, "coordinates");
  for (const value of ["91, 0", "0, 181", "hello"]) {
    assert.match((await send({ text: value })).text, /Не распознал/);
  }
  assert.match((await send({ location: { latitude: 0, longitude: 0, live_period: 60 } })).text, /Не распознал/);
  await send({ text: "0, 0" });
  for (const value of ["-1", "5001", "2.5", "hello"]) assert.match((await send({ text: value })).text, /Нужно целое/);
  const scoreId = sql.prepare("SELECT last_message FROM location_upload_sessions").get().last_message + 20;
  await Promise.all([send({ text: "5000" }, 42, { id: scoreId }), send({ text: "5000" }, 42, { id: scoreId })]);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM locations").get().n, 1);
  assert.match((await send(testVideo(), 42, { id: scoreId + 1 })).text, /уже есть/);
  await send(testVideo("cancelled"), 42, { id: scoreId + 2 });
  await send({ text: "/cancel" }, 42, { id: scoreId + 3 });
  assert.equal(sql.prepare("SELECT step FROM location_upload_sessions").get().step, "video");
  await send(testVideo("unfinished"), 42, { id: scoreId + 4 });
  await send({ text: "/done" }, 42, { id: scoreId + 5 });
  assert.equal(sql.prepare("SELECT count(*) AS n FROM locations").get().n, 1);
  sql.close();
});

test("Telegram locations publish once without Drive and retain author points for the leaderboard", async (t) => {
  const { sql, DB } = database();
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /^https:\/\/api.telegram.org\/bot/);
    const payload = JSON.parse(options.body);
    sent.push({ method: url.split("/").at(-1), ...payload });
    return Response.json({ ok: true, result: { message_id: 123 } });
  });
  const { send, tasks } = uploadHarness(DB);
  await send({ text: "/add" });
  await send(testVideo());
  await send({ text: "55.7558, 37.6173" });
  await send({ text: "3210" });
  await send({ text: "/done" });
  assert.match((await send({ text: "/inventory" })).text, /Готовы: 1/);
  await send({ text: "/next" });
  await Promise.all(tasks.splice(0));
  const video = sent.find((item) => item.method === "sendVideo");
  assert.equal(video.video, "telegram-file-panorama");
  assert.doesNotMatch(JSON.stringify(video), /55\.7558|37\.6173|3210/);
  assert.match(video.reply_markup.inline_keyboard[0][0].url, /round_v2_1/);
  const round = sql.prepare("SELECT * FROM rounds").get();
  assert.equal(round.status, "active");
  assert.equal(round.author_points, 3210);
  assert.equal(round.folder, "telegram:panorama");
  await send({ text: "/next" });
  await Promise.all(tasks.splice(0));
  assert.equal(sent.filter((item) => item.method === "sendVideo").length, 1);
  assert.match((await send({ text: "/inventory" })).text, /Готовы: 0/);
  await send({ text: "/close 1" });
  await Promise.all(tasks.splice(0));
  assert.ok(sent.some((item) => item.text?.includes("3210")));
  sql.close();
});

const moscowTime = (value) => Date.parse(value + "+03:00") / 1000;

test("upload week includes Sunday evening and changes at Monday midnight Moscow time", () => {
  const friday = remainingWeekSlots(moscowTime("2026-11-20T12:00:00"));
  assert.equal(friday.sunday, "2026-11-22");
  assert.equal(friday.slots.length, 6); // Friday's morning can still be published if missing.
  assert.equal(friday.slots.at(-1).key, "evening:2026-11-22");
  assert.equal(remainingWeekSlots(moscowTime("2026-11-20T19:00:00")).slots.length, 5);
  assert.equal(remainingWeekSlots(moscowTime("2026-11-22T19:00:00")).slots.length, 1);
  assert.equal(remainingWeekSlots(moscowTime("2026-11-22T23:59:59")).slots.length, 1);
  const monday = remainingWeekSlots(moscowTime("2026-11-23T00:00:00"));
  assert.equal(monday.sunday, "2026-11-29");
  assert.equal(monday.slots.length, 14);
  assert.equal(monday.slots[0].key, "morning:2026-11-23");
  assert.equal(remainingWeekSlots(moscowTime("2026-12-31T23:00:00")).sunday, "2027-01-03");
});

test("weekly stock subtracts reserved scheduled rounds and counts each unused point once", async () => {
  const { sql, DB } = database();
  const now = moscowTime("2026-11-20T12:00:00");
  const insertRound = sql.prepare(`INSERT INTO rounds(${roundColumns}) VALUES(?,?,?,0,0,'@club',?,NULL,?,?)`);
  insertRound.run(1, "morning:2026-11-20", "used", now + 100, "active", now);
  insertRound.run(2, "evening:2026-11-20", "reserved", now + 100, "publishing", now);
  insertRound.run(3, "morning:2026-11-21", "rejected", now + 100, "failed", now);
  insertRound.run(4, "manual:4", "manual", now + 100, "closed", now);
  const insert = sql.prepare("INSERT INTO locations VALUES(?,?,?,?,5000,42,?)");
  insert.run("one", "file-one", 1, 1, now);
  insert.run("duplicate-point", "file-duplicate", 1, 1, now);
  insert.run("used-point", "file-used", 0, 0, now);
  insert.run("retired", "file-retired", 2, 2, now);
  sql.prepare("INSERT INTO retired_locations VALUES(?)").run("telegram:retired");
  const coverage = await weekCoverage({ DB }, now);
  assert.deepEqual(coverage, { sunday: "2026-11-22", remaining: 4, ready: 1, missing: 3, checked: true });
  sql.close();
});

test("every saved video updates the Sunday deficit and the last one confirms coverage", async (t) => {
  const { sql, DB } = database();
  const now = moscowTime("2026-11-20T19:30:00");
  t.mock.method(Date, "now", () => now * 1000);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Telegram stock needs no external calls"); });
  const { send } = uploadHarness(DB);
  await send({ text: "/add" });
  for (let i = 1; i <= 5; i++) {
    await send(testVideo("week-" + i));
    await send({ text: `${i}, 10` });
    const result = (await send({ text: "2305" })).text;
    assert.match(result, /воскресенья \(22\.11\).*20:00 МСК/);
    if (i < 5) assert.ok(result.includes(`Осталось загрузить видео: ${5 - i}.`));
    else assert.match(result, /всё закрыто ✅/);
  }
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM locations").get().n, 5);
  assert.equal(sql.prepare("SELECT step FROM location_upload_sessions").get().step, "video");
  sql.close();
});

test("Sunday evening already published needs no extra videos; Monday starts a fresh week", async (t) => {
  const { sql, DB } = database();
  const now = moscowTime("2026-11-22T20:30:00");
  sql.prepare(`INSERT INTO rounds(${roundColumns}) VALUES(1,'evening:2026-11-22','last',1,1,'@club',?,NULL,'active',?)`).run(now + 45000, now);
  t.mock.method(Date, "now", () => now * 1000);
  assert.match(await weekCoverageText({ DB }), /всё закрыто/);
  const monday = await weekCoverage({ DB }, moscowTime("2026-11-23T00:00:00"));
  assert.equal(monday.remaining, 14);
  assert.equal(monday.missing, 14);
  sql.close();
});

test("weekly stock merges Drive pages, prepared media and Telegram without counting duplicate or pending points", async (t) => {
  const { sql, DB } = database();
  const now = moscowTime("2026-11-20T12:00:00");
  t.mock.method(Date, "now", () => now * 1000);
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pem = "-----BEGIN PRIVATE KEY-----\n" + Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64") + "\n-----END PRIVATE KEY-----";
  const file = (id, name, mimeType = "video/mp4", size = "5000000") => ({ id, name, mimeType, size, version: "1", capabilities: { canDownload: true } });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const api = new URL(url);
    calls.push(api);
    if (api.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "stock-token", expires_in: 3600 });
    assert.equal(api.hostname, "www.googleapis.com");
    return Response.json(api.searchParams.get("pageToken") ? { files: [
      file("prepared", "4, 4.mov", "video/quicktime", "100000000"),
      file("ready", "5, 5.mp4"),
    ] } : { nextPageToken: "next", files: [
      file("duplicate", "1, 1.mp4"), file("pending", "2, 2.mov", "video/quicktime"),
      file("photo", "3, 3.png", "image/png"), file("used", "0, 0.mp4"),
    ] });
  });
  sql.prepare(`INSERT INTO rounds(${roundColumns}) VALUES(1,'morning:2026-11-20','already',0,0,'@club',?,NULL,'active',?)`).run(now + 100, now);
  sql.prepare("INSERT INTO locations VALUES('telegram','file',1,1,3000,42,?)").run(now);
  sql.prepare("INSERT INTO prepared_media VALUES('prepared','1','key',5000000,1920,1080,25,?)").run(now);
  const result = await weekCoverage({ DB, DRIVE_ROOT: "stock-root", DRIVE_SERVICE_ACCOUNT: JSON.stringify({
    type: "service_account", client_email: "test@example.test", private_key: pem,
  }) }, now);
  assert.deepEqual(result, { sunday: "2026-11-22", remaining: 5, ready: 4, missing: 1, checked: true });
  assert.equal(calls.filter((api) => api.hostname === "www.googleapis.com").length, 2);
  sql.close();
});

test("a failed Drive check never loses a saved video or presents its deficit as a complete inventory", async (t) => {
  const { sql, DB } = database();
  t.mock.method(Date, "now", () => moscowTime("2026-11-20T19:30:00") * 1000);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Drive is offline"); });
  const { send } = uploadHarness(DB, { DRIVE_SERVICE_ACCOUNT: "{}" });
  await send({ text: "/add" });
  await send(testVideo());
  await send({ text: "1, 1" });
  const result = (await send({ text: "2305" })).text;
  assert.match(result, /Сохранено в locations/);
  assert.match(result, /Без учёта непроверенной части Google Drive.*4/);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM locations").get().n, 1);
  assert.equal(sql.prepare("SELECT step FROM location_upload_sessions").get().step, "video");
  sql.close();
});
