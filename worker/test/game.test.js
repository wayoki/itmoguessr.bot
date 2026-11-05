import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker, { activeSlots, coordinates, multipart, score } from "../index.js";

function database() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../drizzle/0000_game.sql", import.meta.url), "utf8"));
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
    const result = multipart({ format: ["",field,extension], media: { mimeType: type }, point: [35.0116,135.7681] },
      { chat: "@swidfkjew", id: 4, ends: 1793923200 });
    const header = new TextDecoder().decode(result.header);
    assert.ok(header.includes(`name="${field}"; filename="round-4.${extension}"`));
    assert.ok(header.includes("https://t.me/itmoguessr_bot?start=round_4"));
    assert.ok(!header.includes("35.0116"));
  }
});

test("webhook enforces secret and accepts a single guess, then reveals once", async (t) => {
  const { sql, DB } = database();
  const sent = [];
  const tasks = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(url.endsWith("/sendMessage"));
    sent.push(JSON.parse(options.body));
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
  assert.equal(sent.length, 3);
  assert.match(sent.find(({ chat_id }) => chat_id === "42").text, /Очки: 5000/);
  assert.match(sent.find(({ text }) => text.includes("Участников")).text, /Участников: 1/);
  const maintenance = () => request("/mcp", { "oai-authenticated-user-email": "owner@example.test" },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_training_schedule" } });
  assert.equal((await (await maintenance()).json()).result.isError, undefined);
  assert.equal(sent.length, 3);
  assert.match((await (await tg(point)).json()).text, /приём ответов.*закрыт/i);
  assert.equal(sql.prepare("SELECT points FROM guesses").get().points, 5000);
  sql.close();
});
