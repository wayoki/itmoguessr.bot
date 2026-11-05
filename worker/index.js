const game = {
  bot: "itmoguessr_bot",
  chat: "@swidfkjew",
  drive: "1rlP26NNEgdsHkv1n1QGo9SAkaT6aCady",
  timezone: "Europe/Moscow",
  manualMinutes: 120,
  slots: [
    { name: "morning", publish: "10:00", reveal: "19:00" },
    { name: "evening", publish: "20:00", reveal: "09:00" },
  ],
};
const folderMime = "application/vnd.google-apps.folder";
const mediaTypes = {
  "image/jpeg": ["sendPhoto", "photo", "jpg", 10_000_000],
  "image/png": ["sendPhoto", "photo", "png", 10_000_000],
  "video/mp4": ["sendVideo", "video", "mp4", 50_000_000],
  "image/gif": ["sendAnimation", "animation", "gif", 50_000_000],
};
const encode = new TextEncoder();
const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: game.timezone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const timeLabel = new Intl.DateTimeFormat("ru-RU", {
  timeZone: game.timezone, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit",
});
const clock = () => Math.floor(Date.now() / 1000);
const chat = (env) => env.TELEGRAM_CHANNEL || game.chat;
const announcementChat = (env) => env.TELEGRAM_ANNOUNCEMENT_CHANNEL || chat(env);
const db = (env, query, ...params) => env.DB.prepare(query).bind(...params);
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function coordinates(name) {
  const decimal = "[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)";
  const match = String(name).match(new RegExp(`^\\s*(${decimal})\\s*,\\s*(${decimal})\\s*$`));
  if (!match) return null;
  const point = match.slice(1).map(Number);
  return Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180 ? point : null;
}

export function score(latitude, longitude, targetLatitude, targetLongitude) {
  const rad = (angle) => angle * Math.PI / 180;
  const h = Math.sin(rad(targetLatitude - latitude) / 2) ** 2 +
    Math.cos(rad(latitude)) * Math.cos(rad(targetLatitude)) *
    Math.sin(rad(targetLongitude - longitude) / 2) ** 2;
  const km = 12742.0176 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
  return { km, points: Math.round(5000 * Math.exp(-km / 1492.7)) };
}

function parts(unix) {
  return Object.fromEntries(dateParts.formatToParts(unix * 1000).map(({ type, value }) => [type, value]));
}

export function activeSlots(now) {
  const local = parts(now);
  const nominal = Date.UTC(+local.year, +local.month - 1, +local.day) / 1000;
  const minutes = (time) => +time.slice(0, 2) * 60 + +time.slice(3);
  const epoch = (day, time) => {
    const target = day + minutes(time) * 60;
    const seen = parts(target);
    const localAtTarget = Date.UTC(+seen.year, +seen.month - 1, +seen.day, +seen.hour, +seen.minute) / 1000;
    return target - (localAtTarget - target);
  };
  return [nominal - 86400, nominal].flatMap((day) =>
    game.slots.map(({ name, publish, reveal }) => ({
      key: `${name}:${new Date(day * 1000).toISOString().slice(0, 10)}`,
      start: epoch(day, publish), end: epoch(day + (reveal < publish ? 86400 : 0), reveal),
    })).filter(({ start, end }) => start <= now && now < end),
  );
}

