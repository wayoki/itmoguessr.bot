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
const roundLinkPrefix = "round_v2_";
const mediaTypes = {
  "image/jpeg": ["sendPhoto", "photo", "jpg", 10_000_000],
  "image/png": ["sendPhoto", "photo", "png", 10_000_000],
  "video/mp4": ["sendVideo", "video", "mp4", 50_000_000],
  "image/gif": ["sendAnimation", "animation", "gif", 50_000_000],
};
const convertibleVideo = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]);
const sourceTypes = [...new Set([...Object.keys(mediaTypes), ...convertibleVideo])];
const mediaQuery = sourceTypes.map((type) => `mimeType='${type}'`).join(" or ");
const maxSourceBytes = 1_000_000_000;
const driveFields = "nextPageToken,files(id,name,mimeType,size,version,parents,capabilities(canDownload),videoMediaMetadata(width,height,durationMillis))";
const encode = new TextEncoder();
const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: game.timezone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const timeLabel = new Intl.DateTimeFormat("ru-RU", {
  timeZone: game.timezone, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit",
});
const pointWord = { one: "очко", few: "очка", many: "очков", other: "очков" };
const pointPlural = new Intl.PluralRules("ru");
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

export function filenameCoordinates(name) {
  const stem = name.replace(/\.(mp4|mov|webm|mkv|jpe?g|png|gif)$/i, "").replace(/__telegram$/i, "").trim();
  return coordinates(stem.includes(",") ? stem : stem.replace(/\s+/, ","));
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

async function driveFetch(env, path, parameters, timeout = 55000) {
  const token = await driveToken(env);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files${path}?${new URLSearchParams(parameters)}`, {
    headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiFailure("Google Drive", response.status);
  }
  return response;
}

const folderQuery = (id, filter) => `'${id}' in parents and trashed=false and (${filter})`;
const driveId = (value) => /^[\w-]+$/.test(value);

function classify(media, prepared) {
  const size = Number(media.size);
  if (!media.capabilities?.canDownload || !Number.isSafeInteger(size) || size < 1) return null;
  const format = mediaTypes[media.mimeType];
  if (format && size <= format[3]) return { media, format, size };
  const ready = prepared.get(`${media.id}:${media.version}`);
  if (ready) return {
    media: { ...media, mimeType: "video/mp4", videoMediaMetadata: {
      width: ready.width, height: ready.height, durationMillis: ready.duration * 1000,
    } },
    format: mediaTypes["video/mp4"], size: ready.size, objectKey: ready.object_key,
  };
  if (convertibleVideo.has(media.mimeType) && media.version && size <= maxSourceBytes) {
    return { media, size, needsPreparation: true };
  }
  return null;
}

async function scanLocations(env, cursor, limit) {
  const root = env.DRIVE_ROOT || game.drive;
  if (!driveId(root)) throw new Error("Invalid Drive root");
  const [usedRows, preparedRows, page] = await Promise.all([
    db(env, "SELECT folder FROM rounds WHERE status<>'failed' UNION SELECT folder FROM retired_locations").all(),
    db(env, "SELECT * FROM prepared_media").all(),
    driveFetch(env, "", {
      q: folderQuery(root, `mimeType='${folderMime}' or ${mediaQuery}`), orderBy: "name", pageSize: "50",
      fields: driveFields, ...(cursor.page ? { pageToken: cursor.page } : {}),
    }).then((response) => response.json()),
  ]);
  const used = new Set(usedRows.results.map((row) => row.folder));
  const prepared = new Map(preparedRows.results.map((row) => [`${row.file_id}:${row.source_version}`, row]));
  const files = page.files ?? [];
  const stop = Math.min(files.length, cursor.offset + limit);
  const locations = [];
  for (let i = cursor.offset; i < stop; i++) {
    const item = files[i];
    const isFolder = item.mimeType === folderMime;
    const locationKey = isFolder ? item.id : `file:${item.id}`;
    const point = isFolder ? coordinates(item.name) : filenameCoordinates(item.name);
    if (used.has(locationKey) || !point || !driveId(item.id)) continue;
    let available;
    if (isFolder) {
      const inner = await (await driveFetch(env, "", {
        q: folderQuery(item.id, mediaQuery), fields: driveFields, pageSize: "10",
      })).json();
      if (inner.nextPageToken) continue;
      const candidates = (inner.files ?? []).map((media) => classify(media, prepared)).filter(Boolean);
      const ready = candidates.filter((item) => !item.needsPreparation);
      if (ready.length === 1) [available] = ready;
      else if (!ready.length && candidates.length === 1) [available] = candidates;
    } else {
      available = classify(item, prepared);
    }
    if (available) locations.push({ ...available, folder: locationKey, point, cursor: { page: cursor.page, offset: i } });
  }
  const done = stop === files.length && !page.nextPageToken;
  const next = stop < files.length ? { page: cursor.page, offset: stop } : { page: page.nextPageToken || "", offset: 0 };
  return { locations, next, done };
}

async function chooseLocation(env) {
  const stored = await db(env, "SELECT value FROM settings WHERE key='drive_cursor_v2'").first("value");
  const cursor = stored ? JSON.parse(stored) : { page: "", offset: 0 };
  try {
    const { locations, next, done } = await scanLocations(env, cursor, 12);
    const ready = locations.find((location) => !location.needsPreparation);
    if (ready) return ready;
    await saveCursor(env, next.page, next.offset);
    return { done };
  } catch (error) {
    if (cursor.page && error instanceof ApiFailure && error.status === 400) await saveCursor(env, "", 0);
    throw error;
  }
}

function saveCursor(env, page, offset) {
  return db(env, "INSERT INTO settings VALUES ('drive_cursor_v2',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
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
  const deadline = timeLabel.formatToParts(round.ends * 1000)
    .map(({ type, value }) => type === "hour" ? String(Number(value)) : value).join("");
  const fields = {
    chat_id: round.chat, caption: `Раунд #${round.id} (до ${deadline} МСК)`,
    reply_markup: JSON.stringify({ inline_keyboard: [[{
      text: "Guess!", url: `https://t.me/${game.bot}?start=${roundLinkPrefix}${round.id}`,
    }]] }),
  };
  if (field === "video") {
    fields.supports_streaming = "true";
    const { width, height, durationMillis } = location.media.videoMediaMetadata ?? {};
    if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
      Object.assign(fields, { width, height });
    }
    const duration = Math.round(Number(durationMillis) / 1000);
    if (Number.isSafeInteger(duration) && duration > 0) fields.duration = duration;
  }
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
  const source = location.objectKey
    ? await env.MEDIA.get(location.objectKey)
    : await driveFetch(env, "/" + encodeURIComponent(location.media.id), { alt: "media", supportsAllDrives: "true" });
  if (!source?.body) throw new Error("Media body is unavailable");
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

