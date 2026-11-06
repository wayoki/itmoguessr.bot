import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker, { activeSlots, coordinates, filenameCoordinates, leaderboard, multipart, score } from "../index.js";

function database() {
  const sql = new DatabaseSync(":memory:");
  for (const name of ["0000_game.sql", "0001_reveal_and_prepared_media.sql", "0002_round_corrections.sql"]) {
    sql.exec(readFileSync(new URL("../drizzle/" + name, import.meta.url), "utf8"));
  }
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
    batch: async (statements) => {
      sql.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
        sql.exec("COMMIT");
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
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

test("multipart uses Telegram-safe names, inline round ID and no answer coordinates", () => {
  for (const [field, type, extension] of [["photo","image/jpeg","jpg"], ["video","video/mp4","mp4"], ["animation","image/gif","gif"]]) {
    const result = multipart({ format: ["",field,extension], media: { mimeType: type, videoMediaMetadata: { width: 1920, height: 1080 } }, point: [35.0116,135.7681] },
      { chat: "@swidfkjew", id: 4, ends: 1793923200 });
    const header = new TextDecoder().decode(result.header);
    assert.ok(header.includes(`name="${field}"; filename="round-4.${extension}"`));
    assert.ok(header.includes("https://t.me/itmoguessr_bot?start=round_4"));
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
    update_id: 10, message: { from: { id: user, first_name: "<Игрок>" }, chat: { type: "private", id: user }, ...data },
  });
  const now = Math.floor(Date.now() / 1000);
  sql.prepare("INSERT INTO rounds VALUES(1,'test','drive-folder',48.8566,2.3522,'@swidfkjew',?,55,'active',?)").run(now + 3600, now);
  assert.equal((await tg({ text: "/start round_1" }, 42, "wrong")).status, 403);
  assert.match((await (await tg({ text: "/start round_1" })).json()).text, /Раунд #1/);
  const point = { location: { latitude: 48.8566, longitude: 2.3522 } };
  const results = await Promise.all([tg(point), tg(point)]);
  const replies = await Promise.all(results.map((result) => result.json()));
  assert.equal(replies.filter(({ text }) => text.includes("принято")).length, 1);
  assert.equal(replies.filter(({ text }) => text.includes("использовал")).length, 1);
  await Promise.all(tasks.splice(0));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /tg:\/\/user\?id=42/);
  assert.match(sent[0].text, /&lt;Игрок&gt;/);
  assert.ok(!sent[0].text.includes("48.8566"));

  assert.match((await (await tg({ text: "/close 1" }, 43)).json()).text, /администраторам/);
  assert.match((await (await tg({ text: "/close 1" })).json()).text, /закрыт/);
  await Promise.all(tasks.splice(0));
  assert.equal(sent.length, 4);
  assert.match(sent.find(({ chat_id }) => chat_id === "42").text, /Очки: 5000/);
  const map = sent.find(({ method }) => method === "sendLocation");
  assert.equal(map.latitude, 48.8566);
  assert.match(map.reply_markup.inline_keyboard[0][0].url, /^https:\/\/www.google.com\/maps/);
  const rank = sent.find(({ text }) => text?.includes("Участников"));
  assert.match(rank.text, /Участников: 1/);
  assert.match(rank.text, /🏆.*Победитель/);
  assert.match(rank.text, /1\. .*Игрок.*5000/);
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
  assert.equal(corrections.length, 3);
  assert.equal(corrections[0].latitude, 56.62567);
  assert.equal(corrections[0].longitude, 23.34348);
  assert.ok(corrections.slice(1).every(({ text }) => text.includes("Исправление раунда #1")));
  assert.notEqual(sql.prepare("SELECT points FROM guesses").get().points, 5000);
  assert.match((await (await tg({ text: "/correct 1 56.62567, 23.34348" })).json()).text, /уже сохранены/);
  await Promise.all(tasks.splice(0));
  assert.equal(sent.length, 7);
  sql.close();
});

test("manual MP4 round streams a private Drive file into Telegram once", async (t) => {
  const { sql, DB } = database();
  const calls = [];
  const background = [];
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
      if (api.pathname.endsWith("/fake-file")) {
        assert.equal(api.searchParams.get("alt"), "media");
        return new Response(fixture);
      }
      if (api.searchParams.get("q").startsWith("'demo-root'")) {
        return Response.json({ files: [{ id: "demo-folder", name: "35.0116, 135.7681", mimeType: "application/vnd.google-apps.folder" }] });
      }
      return Response.json({
        files: [{ id: "fake-file", mimeType: "video/mp4", size: String(fixture.length), capabilities: { canDownload: true } }],
      });
    }
    calls.push(api.pathname.split("/").at(-1));
    if (api.pathname.endsWith("/sendVideo")) {
      const media = await new Response(options.body).text();
      assert.match(media, /filename="round-1.mp4"/);
      assert.match(media, /test mp4 fixture/);
      assert.match(media, /round_1/);
      assert.ok(!media.includes("35.0116"));
    }
    return Response.json({ ok: true, result: { message_id: 321 } });
  });
  const env = {
    DB, BOT_TOKEN: "test-token", WEBHOOK_SECRET: "secret", ADMIN_IDS: "42", DRIVE_ROOT: "demo-root",
    DRIVE_SERVICE_ACCOUNT: JSON.stringify({ type: "service_account", client_email: "fake@example.test", private_key: pem }),
  };
  const ctx = { waitUntil: (promise) => background.push(promise) };
  const next = () => worker.fetch(new Request("https://bot.example/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({ update_id: 5, message: { chat: { type: "private", id: 42 }, from: { id: 42 }, text: "/next" } }),
  }), env, ctx);
  assert.match((await (await next()).json()).text, /запускаю раунд/);
  await Promise.all(background.splice(0));
  await next();
  await Promise.all(background.splice(0));
  assert.deepEqual(calls, ["sendVideo", "sendMessage"]);
  const round = sql.prepare("SELECT status,message_id FROM rounds WHERE id=1").get();
  assert.equal(round.status, "active");
  assert.equal(round.message_id, 321);
  sql.close();
});

test("leaderboard keeps ten players, highlights username and resolves equal scores by distance", () => {
  const players = Array.from({ length: 12 }, (_, i) => ({
    user: i + 1, username: i === 0 ? "first_player" : null, name: "<player>", latitude: i / 1e6,
    longitude: 0, submitted: 10 - i,
  })).reverse();
  const text = leaderboard({ id: 5, latitude: 0, longitude: 0 }, players);
  assert.match(text, /🏆 .*@first_player/);
  assert.match(text, /Участников: 12/);
  assert.equal(text.split("\n").filter((line) => /^\d+\./.test(line)).length, 10);
  assert.ok(!text.includes("<player>"));
});

test("migration preserves the old round and sent notifications", () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../drizzle/0000_game.sql", import.meta.url), "utf8"));
  sql.exec("INSERT INTO rounds VALUES(1,'old-slot','old-folder',40,20,'@old',30,3,'closed',31)");
  sql.exec("INSERT INTO outbox VALUES(1,1,0,'reveal','@old','sent',31,7)");
  sql.exec(readFileSync(new URL("../drizzle/0001_reveal_and_prepared_media.sql", import.meta.url), "utf8"));
  assert.deepEqual(sql.prepare("SELECT id,status,message_id FROM outbox").all().map((r) => ({ ...r })),
    [{ id: 1, status: "sent", message_id: 7 }]);
  assert.equal(sql.prepare("SELECT folder FROM rounds").get().folder, "old-folder");
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