class ApiFailure extends Error {
  constructor(service, status, retryAfter) {
    super(`${service} HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

let googleToken;
async function driveToken(env) {
  if (!env.DRIVE_SERVICE_ACCOUNT) throw new Error("Drive service account is missing");
  if (googleToken?.expires > clock() + 60) return googleToken.value;
  const account = JSON.parse(env.DRIVE_SERVICE_ACCOUNT);
  if (account.type !== "service_account" || !account.client_email || !account.private_key) {
    throw new Error("Invalid service account configuration");
  }
  const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const payload = (object) => base64url(encode.encode(JSON.stringify(object)));
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const now = clock();
  const jwt = payload({ alg: "RS256", typ: "JWT" }) + "." + payload({
    iss: account.client_email, aud: tokenUrl, iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/drive.readonly",
  });
  const pem = account.private_key.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encode.encode(jwt));
  const response = await fetch(tokenUrl, {
    method: "POST", body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt + "." + base64url(new Uint8Array(signature)),
    }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new ApiFailure("Google OAuth", response.status);
  const result = await response.json();
  googleToken = { expires: now + result.expires_in, value: result.access_token };
  return googleToken.value;
}

async function driveFetch(env, path, parameters) {
  const token = await driveToken(env);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files${path}?${new URLSearchParams(parameters)}`, {
    headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiFailure("Google Drive", response.status);
  }
  return response;
}

async function chooseLocation(env) {
  const root = env.DRIVE_ROOT || game.drive;
  const used = new Set((await db(env, "SELECT folder FROM rounds WHERE status<>'failed'").all()).results.map((r) => r.folder));
  const stored = await db(env, "SELECT value FROM settings WHERE key='drive_cursor'").first("value");
  const cursor = stored ? JSON.parse(stored) : { page: "", offset: 0 };
  const driveId = (id) => String(id).replace(/[^\w-]/g, "");
  const query = (id, extra = "") => `'${driveId(id)}' in parents and trashed=false${extra}`;
  let page;
  try {
    page = await (await driveFetch(env, "", {
      q: query(root, ` and mimeType='${folderMime}'`), orderBy: "name", pageSize: "50",
      fields: "nextPageToken,files(id,name)", ...(cursor.page ? { pageToken: cursor.page } : {}),
    })).json();
  } catch (error) {
    if (cursor.page && error instanceof ApiFailure && error.status === 400) await saveCursor(env, "", 0);
    throw error;
  }
  const { files = [] } = page;
  // Bound the number of Drive requests per tick. Continue at the next folder on the next tick.
  const stop = Math.min(files.length, cursor.offset + 12);
  for (let i = cursor.offset; i < stop; i++) {
    const folder = files[i];
    const point = coordinates(folder.name);
    if (used.has(folder.id) || !point) continue;
    const response = await driveFetch(env, "", {
      q: query(folder.id, " and (" + Object.keys(mediaTypes).map((m) => `mimeType='${m}'`).join(" or ") + ")"),
      fields: "nextPageToken,files(id,mimeType,size,capabilities(canDownload))", pageSize: "2",
    });
    const inner = await response.json();
    const media = inner.files?.[0];
    if (inner.nextPageToken || inner.files?.length !== 1 || !media.capabilities?.canDownload) continue;
    const size = Number(media.size);
    const format = mediaTypes[media.mimeType];
    if (!format || !Number.isSafeInteger(size) || size < 1 || size > format[3]) continue;
    return { folder: folder.id, point, media, size, format, cursor: { page: cursor.page, offset: i } };
  }
  const done = stop === files.length && !page.nextPageToken;
  await saveCursor(env, stop < files.length ? cursor.page : page.nextPageToken || "", stop < files.length ? stop : 0);
  return { done };
}

function saveCursor(env, page, offset) {
  return db(env, "INSERT INTO settings VALUES ('drive_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    JSON.stringify({ page, offset })).run();
}

async function telegram(env, method, body, contentType = "application/json") {
  if (!env.BOT_TOKEN) throw new Error("Missing Telegram token");
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST", body: contentType === "application/json" ? JSON.stringify(body) : body,
      headers: { "Content-Type": contentType }, signal: AbortSignal.timeout(55000),
    });
  } catch {
    // Fetch errors can contain the token-bearing URL. Keep them out of logs.
    throw new Error("Telegram network error");
  }
  const result = await response.json();
  if (!result.ok) throw new ApiFailure("Telegram", result.error_code || response.status, result.parameters?.retry_after);
  return result.result;
}