const validUsername = (username) => typeof username === "string" && /^[a-z0-9_]{1,32}$/i.test(username);
const mention = (user, name, username) => {
  const hasUsername = validUsername(username);
  const label = name?.trim() || (hasUsername ? "@" + username : "Игрок");
  const profile = hasUsername ? `https://t.me/${username}?profile` : `tg://user?id=${user}`;
  return `<a href="${profile}">${escapeHtml(label.slice(0, 80))}</a>`;
};
const googleMaps = (latitude, longitude) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;

export function leaderboard(round, players) {
  const top = players.map((player) => ({
    ...player, ...score(player.latitude, player.longitude, round.latitude, round.longitude),
  })).sort((a, b) => b.points - a.points || a.km - b.km || a.submitted - b.submitted || a.user - b.user).slice(0, 10);
  const heading = round.corrected ? `🛠 Исправление раунда #${round.id}` : `Раунд #${round.id} завершён.`;
  const lines = top.map((player, index) => {
    const line = `${index + 1}. ${mention(player.user, player.name, player.username)} — ${player.points}`;
    return index === 0 ? `<b>${line}</b>` : line;
  });
  return top.length ? [heading, "", ...lines].join("\n") : heading;
}

async function inventory(env) {
  const { locations, done } = await scanLocations(env, { page: "", offset: 0 }, 22);
  const videos = locations.filter((location) => convertibleVideo.has(location.media.mimeType));
  const pending = videos.filter((location) => location.needsPreparation).length;
  const suffix = done ? "" : "+";
  return `Остаток видео для новых раундов\nГотовы: ${videos.length - pending}${suffix}\nЖдут обработки: ${pending}${suffix}` +
    (done ? "" : "\nПоказано минимум по первой части очереди.");
}

async function delivery(env, item) {
  const chatId = item.kind === "inventory" ? String(env.ADMIN_IDS || "").split(/[,\s]+/).find(Boolean) : item.chat;
  if (item.kind === "inventory") {
    if (!chatId) return null;
    return { method: "sendMessage", body: { chat_id: chatId, text: await inventory(env) } };
  }
  if (item.kind === "result") return null;
  const row = await db(env, `SELECT r.id,r.latitude,r.longitude,g.name,g.username,g.points,
    g.latitude AS guess_latitude,g.longitude AS guess_longitude,
    EXISTS(SELECT 1 FROM settings WHERE key='correction:' || r.id) AS corrected
    FROM rounds r LEFT JOIN guesses g ON g.round=r.id AND g.user=? WHERE r.id=?`, item.user, item.round).first();
  const maps = googleMaps(row.latitude, row.longitude);
  if (item.kind === "location") {
    return { method: "sendLocation", body: {
      chat_id: chatId, latitude: row.latitude, longitude: row.longitude,
      reply_markup: { inline_keyboard: [[{ text: row.corrected ? "Исправленная точка в Google Maps" : "Открыть Google Maps", url: maps }]] },
    } };
  }

  let text;
  if (item.kind === "guess") {
    const name = mention(item.user, row.name, row.username);
    if (item.round < Number(env.PUBLIC_GUESS_SCORE_FROM_ROUND || 1)) {
      text = `${name} сделал guess в раунде #${item.round}`;
    } else {
      const points = row.points ?? score(row.guess_latitude, row.guess_longitude, row.latitude, row.longitude).points;
      text = `${name} набрал ${points} ${pointWord[pointPlural.select(points)]} в раунде #${item.round}`;
    }
  } else {
    const players = (await db(env, "SELECT user,name,username,latitude,longitude,submitted FROM guesses WHERE round=?", item.round).all()).results;
    text = leaderboard(row, players);
  }
  return { method: "sendMessage", body: { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } } };
}

async function flush(env, budget = 10) {
  for (let i = 0; i < budget; i++) {
    const item = await db(env, `UPDATE outbox SET status='sending',updated=?
      WHERE id=(SELECT id FROM outbox WHERE status='pending' AND updated<=? ORDER BY id LIMIT 1)
      RETURNING *`, clock(), clock()).first();
    if (!item) return;
    let payload;
    try {
      payload = await delivery(env, item);
    } catch (error) {
      await db(env, "UPDATE outbox SET status='pending',updated=? WHERE id=?", clock() + 60, item.id).run();
      logFailure("Prepare notification")(error);
      continue;
    }
    let message;
    try {
      if (payload) message = await telegram(env, payload.method, payload.body);
    } catch (error) {
      const limited = error instanceof ApiFailure && error.status === 429;
      const rejected = error instanceof ApiFailure && error.status >= 400 && error.status < 500;
      await db(env, "UPDATE outbox SET status=?,updated=? WHERE id=?",
        limited ? "pending" : rejected ? "failed" : "uncertain", clock() + (limited ? (error.retryAfter || 5) + 1 : 0), item.id).run();
      console.warn("Notification delivery", item.kind, item.round, error instanceof ApiFailure ? error.message : "unconfirmed");
      if (limited) return;
      continue;
    }
    await db(env, "UPDATE outbox SET status='sent',message_id=?,updated=? WHERE id=?", message?.message_id ?? null, clock(), item.id).run();
  }
}