export function multipart(location, round) {
  const [, field, extension] = location.format;
  const boundary = `itmoguessr-${crypto.randomUUID()}`;
  const fields = {
    chat_id: round.chat, caption: `Раунд #${round.id}\nКуда нас занесло? Приём до ${timeLabel.format(round.ends * 1000)} МСК.`,
    reply_markup: JSON.stringify({ inline_keyboard: [[{
      text: "Сделать предположение", url: `https://t.me/${game.bot}?start=round_${round.id}`,
    }]] }),
  };
  if (field === "video") fields.supports_streaming = "true";
  const header = encode.encode(Object.entries(fields).map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") +
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="round-${round.id}.${extension}"\r\n` +
    `Content-Type: ${location.media.mimeType}\r\n\r\n`);
  const footer = encode.encode(`\r\n--${boundary}--\r\n`);
  return { boundary, header, footer };
}

async function upload(env, location, round, source) {
  const { boundary, header, footer } = multipart(location, round);
  const stream = new FixedLengthStream(header.byteLength + location.size + footer.byteLength);
  const write = async (part) => {
    const writer = stream.writable.getWriter();
    try { await writer.write(part); } finally { writer.releaseLock(); }
  };
  const pipe = async () => {
    try {
      await write(header);
      await source.pipeTo(stream.writable, { preventClose: true });
      await write(footer);
      await stream.writable.close();
    } catch (error) {
      await stream.writable.abort().catch(() => {});
      throw error;
    }
  };
  const [result] = await Promise.all([
    telegram(env, location.format[0], stream.readable, `multipart/form-data; boundary=${boundary}`), pipe(),
  ]);
  return result;
}

async function publish(env, slot, end) {
  const saved = await db(env, "SELECT id,status FROM rounds WHERE slot=?", slot).first();
  if (saved && saved.status !== "failed") return null;
  const location = await chooseLocation(env);
  if (!location.media) return location.done ? "Пока нет подходящих локаций." : "Поиск продолжается в следующем проходе.";
  const source = await driveFetch(env, "/" + encodeURIComponent(location.media.id), { alt: "media", supportsAllDrives: "true" });
  let round;
  try {
    const now = clock();
    if (now >= end) return null;
    round = await db(env, `INSERT INTO rounds(slot,folder,latitude,longitude,chat,ends,status,updated)
      VALUES(?,?,?,?,?,?,'publishing',?) ON CONFLICT DO NOTHING RETURNING *`,
    slot, location.folder, ...location.point, chat(env), end, now).first();
    if (!round && saved?.status === "failed") {
      round = await db(env, `UPDATE rounds SET folder=?,latitude=?,longitude=?,chat=?,ends=?,status='publishing',updated=?
        WHERE slot=? AND status='failed' AND NOT EXISTS(SELECT 1 FROM rounds WHERE folder=? AND status<>'failed') RETURNING *`,
      location.folder, ...location.point, chat(env), end, now, slot, location.folder).first();
    }
    if (!round) return null;

    let message;
    try {
      message = await upload(env, location, round, source.body);
    } catch (error) {
      const rejected = error instanceof ApiFailure && error.status >= 400 && error.status < 500;
      await db(env, "UPDATE rounds SET status=?,updated=? WHERE id=?",
        rejected ? "failed" : "uncertain", clock(), round.id).run();
      if (rejected && [400, 413].includes(error.status)) {
        await saveCursor(env, location.cursor.page, location.cursor.offset + 1);
      }
      throw error;
    }
    await db(env, "UPDATE rounds SET status='active',message_id=?,updated=? WHERE id=? AND status='publishing'",
      message.message_id, clock(), round.id).run();
    await saveCursor(env, location.cursor.page, location.cursor.offset + 1);
    return `Раунд #${round.id} опубликован.`;
  } finally {
    if (!source.body?.locked) await source.body?.cancel().catch(() => {});
  }
}