async function tick(env, source) {
  const now = clock();
  const recordTick = (key) => db(env, "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(now));
  await env.DB.batch([
    recordTick("last_tick"),
    ...(source === "apps_script" ? [recordTick("last_apps_script_tick")] : []),
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

export async function resetTestRounds(env) {
  const canReset = `EXISTS(SELECT 1 FROM settings WHERE key='paused' AND value='1')
    AND NOT EXISTS(SELECT 1 FROM settings WHERE key='club_launched')`;
  await env.DB.batch([
    db(env, `INSERT OR IGNORE INTO retired_locations SELECT folder FROM rounds WHERE status<>'failed' AND ${canReset}`),
    db(env, `DELETE FROM outbox WHERE ${canReset}`),
    db(env, `DELETE FROM selected WHERE ${canReset}`),
    db(env, `DELETE FROM guesses WHERE ${canReset}`),
    db(env, `DELETE FROM rounds WHERE ${canReset}`),
    db(env, `DELETE FROM settings WHERE (key='drive_cursor_v2' OR key LIKE 'correction:%') AND ${canReset}`),
    db(env, `INSERT INTO settings SELECT 'club_launched','1' WHERE ${canReset}`),
  ]);
  return Boolean(await db(env, "SELECT 1 FROM settings WHERE key='club_launched'").first());
}

async function admin(env, ctx, message, command, args, updateId) {
  if (!String(env.ADMIN_IDS || "").split(/[,\s]+/).includes(String(message.from.id))) {
    return reply(message, "Эта команда доступна администраторам.");
  }
  switch (command) {
    case "/reset_test_rounds": {
      if (!env.TELEGRAM_CHANNEL || env.TELEGRAM_CHANNEL === game.chat) {
        return reply(message, "Сначала укажи новую группу.");
      }
      const reset = await resetTestRounds(env);
      return reply(message, reset ? "Тестовые раунды и ответы очищены. Нумерация клубных раундов начинается с #1." :
        "Сначала поставь автоматические публикации на паузу.");
    }
    case "/status": {
      const now = clock();
      const active = (await db(env, "SELECT id,ends,message_id FROM rounds WHERE status='active' ORDER BY ends").all()).results;
      const counts = (await db(env, "SELECT status,COUNT(*) AS count FROM outbox WHERE status<>'sent' GROUP BY status").all()).results;
      const paused = await db(env, "SELECT value FROM settings WHERE key='paused'").first("value");
      const publication = await db(env, "SELECT COUNT(*) AS n FROM rounds WHERE status='uncertain'").first("n");
      const lastTick = await db(env, "SELECT value FROM settings WHERE key='last_tick'").first("value");
      const googleTick = await db(env, "SELECT value FROM settings WHERE key='last_apps_script_tick'").first("value");
      const lastClosed = await db(env, `SELECT r.id,
        (SELECT message_id FROM outbox WHERE round=r.id AND kind='reveal' AND status='sent') AS reveal_message
        FROM rounds r WHERE r.status='closed' ORDER BY r.ends DESC, r.id DESC LIMIT 1`).first();
      return reply(message, [
        `Расписание: ${env.SCHEDULE_ENABLED !== "true" ? "выключено" : paused === "1" ? "на паузе" : "включено"}.`,
        `Группа публикаций — ${chat(env)}.`,
        ...(lastTick ? [`Последняя проверка расписания — ${timeLabel.format(Number(lastTick) * 1000)} МСК.`] : []),
        ...(googleTick ? [`Последняя проверка из Google — ${timeLabel.format(Number(googleTick) * 1000)} МСК.`] : []),
        ...active.map((round) => round.ends <= now
          ? `Раунд #${round.id} ждёт раскрытия.`
          : `Раунд #${round.id} до ${timeLabel.format(round.ends * 1000)} МСК (сообщение #${round.message_id}).`),
        ...(!active.some((round) => round.ends > now) ? ["Активных раундов нет."] : []),
        ...(lastClosed ? [`Последний закрытый раунд #${lastClosed.id}. Таблица: ${lastClosed.reveal_message
          ? `сообщение #${lastClosed.reveal_message}` : "отправка не подтверждена"}.`] : []),
        `Публикаций с неизвестным исходом: ${publication}.`,
        ...counts.map(({ status, count }) => `Уведомления (${status}): ${count}.`),
      ].join("\n"));
    }
    case "/inventory": {
      try { return reply(message, await inventory(env)); }
      catch (error) {
        logFailure("Video inventory")(error);
        return reply(message, "Не удалось подсчитать остаток видео. Проверь Google Drive.");
      }
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
    case "/correct": {
      const match = args.match(/^(\d+)\s+(.+)$/);
      const point = match && coordinates(match[2]);
      if (!point || !validId(match[1])) return reply(message, "Формат: /correct N широта, долгота");
      const roundId = Number(match[1]);
      const updated = await db(env, `UPDATE rounds SET latitude=?,longitude=?,updated=?
        WHERE id=? AND status='closed' AND (latitude<>? OR longitude<>?)
          AND NOT EXISTS(SELECT 1 FROM outbox WHERE round=? AND status='sending')
        RETURNING id`, ...point, clock(), roundId, ...point, roundId).first();
      if (updated) {
        ctx.waitUntil(flush(env).catch(logFailure("Corrected round results")));
        return reply(message, `Правильная точка раунда #${roundId} исправлена. Отправляю пересчитанные результаты.`);
      }
      const existing = await db(env, "SELECT latitude,longitude,status FROM rounds WHERE id=?", roundId).first();
      if (existing?.status === "closed" && existing.latitude === point[0] && existing.longitude === point[1]) {
        return reply(message, `Эти координаты уже сохранены для раунда #${roundId}.`);
      }
      return reply(message, "Укажи закрытый раунд и дождись окончания рассылки.");
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
  const [raw, ...tokens] = (message.text || "").trim().split(/\s+/);
  const args = tokens.join(" ");
  const command = raw.split("@")[0];

  if (command === "/start") {
    if (!args) return reply(message, `Открой раунд по кнопке под постом в группе.\n\nТвой Telegram ID: ${user}`);
    const suffix = args.startsWith(roundLinkPrefix) ? args.slice(roundLinkPrefix.length) : "";
    const id = validId(suffix) ? Number(suffix) : 0;
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
  const round = await db(env, "SELECT r.* FROM selected s JOIN rounds r ON r.id=s.round WHERE s.user=?", user).first();
  if (!round) return reply(message, "Сначала открой раунд по кнопке в группе.");
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  const now = clock();
  if (round.status !== "active" || round.ends <= now) return reply(message, expired);
  const { km, points } = score(point.latitude, point.longitude, round.latitude, round.longitude);
  const stored = await db(env, `INSERT INTO guesses(round,user,name,latitude,longitude,announcement,submitted,username,distance,points)
    SELECT id,?,?,?,?,?,?,?,?,? FROM rounds WHERE id=? AND status='active' AND ends>?
    ON CONFLICT(round,user) DO NOTHING RETURNING round`,
  user, name, point.latitude, point.longitude, announcementChat(env), now,
    validUsername(message.from.username) ? message.from.username : null, km, points, round.id, now).first();
  if (!stored) {
    const active = await db(env, "SELECT 1 FROM rounds WHERE id=? AND status='active' AND ends>?", round.id, now).first();
    return reply(message, active ? duplicate : expired);
  }
  ctx.waitUntil(flush(env, 1).catch(logFailure("Guess notice")));
  return reply(message, `${points} / 5000`);
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

async function mediaMetadata(env, id, version) {
  const root = env.DRIVE_ROOT || game.drive;
  const get = async (fileId, fields) => {
    try {
      return await (await driveFetch(env, "/" + encodeURIComponent(fileId), { fields, supportsAllDrives: "true" })).json();
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) return null;
      throw error;
    }
  };
  const media = await get(id, "id,name,mimeType,size,version,parents,trashed,capabilities(canDownload)");
  if (!media || media.trashed || media.version !== version || !classify(media, new Map())?.needsPreparation) return null;
  if (media.parents?.includes(root)) return filenameCoordinates(media.name) ? media : null;
  const folderId = media.parents?.[0];
  if (!folderId || !driveId(folderId)) return null;
  const folder = await get(folderId, "name,mimeType,parents,trashed");
  return folder && !folder.trashed && folder.mimeType === folderMime && folder.parents?.includes(root) && coordinates(folder.name)
    ? media : null;
}

async function mediaAPI(request, env) {
  if (!env.MEDIA_PREPARER_KEY || request.headers.get("X-ITMOGUESSR-Media-Key") !== env.MEDIA_PREPARER_KEY) {
    return new Response("Forbidden", { status: 403 });
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/media/queue") {
    const page = url.searchParams.get("page") || "";
    const offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 50 || page.length > 2000) return new Response("Bad cursor", { status: 400 });
    const { locations, next, done } = await scanLocations(env, { page, offset }, 12);
    const items = locations.filter((item) => item.needsPreparation)
      .map(({ media }) => ({ id: media.id, version: media.version }));
    return Response.json({ items, next: done ? null : next });
  }
  if (request.method === "POST" && url.pathname === "/media/wake") {
    await tick(env);
    return okay();
  }
  const match = url.pathname.match(/^\/media\/([\w-]+)\/(\d+)$/);
  if (!match || !["GET", "PUT"].includes(request.method)) return new Response("Not found", { status: 404 });
  const [, id, version] = match;
  const media = await mediaMetadata(env, id, version);
  if (!media) return new Response("Not found", { status: 404 });
  if (request.method === "GET") {
    const response = await driveFetch(env, "/" + id, { alt: "media", supportsAllDrives: "true" }, 600000);
    return new Response(response.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
  }
  const size = Number(request.headers.get("Content-Length"));
  const width = Number(request.headers.get("X-Media-Width"));
  const height = Number(request.headers.get("X-Media-Height"));
  const duration = Number(request.headers.get("X-Media-Duration"));
  if (!request.body || ![size, width, height, duration].every((n) => Number.isSafeInteger(n) && n > 0) ||
      size > mediaTypes["video/mp4"][3] || width > 1920 || height > 1080) {
    return new Response("Bad media", { status: 400 });
  }
  const base = media.name.replace(/\.[^.]+$/, "").replace(/[\/\\]/g, "_").slice(0, 160);
  const key = `prepared/${id}/${version}/${base}__telegram.mp4`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: "video/mp4" } });
  await db(env, `INSERT INTO prepared_media VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(file_id,source_version) DO UPDATE SET
    object_key=excluded.object_key,size=excluded.size,width=excluded.width,height=excluded.height,duration=excluded.duration,updated=excluded.updated`,
  id, version, key, size, width, height, duration, clock()).run();
  return okay();
}

async function appsScriptSchedule(request, env) {
  const expected = env.APPS_SCRIPT_SCHEDULE_DIGEST;
  if (!/^[a-f0-9]{64}$/.test(expected ?? "") || request.headers.get("Content-Length") !== "64") {
    return new Response("Forbidden", { status: 403 });
  }
  const key = await request.text();
  if (!/^[a-f0-9]{64}$/.test(key)) return new Response("Forbidden", { status: 403 });
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encode.encode(key)));
  const actual = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let mismatch = 0;
  for (let index = 0; index < actual.length; index++) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (mismatch) return new Response("Forbidden", { status: 403 });
  await tick(env, "apps_script");
  return okay();
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
    if (request.method === "POST" && path === "/schedule/check") {
      try { return await appsScriptSchedule(request, env); }
      catch (error) {
        logFailure("Apps Script schedule")(error);
        return new Response("Schedule unavailable", { status: 503 });
      }
    }
    if (path.startsWith("/media/")) {
      try { return await mediaAPI(request, env); }
      catch (error) {
        logFailure("Media preparation")(error);
        return new Response("Preparation service unavailable", { status: 503 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