async function flush(env, budget = 6) {
  for (let i = 0; i < budget; i++) {
    const item = await db(env, `UPDATE outbox SET status='sending',updated=?
      WHERE id=(SELECT id FROM outbox WHERE status='pending' AND updated<=? ORDER BY id LIMIT 1)
      RETURNING *`, clock(), clock()).first();
    if (!item) return;
    const row = await db(env, `SELECT r.latitude,r.longitude,g.latitude AS guess_lat,g.longitude AS guess_lon,g.name,
      (SELECT COUNT(*) FROM guesses WHERE round=r.id) AS participants
      FROM rounds r LEFT JOIN guesses g ON g.round=r.id AND g.user=? WHERE r.id=?`, item.user, item.round).first();
    let text;
    if (item.kind === "guess") {
      text = `<a href="tg://user?id=${item.user}">${escapeHtml(row.name)}</a> сделал предположение в раунде #${item.round}`;
    } else {
      const coords = `${row.latitude}, ${row.longitude}`;
      const maps = `https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(coords)}`;
      text = `Раунд #${item.round} завершён.\nПравильная точка: ${coords}\n`;
      if (item.kind === "reveal") {
        text += `Участников: ${row.participants}\n`;
      } else {
        const { km, points } = score(row.guess_lat, row.guess_lon, row.latitude, row.longitude);
        await db(env, "UPDATE guesses SET distance=?,points=? WHERE round=? AND user=?", km, points, item.round, item.user).run();
        text += `Расстояние: ${km.toFixed(2)} км\nОчки: ${points} из 5000\n`;
      }
      text += `<a href="${maps}">Открыть Google Maps</a>`;
    }

    let message;
    try {
      message = await telegram(env, "sendMessage", { chat_id: item.chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
      const limited = error instanceof ApiFailure && error.status === 429;
      const rejected = error instanceof ApiFailure && error.status >= 400 && error.status < 500;
      await db(env, "UPDATE outbox SET status=?,updated=? WHERE id=?",
        limited ? "pending" : rejected ? "failed" : "uncertain", clock() + (limited ? (error.retryAfter || 5) + 1 : 0), item.id).run();
      console.warn("Notification delivery", item.kind, item.round, error instanceof ApiFailure ? error.message : "unconfirmed");
      if (limited) return;
      continue;
    }
    await db(env, "UPDATE outbox SET status='sent',message_id=?,updated=? WHERE id=?", message.message_id, clock(), item.id).run();
  }
}

async function tick(env) {
  const now = clock();
  await env.DB.batch([
    db(env, "UPDATE rounds SET status='uncertain' WHERE status='publishing' AND updated<?", now - 180),
    db(env, "UPDATE outbox SET status='uncertain' WHERE status='sending' AND updated<?", now - 180),
    db(env, "UPDATE rounds SET status='closed',updated=? WHERE status='active' AND ends<=?", now, now),
  ]);
  await flush(env);
  const paused = await db(env, "SELECT value FROM settings WHERE key='paused'").first("value");
  if (env.SCHEDULE_ENABLED === "true" && paused !== "1") {
    for (const slot of activeSlots(now)) await publish(env, slot.key, slot.end);
  }
}

function reply(message, text) {
  return Response.json({ method: "sendMessage", chat_id: message.chat.id, text });
}

const okay = () => new Response("OK");
const expired = "Приём ответов в этом раунде закрыт.";
const duplicate = "Ты уже использовал попытку в этом раунде.";
const validId = (value) => /^\d{1,15}$/.test(value) && Number(value) > 0;
const logFailure = (label) => (error) => {
  console.warn(label, error instanceof ApiFailure ? error.message : error.name || "Error");
};

async function verifyDrive(env) {
  const root = env.DRIVE_ROOT || game.drive;
  const meta = await (await driveFetch(env, "/" + encodeURIComponent(root), {
    fields: "mimeType,trashed", supportsAllDrives: "true",
  })).json();
  if (meta.trashed || meta.mimeType !== folderMime) throw new Error("Drive root is not a folder");
}

async function admin(env, ctx, message, command, args, updateId) {
  if (!String(env.ADMIN_IDS || "").split(/[,\s]+/).includes(String(message.from.id))) {
    return reply(message, "Эта команда доступна администраторам.");
  }
  switch (command) {
    case "/status": {
      const now = clock();
      const active = (await db(env, "SELECT id,ends FROM rounds WHERE status='active' AND ends>? ORDER BY ends", now).all()).results;
      const counts = (await db(env, "SELECT status,COUNT(*) AS count FROM outbox WHERE status<>'sent' GROUP BY status").all()).results;
      const paused = await db(env, "SELECT value FROM settings WHERE key='paused'").first("value");
      const publication = await db(env, "SELECT COUNT(*) AS n FROM rounds WHERE status='uncertain'").first("n");
      return reply(message, [
        `Расписание: ${env.SCHEDULE_ENABLED !== "true" ? "выключено" : paused === "1" ? "на паузе" : "включено"}.`,
        ...active.map((round) => `Раунд #${round.id} до ${timeLabel.format(round.ends * 1000)} МСК.`),
        ...(!active.length ? ["Активных раундов нет."] : []),
        `Публикаций с неизвестным исходом: ${publication}.`,
        ...counts.map(({ status, count }) => `Уведомления (${status}): ${count}.`),
      ].join("\n"));
    }
    case "/sync": {
      try {
        await verifyDrive(env);
        await saveCursor(env, "", 0);
        const location = await chooseLocation(env);
        return reply(message, location.media ? "Google Drive доступен. Найдена новая локация." :
          location.done ? "Google Drive доступен. Подходящих новых локаций в этом проходе нет." :
            "Google Drive доступен. Поиск продолжится со следующей папки.");
      } catch (error) {
        logFailure("Drive sync")(error);
        const detail = error instanceof ApiFailure ? ` (${error.message})` : "";
        return reply(message, `Не удалось прочитать Google Drive${detail}. Проверь доступ сервисного аккаунта к папке.`);
      }
    }
    case "/next": {
      const run = async () => {
        let summary;
        try {
          await verifyDrive(env);
          summary = await publish(env, `manual:${updateId}`, clock() + game.manualMinutes * 60);
        } catch (error) {
          logFailure("Manual publication")(error);
          summary = error instanceof ApiFailure ? `Публикация не удалась (${error.message}).` : "Публикация не подтверждена. Проверь /status.";
        }
        if (summary) await telegram(env, "sendMessage", { chat_id: message.chat.id, text: summary });
      };
      ctx.waitUntil(run().catch(logFailure("Manual publication reply")));
      return reply(message, "Проверяю локации и запускаю раунд.");
    }
    case "/close": {
      if (!validId(args)) return reply(message, "Укажи номер раунда, например /close 1.");
      const closed = await db(env, "UPDATE rounds SET status='closed',updated=? WHERE id=? AND status='active' RETURNING id",
        clock(), Number(args)).first();
      if (closed) ctx.waitUntil(flush(env).catch(logFailure("Round results")));
      return reply(message, closed ? `Раунд #${args} закрыт.` : "Раунд не найден или уже закрыт.");
    }
    case "/pause":
    case "/resume": {
      await db(env, "INSERT INTO settings VALUES ('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        command === "/pause" ? "1" : "0").run();
      return reply(message, command === "/pause" ? "Автоматические публикации приостановлены." : "Пауза снята.");
    }
    default:
      return okay();
  }
}

async function webhook(env, ctx, request) {
  if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  let update;
  try { update = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const message = update.message;
  if (message?.chat?.type !== "private" || !Number.isSafeInteger(message.from?.id)) return okay();
  const user = message.from.id;
  const [raw, args = ""] = (message.text || "").trim().split(/\s+/, 2);
  const command = raw.split("@")[0];

  if (command === "/start") {
    if (!args) return reply(message, `Открой раунд по кнопке «Сделать предположение».\n\nТвой Telegram ID: ${user}`);
    const id = args.startsWith("round_") && validId(args.slice(6)) ? Number(args.slice(6)) : 0;
    const round = await db(env, "SELECT * FROM rounds WHERE id=?", id).first();
    if (!round) {
      await db(env, "DELETE FROM selected WHERE user=?", user).run();
      return reply(message, expired);
    }
    await db(env, "INSERT INTO selected VALUES(?,?) ON CONFLICT(user) DO UPDATE SET round=excluded.round", user, id).run();
    if (round.status !== "active" || clock() >= round.ends) return reply(message, expired);
    if (await db(env, "SELECT 1 FROM guesses WHERE round=? AND user=?", id, user).first()) return reply(message, duplicate);
    return reply(message, `Раунд #${id}. Открой «Вложения → Геопозиция», выбери точку на карте и отправь её сюда.`);
  }
  if (command) return admin(env, ctx, message, command, args, update.update_id);

  const point = message.location;
  if (!point) return okay();
  if (point.live_period || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
    return reply(message, "Отправь выбранную точку на карте как обычную геопозицию.");
  }
  const selected = await db(env, "SELECT round FROM selected WHERE user=?", user).first("round");
  if (!selected) return reply(message, "Сначала открой раунд по кнопке в канале.");
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  const now = clock();
  const stored = await db(env, `INSERT INTO guesses(round,user,name,latitude,longitude,announcement,submitted)
    SELECT id,?,?,?,?,?,? FROM rounds WHERE id=? AND status='active' AND ends>?
    ON CONFLICT(round,user) DO NOTHING RETURNING round`,
  user, name, point.latitude, point.longitude, announcementChat(env), now, selected, now).first();
  if (!stored) {
    const active = await db(env, "SELECT 1 FROM rounds WHERE id=? AND status='active' AND ends>?", selected, now).first();
    return reply(message, active ? duplicate : expired);
  }
  ctx.waitUntil(flush(env, 1).catch(logFailure("Guess notice")));
  return reply(message, "Твоё предположение принято! Результаты появятся после завершения раунда");
}

async function mcp(env, request) {
  let rpc;
  try { rpc = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const respond = (result) => Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  if (rpc.method === "server/discover") return respond({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
  if (rpc.method === "tools/list") return respond({ tools: [{
    name: "run_training_schedule",
    description: "Run the ITMOGUESSR training bot maintenance and due round operations once.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  }] });
  if (rpc.method === "tools/call" && rpc.params?.name === "run_training_schedule") {
    const caller = request.headers.get("oai-authenticated-user-email")?.toLowerCase();
    if (!env.SCHEDULER_EMAIL || caller !== env.SCHEDULER_EMAIL.toLowerCase()) {
      return respond({ isError: true, content: [{ type: "text", text: "Access denied." }] });
    }
    try {
      await tick(env);
      return respond({ content: [{ type: "text", text: "Проверка расписания завершена." }] });
    } catch (error) {
      logFailure("Scheduled run")(error);
      return respond({ isError: true, content: [{ type: "text", text: "Проверка расписания завершилась ошибкой." }] });
    }
  }
  return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      await db(env, "SELECT key FROM settings LIMIT 1").first();
      return Response.json({ ready: true, driveConfigured: Boolean(env.DRIVE_SERVICE_ACCOUNT) });
    }
    if (request.method === "POST" && path === "/telegram") return webhook(env, ctx, request);
    if (request.method === "POST" && path === "/mcp") return mcp(env, request);
    return new Response("Not found", { status: 404 });
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
