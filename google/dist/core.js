function createGoogleCore(platform) {
class Immediate {
  constructor(executor) {
    this.state = 'pending';
    try {
      executor(value => {
        this.state = 'fulfilled';
        this.value = value;
      }, error => {
        this.state = 'rejected';
        this.value = error;
      });
    } catch (error) {
      this.state = 'rejected';
      this.value = error;
    }
  }
  static resolve(value) {
    return value instanceof Immediate ? value : new Immediate(resolve => resolve(value));
  }
  static reject(error) {
    return new Immediate((_, reject) => reject(error));
  }
  static all(values) {
    return new Immediate((resolve, reject) => {
      try {
        resolve(values.map(unwrap));
      } catch (error) {
        reject(error);
      }
    });
  }
  then(success, failure) {
    return new Immediate((resolve, reject) => {
      try {
        if (this.state === 'pending') throw new Error('Asynchronous initialization is not supported in Apps Script');
        if (this.state === 'rejected' && !failure) return reject(this.value);
        const handler = this.state === 'fulfilled' ? success : failure;
        resolve(unwrap(handler ? handler(this.value) : this.value));
      } catch (error) {
        reject(error);
      }
    });
  }
  catch(failure) {
    return this.then(undefined, failure);
  }
}
function unwrap(value) {
  while (value && typeof value.then === 'function') {
    if (value instanceof Immediate) {
      if (value.state === 'rejected') throw value.value;
      if (value.state !== 'fulfilled') throw new Error('Pending asynchronous operation');
      value = value.value;
    } else {
      let done = false,
        failure,
        result;
      value.then(v => {
        result = v;
        done = true;
      }, e => {
        failure = e;
        done = true;
      });
      if (!done) throw new Error('Pending asynchronous operation');
      if (failure) throw failure;
      value = result;
    }
  }
  return value;
}
function gasThen(call, success, failure) {
  return Immediate.resolve(call()).then(success, failure);
}
function gasCatch(call, failure) {
  try {
    return unwrap(call());
  } catch (error) {
    return failure(error);
  }
}
class Utf8Encoder {
  encode(value) {
    return Uint8Array.from(unescape(encodeURIComponent(value)), x => x.charCodeAt(0));
  }
}
class Utf8Decoder {
  decode(value) {
    let text = '';
    for (let i = 0; i < value.length; i += 8192) text += String.fromCharCode(...value.subarray(i, i + 8192));
    return decodeURIComponent(escape(text));
  }
}
const gasAll = Immediate.all;
const TextEncoder = Utf8Encoder; const TextDecoder = Utf8Decoder;
const Response = platform.Response; const crypto = { randomUUID: platform.uuid };
class GoogleDatabase {
  constructor(sqlite, persist = () => {}) {
    this.sqlite = sqlite;
    this.persist = persist;
    this.batching = false;
  }
  prepare(sql) {
    const database = this;
    const execute = (params, mode, column) => {
      const statement = database.sqlite.prepare(sql);
      let rows;
      try {
        statement.bind(params.map(x => x === undefined ? null : x));
        rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
      } finally {
        statement.free();
      }
      const changes = database.sqlite.getRowsModified();
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql) && !database.batching) database.persist(database.sqlite.export());
      if (mode === 'first') return column ? rows[0]?.[column] ?? null : rows[0] ?? null;
      return {
        results: rows,
        success: true,
        meta: {
          changes
        }
      };
    };
    const bound = params => ({
      sql,
      params,
      bind: (...values) => bound(values),
      first: column => execute(params, 'first', column),
      all: () => execute(params, 'all'),
      run: () => execute(params, 'run')
    });
    return bound([]);
  }
  batch(statements) {
    if (this.batching) throw new Error('Nested transaction');
    this.sqlite.run('BEGIN');
    this.batching = true;
    let results;
    try {
      results = statements.map(s => s.run());
      this.sqlite.run('COMMIT');
    } catch (error) {
      this.sqlite.run('ROLLBACK');
      throw error;
    } finally {
      this.batching = false;
    }
    this.persist(this.sqlite.export());
    return results;
  }
}

    function driveToken(env) { return platform.driveToken(env, ApiFailure); }
    function driveFetch(env, path, params, timeout) { return platform.driveFetch(env, path, params, timeout, ApiFailure); }
    function telegram(env, method, body, contentType) { return platform.telegram(env, method, body, contentType, ApiFailure); }
    function upload(env, location, round, source) { return platform.upload(env, location, round, source, ApiFailure); }
  
const query = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const uploadOwner = env => String(env.LOCATION_OWNER_ID || String(env.ADMIN_IDS || "").split(/[,\s]+/).find(Boolean) || "");
const promptVideo = "Пришли следующее видео. Выход — /done, отменить текущую локацию — /cancel.";
const promptPoint = "Теперь пришли координаты: широта, долгота (например, 55.7558, 37.6173) или обычную геопозицию. /cancel — отменить.";
const promptScore = "Сколько очков ты набрал? Пришли целое число от 0 до 5000. /cancel — отменить.";
const prompts = {
  video: promptVideo,
  coordinates: promptPoint,
  points: promptScore
};
function addLocation(env, message, command, coordinates, coverage) {
  const user = message.from.id;
  const control = ["/add", "/done", "/cancel"].includes(command);
  if (String(user) !== uploadOwner(env)) return control ? "Добавление локаций доступно только владельцу бота." : null;
  const session = unwrap(query(env, "SELECT * FROM location_upload_sessions WHERE user=?", user).first());
  if (!control && (!session || session.step === "off")) return null;
  const id = message.message_id;
  if (!Number.isSafeInteger(id) || session && id <= session.last_message) return control || session && session.step !== "off" ? "Это сообщение уже обработано." : null;
  if (command === "/add") {
    if (session && session.step !== "off") return prompts[session.step];
    unwrap(query(env, `INSERT INTO location_upload_sessions(user,step,last_message) VALUES(?,'video',?)
      ON CONFLICT(user) DO UPDATE SET step='video',last_message=excluded.last_message,
      file_id=NULL,file_unique_id=NULL,latitude=NULL,longitude=NULL WHERE last_message<excluded.last_message`, user, id).run());
    return "Режим добавления включён. Пришли одно видео как видео в Telegram, затем я спрошу координаты и твой счёт. Выход — /done.";
  }
  if (command === "/done" || command === "/cancel") {
    if (!session || session.step === "off") return "Режим добавления выключен. Начать — /add.";
    unwrap(query(env, `UPDATE location_upload_sessions SET step=?,last_message=?,file_id=NULL,file_unique_id=NULL,
      latitude=NULL,longitude=NULL WHERE user=? AND last_message<?`, command === "/done" ? "off" : "video", id, user, id).run());
    return command === "/done" ? "Вышел из режима добавления. Готовые локации сохранены, незавершённая отменена." : "Текущая локация отменена. " + promptVideo;
  }
  if (!session || session.step === "off") return null;
  if (command) return "Сейчас включено добавление локаций. " + prompts[session.step];
  if (message.media_group_id) return "Отправляй видео по одному, без альбома. " + prompts[session.step];
  if (session.step === "video") {
    const video = message.video;
    if (!video?.file_id || !video.file_unique_id) return "Пришли ролик как видео, а не как файл. " + promptVideo;
    if (unwrap(query(env, "SELECT 1 FROM locations WHERE file_unique_id=?", video.file_unique_id).first())) return "Это видео уже есть в locations. " + promptVideo;
    unwrap(query(env, `UPDATE location_upload_sessions SET step='coordinates',last_message=?,file_id=?,file_unique_id=?
      WHERE user=? AND step='video' AND last_message=?`, id, video.file_id, video.file_unique_id, user, session.last_message).run());
    return promptPoint;
  }
  if (session.step === "coordinates") {
    const geo = message.location;
    const point = geo ? !geo.live_period && Number.isFinite(geo.latitude) && Number.isFinite(geo.longitude) && Math.abs(geo.latitude) <= 90 && Math.abs(geo.longitude) <= 180 ? [geo.latitude, geo.longitude] : null : coordinates(message.text);
    if (!point) return "Не распознал координаты. " + promptPoint;
    unwrap(query(env, `UPDATE location_upload_sessions SET step='points',last_message=?,latitude=?,longitude=?
      WHERE user=? AND step='coordinates' AND last_message=?`, id, ...point, user, session.last_message).run());
    return promptScore;
  }
  const text = String(message.text || "").trim();
  if (!/^\d{1,4}$/.test(text) || Number(text) > 5000) return "Нужно целое число от 0 до 5000. " + promptScore;
  unwrap(env.DB.batch([query(env, `INSERT INTO locations(file_unique_id,file_id,latitude,longitude,author_points,owner,created)
      SELECT file_unique_id,file_id,latitude,longitude,?,user,? FROM location_upload_sessions
      WHERE user=? AND step='points' AND last_message=? ON CONFLICT(file_unique_id) DO NOTHING`, Number(text), Math.floor(Date.now() / 1000), user, session.last_message), query(env, `UPDATE location_upload_sessions SET step='video',last_message=?,file_id=NULL,file_unique_id=NULL,
      latitude=NULL,longitude=NULL WHERE user=? AND step='points' AND last_message=?`, id, user, session.last_message)]));
  let weekly = "";
  if (coverage) {
    try {
      weekly = "\n\n" + unwrap(coverage(env));
    } catch {
      weekly = "\n\nОстаток до вечера воскресенья сейчас не удалось посчитать. Видео сохранено.";
    }
  }
  return `Сохранено в locations: ${session.latitude}, ${session.longitude}. Твой результат: ${Number(text)} / 5000.${weekly}\n\n${promptVideo}`;
}
function telegramLocation(env, failedFolder) {
  const row = unwrap(query(env, `SELECT l.* FROM locations l
    WHERE ('telegram:' || l.file_unique_id)<>? AND NOT EXISTS(
      SELECT 1 FROM rounds r WHERE r.status<>'failed' AND (r.folder='telegram:' || l.file_unique_id
        OR (r.latitude=l.latitude AND r.longitude=l.longitude)))
    AND NOT EXISTS(SELECT 1 FROM retired_locations r WHERE r.folder='telegram:' || l.file_unique_id)
    ORDER BY RANDOM() LIMIT 1`, failedFolder || "").first());
  return row ? {
    folder: "telegram:" + row.file_unique_id,
    telegramFileId: row.file_id,
    point: [row.latitude, row.longitude],
    authorPoints: row.author_points
  } : null;
}
function telegramInventory(env) {
  return query(env, `SELECT COUNT(*) AS n FROM locations l WHERE NOT EXISTS(
    SELECT 1 FROM rounds r WHERE r.status<>'failed' AND (r.folder='telegram:' || l.file_unique_id
      OR (r.latitude=l.latitude AND r.longitude=l.longitude)))
    AND NOT EXISTS(SELECT 1 FROM retired_locations r WHERE r.folder='telegram:' || l.file_unique_id)`).first("n");
}
function telegramQueuePoints(env) {
  const rows = unwrap(query(env, `SELECT DISTINCT latitude,longitude FROM locations l WHERE NOT EXISTS(
    SELECT 1 FROM rounds r WHERE r.status<>'failed' AND (r.folder='telegram:' || l.file_unique_id
      OR (r.latitude=l.latitude AND r.longitude=l.longitude)))
    AND NOT EXISTS(SELECT 1 FROM retired_locations r WHERE r.folder='telegram:' || l.file_unique_id)`).all());
  return new Set(rows.results.map(row => `${row.latitude},${row.longitude}`));
}
const game = {
  bot: "itmoguessr_bot",
  author: {
    name: "макс.",
    username: "wayoki"
  },
  chat: "@swidfkjew",
  drive: "1rlP26NNEgdsHkv1n1QGo9SAkaT6aCady",
  timezone: "Europe/Moscow",
  manualMinutes: 120,
  reportTime: "09:30",
  slots: [{
    name: "morning",
    publish: "10:00",
    reveal: "19:00"
  }, {
    name: "evening",
    publish: "20:00",
    reveal: "09:00"
  }]
};
const folderMime = "application/vnd.google-apps.folder";
const roundLinkPrefix = "round_v2_";
const daySeconds = 86400;
const weekSeconds = 7 * daySeconds;
const maxVideoBytes = 30_000_000;
const mediaTypes = {
  "image/jpeg": ["sendPhoto", "photo", "jpg", 10_000_000],
  "image/png": ["sendPhoto", "photo", "png", 10_000_000],
  "video/mp4": ["sendVideo", "video", "mp4", maxVideoBytes],
  "image/gif": ["sendAnimation", "animation", "gif", 50_000_000]
};
const convertibleVideo = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]);
const sourceTypes = [...new Set([...Object.keys(mediaTypes), ...convertibleVideo])];
const mediaQuery = sourceTypes.map(type => `mimeType='${type}'`).join(" or ");
const maxSourceBytes = 1_000_000_000;
const driveFields = "nextPageToken,files(id,name,mimeType,size,version,parents,capabilities(canDownload),videoMediaMetadata(width,height,durationMillis))";
const encode = new TextEncoder();
const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: game.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
const timeLabel = new Intl.DateTimeFormat("ru-RU", {
  timeZone: game.timezone,
  day: "numeric",
  month: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});
const pointWord = {
  one: "очко",
  few: "очка",
  many: "очков",
  other: "очков"
};
const pointPlural = new Intl.PluralRules("ru");
const kilometerWord = {
  one: "километр",
  few: "километра",
  many: "километров",
  other: "километра"
};
const distancePrecision = {
  maximumFractionDigits: 2
};
const distanceLabel = new Intl.NumberFormat("ru-RU", distancePrecision);
const distancePlural = new Intl.PluralRules("ru", distancePrecision);
const showGuessDetails = (env, roundId) => roundId >= Number(env.PUBLIC_GUESS_SCORE_FROM_ROUND || 1);
const clock = () => Math.floor(Date.now() / 1000);
const chat = env => env.TELEGRAM_CHANNEL || game.chat;
const announcementChat = env => env.TELEGRAM_ANNOUNCEMENT_CHANNEL || chat(env);
const firstAdmin = env => String(env.ADMIN_IDS || "").split(/[,\s]+/).find(Boolean);
const db = (env, query, ...params) => env.DB.prepare(query).bind(...params);
const escapeHtml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function coordinates(name) {
  const decimal = "[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)";
  const match = String(name).match(new RegExp(`^\\s*(${decimal})\\s*,\\s*(${decimal})\\s*$`));
  if (!match) return null;
  const point = match.slice(1).map(Number);
  return Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180 ? point : null;
}
function filenameLocation(name) {
  const stem = String(name ?? "").replace(/\.(mp4|mov|webm|mkv|jpe?g|png|gif)$/i, "").replace(/__telegram$/i, "").trim();
  const fields = stem.split(",");
  if (fields.length === 3) {
    const point = coordinates(fields.slice(0, 2).join(","));
    const rawPoints = fields[2].trim();
    const authorPoints = Number(rawPoints);
    return point && /^[0-9]{1,4}$/.test(rawPoints) && authorPoints <= 5000 ? {
      point,
      authorPoints
    } : null;
  }
  const point = coordinates(stem.includes(",") ? stem : stem.replace(/\s+/, ","));
  return point ? {
    point,
    authorPoints: null
  } : null;
}
function filenameCoordinates(name) {
  return filenameLocation(name)?.point ?? null;
}
function score(latitude, longitude, targetLatitude, targetLongitude) {
  const rad = angle => angle * Math.PI / 180;
  const h = Math.sin(rad(targetLatitude - latitude) / 2) ** 2 + Math.cos(rad(latitude)) * Math.cos(rad(targetLatitude)) * Math.sin(rad(targetLongitude - longitude) / 2) ** 2;
  const km = 12742.0176 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
  return {
    km,
    points: Math.round(5000 * Math.exp(-km / 1492.7))
  };
}
function parts(unix) {
  return Object.fromEntries(dateParts.formatToParts(unix * 1000).map(({
    type,
    value
  }) => [type, value]));
}
function localEpoch(day, time) {
  const target = day + (+time.slice(0, 2) * 60 + +time.slice(3)) * 60;
  const seen = parts(target);
  const localAtTarget = Date.UTC(+seen.year, +seen.month - 1, +seen.day, +seen.hour, +seen.minute) / 1000;
  return target - (localAtTarget - target);
}
function activeSlots(now) {
  const local = parts(now);
  const nominal = Date.UTC(+local.year, +local.month - 1, +local.day) / 1000;
  return [nominal - daySeconds, nominal].flatMap(day => game.slots.map(({
    name,
    publish,
    reveal
  }) => ({
    key: `${name}:${new Date(day * 1000).toISOString().slice(0, 10)}`,
    start: localEpoch(day, publish),
    end: localEpoch(day + (reveal < publish ? daySeconds : 0), reveal)
  })).filter(({
    start,
    end
  }) => start <= now && now < end));
}
function remainingWeekSlots(now) {
  const local = parts(now);
  const today = Date.UTC(+local.year, +local.month - 1, +local.day) / 1000;
  const sunday = today + (7 - new Date(today * 1000).getUTCDay()) % 7 * daySeconds;
  const monday = today - (new Date(today * 1000).getUTCDay() + 6) % 7 * daySeconds;
  const slots = [];
  for (let day = Math.max(today - daySeconds, monday); day <= sunday; day += daySeconds) {
    for (const {
      name,
      publish,
      reveal
    } of game.slots) {
      const start = localEpoch(day, publish);
      const end = localEpoch(day + (reveal < publish ? daySeconds : 0), reveal);
      if (end > now) slots.push({
        key: `${name}:${new Date(day * 1000).toISOString().slice(0, 10)}`,
        start,
        end
      });
    }
  }
  return {
    sunday: new Date(sunday * 1000).toISOString().slice(0, 10),
    slots
  };
}
function weekCoverage(env, now = clock()) {
  const {
    sunday,
    slots
  } = remainingWeekSlots(now);
  const covered = slots.length ? unwrap(db(env, `SELECT slot FROM rounds WHERE status<>'failed' AND slot IN (${slots.map(() => "?").join(",")})`, ...slots.map(slot => slot.key)).all()).results : [];
  const remaining = slots.length - covered.length;
  const ready = unwrap(telegramQueuePoints(env));
  let checked = true;
  if (ready.size < remaining && env.DRIVE_SERVICE_ACCOUNT) {
    try {
      const {
        root,
        used,
        usedPoints,
        prepared
      } = unwrap(readLocationIndex(env));
      let token;
      let budget = 20;
      search: do {
        if (budget-- <= 0) {
          checked = false;
          break;
        }
        const page = unwrap(rootLocationsPage(env, root, token));
        for (const item of page.files ?? []) {
          const candidate = locationCandidate(item, used, usedPoints);
          if (!candidate || ready.has(candidate.point.join(","))) continue;
          if (candidate.isFolder && budget-- <= 0) {
            checked = false;
            break search;
          }
          const location = unwrap(resolveLocation(env, candidate, prepared));
          if (location && !location.needsPreparation) ready.add(location.point.join(","));
          if (ready.size >= remaining) break search;
        }
        token = page.nextPageToken;
      } while (token);
    } catch (error) {
      checked = false;
      logFailure("Weekly video stock")(error);
    }
  }
  return {
    sunday,
    remaining,
    ready: ready.size,
    missing: Math.max(0, remaining - ready.size),
    checked
  };
}
function weekCoverageText(env) {
  const {
    sunday,
    remaining,
    ready,
    missing,
    checked
  } = unwrap(weekCoverage(env));
  const [, month, day] = sunday.split("-");
  const until = `До вечера воскресенья (${day}.${month}), включая раунд в 20:00 МСК`;
  if (!missing) return `${until} всё закрыто ✅\nЕщё видео загружать не нужно.`;
  return `${until}:\nОсталось раундов: ${remaining}. В готовой очереди: ${ready}.\n` + (checked ? `Осталось загрузить видео: ${missing}.` : `Без учёта непроверенной части Google Drive осталось загрузить видео: ${missing}.`);
}
function weeklyWindow(now) {
  const local = parts(now);
  const today = Date.UTC(+local.year, +local.month - 1, +local.day) / 1000;
  if (+local.day <= 7 || new Date(today * 1000).getUTCDay() !== 0 || now < localEpoch(today, game.reportTime)) return null;
  return {
    start: localEpoch(today - weekSeconds, "00:00"),
    end: localEpoch(today, "00:00")
  };
}
function monthlyWindow(now) {
  const local = parts(now);
  if (+local.day !== 1) return null;
  const today = Date.UTC(+local.year, +local.month - 1, 1) / 1000;
  if (now < localEpoch(today, game.reportTime)) return null;
  const priorMonth = Date.UTC(+local.year, +local.month - 2, 1) / 1000;
  return {
    start: localEpoch(priorMonth, "00:00"),
    end: localEpoch(today, "00:00")
  };
}
class ApiFailure extends Error {
  constructor(service, status, retryAfter) {
    super(`${service} HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
let googleToken;
const folderQuery = (id, filter) => `'${id}' in parents and trashed=false and (${filter})`;
const driveId = value => /^[\w-]+$/.test(value);
function classify(media, prepared) {
  const size = Number(media.size);
  if (!media.capabilities?.canDownload || !Number.isSafeInteger(size) || size < 1) return null;
  const format = mediaTypes[media.mimeType];
  if (format && size <= format[3]) return {
    media,
    format,
    size
  };
  const ready = prepared.get(`${media.id}:${media.version}`);
  if (ready && ready.size <= maxVideoBytes) return {
    media: {
      ...media,
      mimeType: "video/mp4",
      videoMediaMetadata: {
        width: ready.width,
        height: ready.height,
        durationMillis: ready.duration * 1000
      }
    },
    format: mediaTypes["video/mp4"],
    size: ready.size,
    objectKey: ready.object_key
  };
  if (convertibleVideo.has(media.mimeType) && media.version && size <= maxSourceBytes) {
    return {
      media,
      size,
      needsPreparation: true
    };
  }
  return null;
}
function readLocationIndex(env) {
  const root = env.DRIVE_ROOT || game.drive;
  if (!driveId(root)) throw new Error("Invalid Drive root");
  const [usedRows, preparedRows] = unwrap(unwrap(gasAll([db(env, `SELECT folder,latitude,longitude FROM rounds WHERE status<>'failed'
      UNION SELECT folder,NULL,NULL FROM retired_locations`).all(), db(env, "SELECT * FROM prepared_media").all()])));
  const used = new Set(usedRows.results.map(row => row.folder));
  const usedPoints = new Set(usedRows.results.filter(row => row.latitude != null && row.longitude != null).map(row => `${row.latitude},${row.longitude}`));
  const prepared = new Map(preparedRows.results.map(row => [`${row.file_id}:${row.source_version}`, row]));
  return {
    root,
    used,
    usedPoints,
    prepared
  };
}
function rootLocationsPage(env, root, token) {
  const response = unwrap(driveFetch(env, "", {
    q: folderQuery(root, `mimeType='${folderMime}' or ${mediaQuery}`),
    orderBy: "name",
    pageSize: "50",
    fields: driveFields,
    ...(token ? {
      pageToken: token
    } : {})
  }));
  return response.json();
}
function locationCandidate(item, used, usedPoints) {
  const isFolder = item.mimeType === folderMime;
  const folder = isFolder ? item.id : `file:${item.id}`;
  if (used.has(folder) || typeof item.id !== "string" || !driveId(item.id)) return null;
  const metadata = isFolder ? {
    point: coordinates(item.name),
    authorPoints: null
  } : filenameLocation(item.name);
  return metadata?.point && !usedPoints.has(metadata.point.join(",")) ? {
    item,
    folder,
    isFolder,
    ...metadata
  } : null;
}
function resolveLocation(env, candidate, prepared) {
  const {
    item,
    folder,
    isFolder,
    point
  } = candidate;
  let {
    authorPoints
  } = candidate;
  let available;
  if (isFolder) {
    const inner = unwrap(unwrap(driveFetch(env, "", {
      q: folderQuery(item.id, mediaQuery),
      fields: driveFields,
      pageSize: "10"
    })).json());
    if (inner.nextPageToken) return null;
    const candidates = (inner.files ?? []).map(media => classify(media, prepared)).filter(Boolean);
    const ready = candidates.filter(location => !location.needsPreparation);
    if (ready.length === 1) [available] = ready;else if (!ready.length && candidates.length === 1) [available] = candidates;
    const metadata = available && filenameLocation(available.media.name);
    if (metadata && metadata.point[0] === point[0] && metadata.point[1] === point[1]) {
      authorPoints = metadata.authorPoints;
    }
  } else {
    available = classify(item, prepared);
  }
  return available ? {
    ...available,
    folder,
    point,
    authorPoints
  } : null;
}
function scanLocations(env, cursor, limit) {
  const {
    root,
    used,
    usedPoints,
    prepared
  } = unwrap(readLocationIndex(env));
  const page = unwrap(rootLocationsPage(env, root, cursor.page));
  const files = page.files ?? [];
  const stop = Math.min(files.length, cursor.offset + limit);
  const locations = [];
  for (let i = cursor.offset; i < stop; i++) {
    const candidate = locationCandidate(files[i], used, usedPoints);
    if (!candidate) continue;
    const location = unwrap(resolveLocation(env, candidate, prepared));
    if (location) locations.push(location);
  }
  const done = stop === files.length && !page.nextPageToken;
  const next = stop < files.length ? {
    page: cursor.page,
    offset: stop
  } : {
    page: page.nextPageToken || "",
    offset: 0
  };
  return {
    locations,
    next,
    done
  };
}
function chooseLocation(env, failedFolder) {
  const direct = unwrap(telegramLocation(env, failedFolder));
  if (direct) return direct;
  if (!env.DRIVE_SERVICE_ACCOUNT) return null;
  const {
    root,
    used,
    usedPoints,
    prepared
  } = unwrap(readLocationIndex(env));
  const candidates = new Map();
  let token;
  do {
    const page = unwrap(rootLocationsPage(env, root, token));
    for (const item of page.files ?? []) {
      const candidate = locationCandidate(item, used, usedPoints);
      if (candidate && candidate.folder !== failedFolder) candidates.set(candidate.folder, candidate);
    }
    token = page.nextPageToken;
  } while (token);
  const remaining = [...candidates.values()];
  while (remaining.length) {
    const index = Math.floor(Math.random() * remaining.length);
    const candidate = remaining[index];
    remaining[index] = remaining.at(-1);
    remaining.pop();
    const location = unwrap(resolveLocation(env, candidate, prepared));
    if (location && !location.needsPreparation) return location;
  }
  return null;
}
function multipart(location, round) {
  const [, field, extension] = location.format;
  const boundary = `itmoguessr-${crypto.randomUUID()}`;
  const deadline = timeLabel.formatToParts(round.ends * 1000).map(({
    type,
    value
  }) => type === "hour" ? String(Number(value)) : value).join("");
  const fields = {
    chat_id: round.chat,
    caption: `Раунд #${round.id} (до ${deadline} МСК)`,
    reply_markup: JSON.stringify({
      inline_keyboard: [[{
        text: "Guess!",
        url: `https://t.me/${game.bot}?start=${roundLinkPrefix}${round.id}`
      }]]
    })
  };
  if (field === "video") {
    fields.supports_streaming = "true";
    const {
      width,
      height,
      durationMillis
    } = location.media.videoMediaMetadata ?? {};
    if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
      Object.assign(fields, {
        width,
        height
      });
    }
    const duration = Math.round(Number(durationMillis) / 1000);
    if (Number.isSafeInteger(duration) && duration > 0) fields.duration = duration;
  }
  const header = encode.encode(Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") + `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="round-${round.id}.${extension}"\r\n` + `Content-Type: ${location.media.mimeType}\r\n\r\n`);
  const footer = encode.encode(`\r\n--${boundary}--\r\n`);
  return {
    boundary,
    header,
    footer
  };
}
function publish(env, slot, end) {
  const saved = unwrap(db(env, "SELECT id,status,folder FROM rounds WHERE slot=?", slot).first());
  if (saved && saved.status !== "failed") return null;
  const location = unwrap(chooseLocation(env, saved?.folder));
  if (!location) return "Пока нет подходящих локаций.";
  const source = location.telegramFileId ? null : location.objectKey ? unwrap(env.MEDIA.get(location.objectKey)) : unwrap(driveFetch(env, "/" + encodeURIComponent(location.media.id), {
    alt: "media",
    supportsAllDrives: "true"
  }));
  if (!location.telegramFileId && !source?.body) throw new Error("Media body is unavailable");
  let round;
  try {
    const now = clock();
    if (now >= end) return null;
    round = unwrap(db(env, `INSERT INTO rounds(slot,folder,latitude,longitude,author_points,chat,ends,status,updated)
      VALUES(?,?,?,?,?,?,?,'publishing',?) ON CONFLICT DO NOTHING RETURNING *`, slot, location.folder, ...location.point, location.authorPoints, chat(env), end, now).first());
    if (!round && saved?.status === "failed") {
      round = unwrap(db(env, `UPDATE rounds SET folder=?,latitude=?,longitude=?,author_points=?,chat=?,ends=?,status='publishing',updated=?
        WHERE slot=? AND status='failed' AND NOT EXISTS(SELECT 1 FROM rounds WHERE folder=? AND status<>'failed') RETURNING *`, location.folder, ...location.point, location.authorPoints, chat(env), end, now, slot, location.folder).first());
    }
    if (!round) return null;
    let message;
    try {
      message = location.telegramFileId ? unwrap(telegram(env, "sendVideo", {
        chat_id: round.chat,
        video: location.telegramFileId,
        supports_streaming: true,
        caption: `Раунд #${round.id} (до ${timeLabel.format(round.ends * 1000)} МСК)`,
        reply_markup: {
          inline_keyboard: [[{
            text: "Guess!",
            url: `https://t.me/${game.bot}?start=${roundLinkPrefix}${round.id}`
          }]]
        }
      })) : unwrap(upload(env, location, round, source.body));
    } catch (error) {
      const rejected = error instanceof ApiFailure && error.status >= 400 && error.status < 500;
      unwrap(db(env, "UPDATE rounds SET status=?,updated=? WHERE id=?", rejected ? "failed" : "uncertain", clock(), round.id).run());
      throw error;
    }
    unwrap(db(env, "UPDATE rounds SET status='active',message_id=?,updated=? WHERE id=? AND status='publishing'", message.message_id, clock(), round.id).run());
    return `Раунд #${round.id} опубликован.`;
  } finally {
    if (source?.body && !source.body.locked) unwrap(gasCatch(() => source.body.cancel(), () => {}));
  }
}
const validUsername = username => typeof username === "string" && /^[a-z0-9_]{1,32}$/i.test(username);
const mention = (user, name, username) => {
  const hasUsername = validUsername(username);
  const label = name?.trim() || (hasUsername ? "@" + username : "Игрок");
  const profile = hasUsername ? `https://t.me/${username}?profile` : `tg://user?id=${user}`;
  return `<a href="${profile}">${escapeHtml(label.slice(0, 80))}</a>`;
};
const googleMaps = (latitude, longitude) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
function leaderboard(round, players, authorId) {
  const author = round.author_points == null ? null : {
    ...game.author,
    user: authorId,
    points: round.author_points,
    km: Infinity,
    submitted: Infinity
  };
  const ranking = players.filter(player => !author || String(player.user) !== authorId && player.username?.toLowerCase() !== author.username).map(player => ({
    ...player,
    ...score(player.latitude, player.longitude, round.latitude, round.longitude)
  }));
  if (author) ranking.push(author);
  ranking.sort((a, b) => b.points - a.points || a.km - b.km || a.submitted - b.submitted || a.user - b.user);
  const heading = round.corrected ? `🛠 Исправление раунда #${round.id}` : `Раунд #${round.id} завершён.`;
  const lines = ranking.slice(0, 10).map((player, index) => {
    const line = `${index + 1}. ${mention(player.user, player.name, player.username)} — ${player.points}`;
    return index === 0 ? `<b>${line}</b>` : line;
  });
  return lines.length ? [heading, "", ...lines].join("\n") : heading;
}
const reportNumber = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 1
});
const reportPlural = new Intl.PluralRules("ru", {
  maximumFractionDigits: 1
});
const playedRoundWord = {
  one: "сыгранный раунд",
  few: "сыгранных раунда",
  many: "сыгранных раундов",
  other: "сыгранных раундов"
};
const mentionWord = {
  one: "упоминание",
  few: "упоминания",
  many: "упоминаний",
  other: "упоминаний"
};
function playerStats(rows) {
  const players = new Map();
  for (const row of rows) {
    if (!players.has(row.user)) {
      players.set(row.user, {
        user: row.user,
        name: row.name,
        username: row.username,
        rounds: 0,
        total: 0
      });
    }
    const player = players.get(row.user);
    player.rounds++;
    player.total += row.points ?? score(row.latitude, row.longitude, row.target_latitude, row.target_longitude).points;
  }
  return players;
}
const average = player => player.total / player.rounds;
const byActivity = (a, b) => b.rounds - a.rounds || average(b) - average(a) || a.user - b.user;
const byAccuracy = (a, b) => average(b) - average(a) || b.rounds - a.rounds || a.user - b.user;
function reportSection(heading, players, detail, mentions, empty) {
  const lines = players.slice(0, 3).map((player, index) => {
    const {
      user,
      name,
      username
    } = player;
    mentions?.push({
      user,
      name,
      username
    });
    return `${index + 1}. ${mention(user, name, username)} ${detail(player)}`;
  });
  return [`<b>${heading}:</b>`, ...(lines.length ? lines : [empty])].join("\n");
}
function activityAndAccuracy(stats, period, mentions) {
  const players = [...stats.values()];
  return [reportSection("Самые активные", players.toSorted(byActivity), ({
    rounds
  }) => `(${rounds} ${playedRoundWord[pointPlural.select(rounds)]} за ${period})`, mentions), reportSection("Самые точные", players.toSorted(byAccuracy), player => {
    const avg = average(player);
    return `(${reportNumber.format(avg)} ${pointWord[reportPlural.select(avg)]} в среднем)`;
  }, mentions)];
}
function progressSection(current, previous, mentions) {
  const ranked = [...current.values()].flatMap(player => {
    const prior = previous.get(player.user);
    if (!prior || prior.total === 0 || average(player) <= average(prior)) return [];
    return [{
      ...player,
      improvement: 100 * (average(player) - average(prior)) / average(prior)
    }];
  }).sort((a, b) => b.improvement - a.improvement || byAccuracy(a, b));
  return reportSection("Самые прогрессирующие", ranked, ({
    improvement
  }) => {
    const percent = reportNumber.format(improvement);
    return `(улучшил показатели на ${percent === "0" ? "&lt;0,1" : percent}%)`;
  }, mentions, "Пока нет участников с ростом среднего результата за обе недели.");
}
function weeklySummary(rows, start, compare) {
  const current = playerStats(rows.filter(row => row.submitted >= start));
  const title = "<b>Итоги недели!</b>";
  const mentions = [];
  if (!current.size) return {
    text: `${title}\n\nЗа неделю никто не сыграл.`,
    mentions
  };
  const sections = [title, ...activityAndAccuracy(current, "неделю", mentions)];
  if (compare) sections.push(progressSection(current, playerStats(rows.filter(row => row.submitted < start)), mentions));
  return {
    text: sections.join("\n\n"),
    mentions
  };
}
function monthlySummary(rows, mentions, start, end) {
  const players = playerStats(rows);
  const mostMentioned = new Map();
  for (const entry of mentions) {
    if (!mostMentioned.has(entry.user)) mostMentioned.set(entry.user, {
      ...entry,
      count: 0
    });
    mostMentioned.get(entry.user).count++;
  }
  const ranked = [...mostMentioned.values()].sort((a, b) => b.count - a.count || a.user - b.user);
  const sections = ["<b>Итоги месяца!</b>"];
  if (players.size) {
    const firstWeek = playerStats(rows.filter(row => row.submitted < start + weekSeconds));
    const lastWeek = playerStats(rows.filter(row => row.submitted >= end - weekSeconds));
    sections.push(...activityAndAccuracy(players, "месяц"), progressSection(lastWeek, firstWeek));
  } else {
    sections.push("За месяц никто не сыграл.");
  }
  sections.push(reportSection("Самые отметившиеся", ranked, ({
    count
  }) => `— ${count} ${mentionWord[pointPlural.select(count)]}`, undefined, "За месяц упоминаний в недельных итогах пока нет."));
  return sections.join("\n\n");
}
function reportGuesses(env, start, end) {
  const {
    results
  } = unwrap(db(env, `SELECT g.user,g.name,g.username,g.submitted,g.points,g.latitude,g.longitude,
    r.latitude AS target_latitude,r.longitude AS target_longitude FROM guesses g JOIN rounds r ON r.id=g.round
    WHERE g.submitted>=? AND g.submitted<? ORDER BY g.submitted DESC,g.round DESC`, start, end).all());
  return results;
}
function prepareWeeklyReport(env, start, end, now) {
  const compare = Boolean(unwrap(db(env, "SELECT 1 FROM weekly_reports WHERE week_start<? AND status='sent' LIMIT 1", start).first()));
  const rows = unwrap(reportGuesses(env, compare ? start - weekSeconds : start, end));
  const {
    text,
    mentions
  } = weeklySummary(rows, start, compare);
  unwrap(db(env, "INSERT OR IGNORE INTO weekly_reports(week_start,text,mentions,status,updated) VALUES(?,?,?,'pending',?)", start, text, JSON.stringify(mentions), now).run());
}
function prepareMonthlyReport(env, start, end, now) {
  const [rows, reports] = unwrap(unwrap(gasAll([reportGuesses(env, start, end), db(env, "SELECT mentions FROM weekly_reports WHERE status='sent' AND updated>=? AND updated<? ORDER BY updated DESC", start, end).all()])));
  const mentions = reports.results.flatMap(report => JSON.parse(report.mentions));
  unwrap(db(env, "INSERT OR IGNORE INTO monthly_reports(month_start,text,status,updated) VALUES(?,?,'pending',?)", start, monthlySummary(rows, mentions, start, end), now).run());
}
function publishReport(env, now, window, table, key, prepare) {
  if (!window) return;
  const {
    start,
    end
  } = window;
  const existing = unwrap(db(env, `SELECT status,updated FROM ${table} WHERE ${key}=?`, start).first());
  if (existing?.status === "sending" && existing.updated < now - 180) {
    unwrap(db(env, `UPDATE ${table} SET status='uncertain' WHERE ${key}=? AND status='sending' AND updated<?`, start, now - 180).run());
    return;
  }
  if (existing && existing.status !== "pending") return;
  if (!existing) unwrap(prepare(env, start, end, now));
  const item = unwrap(db(env, `UPDATE ${table} SET status='sending',updated=? WHERE ${key}=?
    AND status='pending' AND updated<=? RETURNING text`, now, start, now).first());
  if (!item) return;
  let message;
  try {
    message = unwrap(telegram(env, "sendMessage", {
      chat_id: chat(env),
      text: item.text,
      parse_mode: "HTML",
      link_preview_options: {
        is_disabled: true
      }
    }));
  } catch (error) {
    const limited = error instanceof ApiFailure && error.status === 429;
    const rejected = error instanceof ApiFailure && error.status >= 400 && error.status < 500;
    unwrap(db(env, `UPDATE ${table} SET status=?,updated=? WHERE ${key}=?`, limited ? "pending" : rejected ? "failed" : "uncertain", clock() + (limited ? (error.retryAfter || 5) + 1 : 0), start).run());
    throw error;
  }
  unwrap(db(env, `UPDATE ${table} SET status='sent',message_id=?,updated=? WHERE ${key}=?`, message.message_id, clock(), start).run());
}
function inventory(env) {
  const direct = unwrap(telegramInventory(env));
  if (!env.DRIVE_SERVICE_ACCOUNT) return `Остаток видео для новых раундов\nГотовы: ${direct}\nИсточник: Telegram (locations).`;
  try {
    return `В Telegram готовы: ${direct}\n` + unwrap(driveInventory(env));
  } catch (error) {
    logFailure("Drive inventory")(error);
    return `В Telegram готовы: ${direct}\nGoogle Drive сейчас недоступен; локации Telegram работают.`;
  }
}
function driveInventory(env) {
  const {
    locations,
    done
  } = unwrap(scanLocations(env, {
    page: "",
    offset: 0
  }, 22));
  const videos = locations.filter(location => convertibleVideo.has(location.media.mimeType));
  const pending = videos.filter(location => location.needsPreparation).length;
  const suffix = done ? "" : "+";
  return `Остаток видео для новых раундов\nГотовы: ${videos.length - pending}${suffix}\nЖдут обработки: ${pending}${suffix}` + (done ? "" : "\nПоказано минимум по первой части очереди.");
}
function delivery(env, item) {
  const chatId = item.kind === "inventory" ? firstAdmin(env) : item.chat;
  if (item.kind === "inventory") {
    if (!chatId) return null;
    return {
      method: "sendMessage",
      body: {
        chat_id: chatId,
        text: unwrap(inventory(env))
      }
    };
  }
  if (item.kind === "result") return null;
  const row = unwrap(db(env, `SELECT r.id,r.latitude,r.longitude,r.author_points,g.name,g.username,g.points,g.distance,
    g.latitude AS guess_latitude,g.longitude AS guess_longitude,
    EXISTS(SELECT 1 FROM settings WHERE key='correction:' || r.id) AS corrected
    FROM rounds r LEFT JOIN guesses g ON g.round=r.id AND g.user=? WHERE r.id=?`, item.user, item.round).first());
  const maps = googleMaps(row.latitude, row.longitude);
  if (item.kind === "location") {
    return {
      method: "sendLocation",
      body: {
        chat_id: chatId,
        latitude: row.latitude,
        longitude: row.longitude,
        reply_markup: {
          inline_keyboard: [[{
            text: row.corrected ? "Исправленная точка в Google Maps" : "Открыть Google Maps",
            url: maps
          }]]
        }
      }
    };
  }
  let text;
  if (item.kind === "guess") {
    const name = mention(item.user, row.name, row.username);
    if (!showGuessDetails(env, item.round)) {
      text = `${name} сделал guess в раунде #${item.round}`;
    } else {
      const fallback = row.points == null || row.distance == null ? score(row.guess_latitude, row.guess_longitude, row.latitude, row.longitude) : null;
      const points = row.points ?? fallback.points;
      const km = row.distance ?? fallback.km;
      text = `${name} набрал ${points} ${pointWord[pointPlural.select(points)]} (дистанция ${distanceLabel.format(km)} км) в раунде #${item.round}`;
    }
  } else {
    const players = unwrap(db(env, "SELECT user,name,username,latitude,longitude,submitted FROM guesses WHERE round=?", item.round).all()).results;
    text = leaderboard(row, players, firstAdmin(env));
  }
  return {
    method: "sendMessage",
    body: {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: {
        is_disabled: true
      }
    }
  };
}
function flush(env, budget = 10) {
  for (let i = 0; i < budget; i++) {
    const item = unwrap(db(env, `UPDATE outbox SET status='sending',updated=?
      WHERE id=(SELECT id FROM outbox WHERE status='pending' AND updated<=? ORDER BY id LIMIT 1)
      RETURNING *`, clock(), clock()).first());
    if (!item) return;
    let payload;
    try {
      payload = unwrap(delivery(env, item));
    } catch (error) {
      unwrap(db(env, "UPDATE outbox SET status='pending',updated=? WHERE id=?", clock() + 60, item.id).run());
      logFailure("Prepare notification")(error);
      continue;
    }
    let message;
    try {
      if (payload) message = unwrap(telegram(env, payload.method, payload.body));
    } catch (error) {
      const limited = error instanceof ApiFailure && error.status === 429;
      const rejected = error instanceof ApiFailure && error.status >= 400 && error.status < 500;
      unwrap(db(env, "UPDATE outbox SET status=?,updated=? WHERE id=?", limited ? "pending" : rejected ? "failed" : "uncertain", clock() + (limited ? (error.retryAfter || 5) + 1 : 0), item.id).run());
      console.warn("Notification delivery", item.kind, item.round, error instanceof ApiFailure ? error.message : "unconfirmed");
      if (limited) return;
      continue;
    }
    unwrap(db(env, "UPDATE outbox SET status='sent',message_id=?,updated=? WHERE id=?", message?.message_id ?? null, clock(), item.id).run());
  }
}
function tick(env, source) {
  const now = clock();
  const recordTick = key => db(env, "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(now));
  unwrap(env.DB.batch([recordTick("last_tick"), ...(source === "apps_script" ? [recordTick("last_apps_script_tick")] : []), db(env, "UPDATE rounds SET status='uncertain' WHERE status='publishing' AND updated<?", now - 180), db(env, "UPDATE outbox SET status='uncertain' WHERE status='sending' AND updated<?", now - 180), db(env, "UPDATE rounds SET status='closed',updated=? WHERE status='active' AND ends<=?", now, now)]));
  unwrap(flush(env));
  const paused = unwrap(db(env, "SELECT value FROM settings WHERE key='paused'").first("value"));
  if (env.SCHEDULE_ENABLED === "true" && paused !== "1") {
    unwrap(gasCatch(() => publishReport(env, now, monthlyWindow(now), "monthly_reports", "month_start", prepareMonthlyReport), logFailure("Monthly report")));
    unwrap(gasCatch(() => publishReport(env, now, weeklyWindow(now), "weekly_reports", "week_start", prepareWeeklyReport), logFailure("Weekly report")));
    for (const slot of activeSlots(now)) unwrap(publish(env, slot.key, slot.end));
  }
}
function reply(message, text) {
  return Response.json({
    method: "sendMessage",
    chat_id: message.chat.id,
    text
  });
}
const okay = () => new Response("OK");
const expired = "Приём ответов в этом раунде закрыт.";
const duplicate = "Ты уже использовал попытку в этом раунде.";
const validId = value => /^\d{1,15}$/.test(value) && Number(value) > 0;
const logFailure = label => error => {
  console.warn(label, error instanceof ApiFailure ? error.message : error.name || "Error");
};
function verifyDrive(env) {
  const root = env.DRIVE_ROOT || game.drive;
  const meta = unwrap(unwrap(driveFetch(env, "/" + encodeURIComponent(root), {
    fields: "mimeType,trashed",
    supportsAllDrives: "true"
  })).json());
  if (meta.trashed || meta.mimeType !== folderMime) throw new Error("Drive root is not a folder");
}
function resetTestRounds(env) {
  const canReset = `EXISTS(SELECT 1 FROM settings WHERE key='paused' AND value='1')
    AND NOT EXISTS(SELECT 1 FROM settings WHERE key='club_launched')`;
  unwrap(env.DB.batch([db(env, `INSERT OR IGNORE INTO retired_locations SELECT folder FROM rounds WHERE status<>'failed' AND ${canReset}`), db(env, `DELETE FROM outbox WHERE ${canReset}`), db(env, `DELETE FROM selected WHERE ${canReset}`), db(env, `DELETE FROM guesses WHERE ${canReset}`), db(env, `DELETE FROM rounds WHERE ${canReset}`), db(env, `DELETE FROM settings WHERE (key='drive_cursor_v2' OR key LIKE 'correction:%') AND ${canReset}`), db(env, `INSERT INTO settings SELECT 'club_launched','1' WHERE ${canReset}`)]));
  return Boolean(unwrap(db(env, "SELECT 1 FROM settings WHERE key='club_launched'").first()));
}
function admin(env, ctx, message, command, args, updateId) {
  if (!String(env.ADMIN_IDS || "").split(/[,\s]+/).includes(String(message.from.id))) {
    return reply(message, "Эта команда доступна администраторам.");
  }
  switch (command) {
    case "/reset_test_rounds":
      {
        if (!env.TELEGRAM_CHANNEL || env.TELEGRAM_CHANNEL === game.chat) {
          return reply(message, "Сначала укажи новую группу.");
        }
        const reset = unwrap(resetTestRounds(env));
        return reply(message, reset ? "Тестовые раунды и ответы очищены. Нумерация клубных раундов начинается с #1." : "Сначала поставь автоматические публикации на паузу.");
      }
    case "/status":
      {
        const now = clock();
        const active = unwrap(db(env, "SELECT id,ends,message_id FROM rounds WHERE status='active' ORDER BY ends").all()).results;
        const counts = unwrap(db(env, "SELECT status,COUNT(*) AS count FROM outbox WHERE status<>'sent' GROUP BY status").all()).results;
        const paused = unwrap(db(env, "SELECT value FROM settings WHERE key='paused'").first("value"));
        const publication = unwrap(db(env, "SELECT COUNT(*) AS n FROM rounds WHERE status='uncertain'").first("n"));
        const lastTick = unwrap(db(env, "SELECT value FROM settings WHERE key='last_tick'").first("value"));
        const googleTick = unwrap(db(env, "SELECT value FROM settings WHERE key='last_apps_script_tick'").first("value"));
        const lastClosed = unwrap(db(env, `SELECT r.id,
        (SELECT message_id FROM outbox WHERE round=r.id AND kind='reveal' AND status='sent') AS reveal_message
        FROM rounds r WHERE r.status='closed' ORDER BY r.ends DESC, r.id DESC LIMIT 1`).first());
        return reply(message, [`Расписание: ${env.SCHEDULE_ENABLED !== "true" ? "выключено" : paused === "1" ? "на паузе" : "включено"}.`, `Группа публикаций — ${chat(env)}.`, ...(lastTick ? [`Последняя проверка расписания — ${timeLabel.format(Number(lastTick) * 1000)} МСК.`] : []), ...(googleTick ? [`Последняя проверка из Google — ${timeLabel.format(Number(googleTick) * 1000)} МСК.`] : []), ...active.map(round => round.ends <= now ? `Раунд #${round.id} ждёт раскрытия.` : `Раунд #${round.id} до ${timeLabel.format(round.ends * 1000)} МСК (${round.message_id ? `сообщение #${round.message_id}` : "номер сообщения не сохранён"}).`), ...(!active.some(round => round.ends > now) ? ["Активных раундов нет."] : []), ...(lastClosed ? [`Последний закрытый раунд #${lastClosed.id}. Таблица: ${lastClosed.reveal_message ? `сообщение #${lastClosed.reveal_message}` : "отправка не подтверждена"}.`] : []), `Публикаций с неизвестным исходом: ${publication}.`, ...counts.map(({
          status,
          count
        }) => `Уведомления (${status}): ${count}.`)].join("\n"));
      }
    case "/inventory":
      {
        try {
          return reply(message, unwrap(inventory(env)));
        } catch (error) {
          logFailure("Video inventory")(error);
          return reply(message, "Не удалось подсчитать остаток видео. Проверь Google Drive.");
        }
      }
    case "/sync":
      {
        try {
          unwrap(verifyDrive(env));
          const location = unwrap(chooseLocation(env));
          return reply(message, location ? "Google Drive доступен. Найдена новая локация." : "Google Drive доступен. Подходящих новых локаций нет.");
        } catch (error) {
          logFailure("Drive sync")(error);
          const detail = error instanceof ApiFailure ? ` (${error.message})` : "";
          return reply(message, `Не удалось прочитать Google Drive${detail}. Проверь доступ сервисного аккаунта к папке.`);
        }
      }
    case "/next":
      {
        const run = () => {
          let summary;
          try {
            summary = unwrap(publish(env, `manual:${updateId}`, clock() + game.manualMinutes * 60));
          } catch (error) {
            logFailure("Manual publication")(error);
            summary = error instanceof ApiFailure ? `Публикация не удалась (${error.message}).` : "Публикация не подтверждена. Проверь /status.";
          }
          if (summary) unwrap(telegram(env, "sendMessage", {
            chat_id: message.chat.id,
            text: summary
          }));
        };
        ctx.waitUntil(gasCatch(() => run(), logFailure("Manual publication reply")));
        return reply(message, "Проверяю локации и запускаю раунд.");
      }
    case "/recover":
      {
        const match = args.match(/^(\d+)(?:\s+(\d+))?$/);
        if (!match || !validId(match[1]) || match[2] && !validId(match[2])) {
          return reply(message, "Формат: /recover N [номер опубликованного сообщения]. Используй только после проверки поста в группе.");
        }
        const id = Number(match[1]);
        const messageId = match[2] ? Number(match[2]) : null;
        const recovered = unwrap(db(env, `UPDATE rounds SET status='active',message_id=COALESCE(?,message_id),updated=?
        WHERE id=? AND status='uncertain' AND ends>? RETURNING id`, messageId, clock(), id, clock()).first());
        if (recovered) return reply(message, `Раунд #${id} восстановлен по опубликованному посту. Приём ответов открыт до прежнего срока.`);
        return reply(message, "Восстановление не выполнено: нужен раунд с неподтверждённой публикацией и неистёкшим сроком.");
      }
    case "/close":
      {
        if (!validId(args)) return reply(message, "Укажи номер раунда, например /close 1.");
        const closed = unwrap(db(env, "UPDATE rounds SET status='closed',updated=? WHERE id=? AND status='active' RETURNING id", clock(), Number(args)).first());
        if (closed) ctx.waitUntil(gasCatch(() => flush(env), logFailure("Round results")));
        return reply(message, closed ? `Раунд #${args} закрыт.` : "Раунд не найден или уже закрыт.");
      }
    case "/correct":
      {
        const match = args.match(/^(\d+)\s+(.+)$/);
        const point = match && coordinates(match[2]);
        if (!point || !validId(match[1])) return reply(message, "Формат: /correct N широта, долгота");
        const roundId = Number(match[1]);
        const updated = unwrap(db(env, `UPDATE rounds SET latitude=?,longitude=?,updated=?
        WHERE id=? AND status='closed' AND (latitude<>? OR longitude<>?)
          AND NOT EXISTS(SELECT 1 FROM outbox WHERE round=? AND status='sending')
        RETURNING id`, ...point, clock(), roundId, ...point, roundId).first());
        if (updated) {
          ctx.waitUntil(gasCatch(() => flush(env), logFailure("Corrected round results")));
          return reply(message, `Правильная точка раунда #${roundId} исправлена. Отправляю пересчитанные результаты.`);
        }
        const existing = unwrap(db(env, "SELECT latitude,longitude,status FROM rounds WHERE id=?", roundId).first());
        if (existing?.status === "closed" && existing.latitude === point[0] && existing.longitude === point[1]) {
          return reply(message, `Эти координаты уже сохранены для раунда #${roundId}.`);
        }
        return reply(message, "Укажи закрытый раунд и дождись окончания рассылки.");
      }
    case "/pause":
    case "/resume":
      {
        unwrap(db(env, "INSERT INTO settings VALUES ('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", command === "/pause" ? "1" : "0").run());
        return reply(message, command === "/pause" ? "Автоматические публикации приостановлены." : "Пауза снята.");
      }
    default:
      return okay();
  }
}
function webhook(env, ctx, request) {
  if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
    return new Response("Forbidden", {
      status: 403
    });
  }
  let update;
  try {
    update = unwrap(request.json());
  } catch {
    return new Response("Bad request", {
      status: 400
    });
  }
  const message = update.message;
  if (message?.chat?.type !== "private" || !Number.isSafeInteger(message.from?.id)) return okay();
  const user = message.from.id;
  const [raw, ...tokens] = (message.text || "").trim().split(/\s+/);
  const args = tokens.join(" ");
  const command = raw.startsWith("/") ? raw.split("@")[0] : "";
  const addition = unwrap(addLocation(env, message, command, coordinates, weekCoverageText));
  if (addition !== null) return reply(message, addition);
  if (command === "/start") {
    if (!args) return reply(message, `Открой раунд по кнопке под постом в группе.\n\nТвой Telegram ID: ${user}`);
    const suffix = args.startsWith(roundLinkPrefix) ? args.slice(roundLinkPrefix.length) : "";
    const id = validId(suffix) ? Number(suffix) : 0;
    const round = unwrap(db(env, "SELECT * FROM rounds WHERE id=?", id).first());
    if (!round) {
      unwrap(db(env, "DELETE FROM selected WHERE user=?", user).run());
      return reply(message, expired);
    }
    unwrap(db(env, "INSERT INTO selected VALUES(?,?) ON CONFLICT(user) DO UPDATE SET round=excluded.round", user, id).run());
    if (round.status !== "active" || clock() >= round.ends) return reply(message, expired);
    if (unwrap(db(env, "SELECT 1 FROM guesses WHERE round=? AND user=?", id, user).first())) return reply(message, duplicate);
    return reply(message, `Раунд #${id}. Открой «Вложения → Геопозиция», выбери точку на карте и отправь её сюда.`);
  }
  if (command) return admin(env, ctx, message, command, args, update.update_id);
  const point = message.location;
  if (!point) return okay();
  if (point.live_period || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
    return reply(message, "Отправь выбранную точку на карте как обычную геопозицию.");
  }
  const round = unwrap(db(env, "SELECT r.* FROM selected s JOIN rounds r ON r.id=s.round WHERE s.user=?", user).first());
  if (!round) return reply(message, "Сначала открой раунд по кнопке в группе.");
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  const now = clock();
  if (round.status !== "active" || round.ends <= now) return reply(message, expired);
  const {
    km,
    points
  } = score(point.latitude, point.longitude, round.latitude, round.longitude);
  const stored = unwrap(db(env, `INSERT INTO guesses(round,user,name,latitude,longitude,announcement,submitted,username,distance,points)
    SELECT id,?,?,?,?,?,?,?,?,? FROM rounds WHERE id=? AND status='active' AND ends>?
    ON CONFLICT(round,user) DO NOTHING RETURNING round`, user, name, point.latitude, point.longitude, announcementChat(env), now, validUsername(message.from.username) ? message.from.username : null, km, points, round.id, now).first());
  if (!stored) {
    const active = unwrap(db(env, "SELECT 1 FROM rounds WHERE id=? AND status='active' AND ends>?", round.id, now).first());
    return reply(message, active ? duplicate : expired);
  }
  ctx.waitUntil(gasCatch(() => flush(env, 1), logFailure("Guess notice")));
  const pointsText = `${points} / 5000`;
  return reply(message, showGuessDetails(env, round.id) ? `${pointsText} (${distanceLabel.format(km)} ${kilometerWord[distancePlural.select(km)]})` : pointsText);
}
function mcp(env, request) {
  let rpc;
  try {
    rpc = unwrap(request.json());
  } catch {
    return new Response("Bad request", {
      status: 400
    });
  }
  const respond = result => Response.json({
    jsonrpc: "2.0",
    id: rpc.id,
    result
  });
  if (rpc.method === "server/discover") return respond({
    supportedVersions: ["2026-07-28"],
    capabilities: {
      tools: {}
    }
  });
  if (rpc.method === "tools/list") return respond({
    tools: [{
      name: "run_training_schedule",
      description: "Run the ITMOGUESSR training bot maintenance and due round operations once.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    }]
  });
  if (rpc.method === "tools/call" && rpc.params?.name === "run_training_schedule") {
    const caller = request.headers.get("oai-authenticated-user-email")?.toLowerCase();
    if (!env.SCHEDULER_EMAIL || caller !== env.SCHEDULER_EMAIL.toLowerCase()) {
      return respond({
        isError: true,
        content: [{
          type: "text",
          text: "Access denied."
        }]
      });
    }
    try {
      unwrap(tick(env));
      return respond({
        content: [{
          type: "text",
          text: "Проверка расписания завершена."
        }]
      });
    } catch (error) {
      logFailure("Scheduled run")(error);
      return respond({
        isError: true,
        content: [{
          type: "text",
          text: "Проверка расписания завершилась ошибкой."
        }]
      });
    }
  }
  return Response.json({
    jsonrpc: "2.0",
    id: rpc.id,
    error: {
      code: -32601,
      message: "Method not found"
    }
  });
}
function mediaMetadata(env, id, version) {
  const root = env.DRIVE_ROOT || game.drive;
  const get = (fileId, fields) => {
    try {
      return unwrap(unwrap(driveFetch(env, "/" + encodeURIComponent(fileId), {
        fields,
        supportsAllDrives: "true"
      })).json());
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) return null;
      throw error;
    }
  };
  const media = unwrap(get(id, "id,name,mimeType,size,version,parents,trashed,capabilities(canDownload)"));
  if (!media || media.trashed || media.version !== version || !classify(media, new Map())?.needsPreparation) return null;
  if (media.parents?.includes(root)) return filenameCoordinates(media.name) ? media : null;
  const folderId = media.parents?.[0];
  if (!folderId || !driveId(folderId)) return null;
  const folder = unwrap(get(folderId, "name,mimeType,parents,trashed"));
  return folder && !folder.trashed && folder.mimeType === folderMime && folder.parents?.includes(root) && coordinates(folder.name) ? media : null;
}
function mediaAPI(request, env) {
  if (!env.MEDIA_PREPARER_KEY || request.headers.get("X-ITMOGUESSR-Media-Key") !== env.MEDIA_PREPARER_KEY) {
    return new Response("Forbidden", {
      status: 403
    });
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/media/queue") {
    const page = url.searchParams.get("page") || "";
    const offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 50 || page.length > 2000) return new Response("Bad cursor", {
      status: 400
    });
    const {
      locations,
      next,
      done
    } = unwrap(scanLocations(env, {
      page,
      offset
    }, 12));
    const items = locations.filter(item => item.needsPreparation).map(({
      media
    }) => ({
      id: media.id,
      version: media.version
    }));
    return Response.json({
      items,
      next: done ? null : next
    });
  }
  if (request.method === "POST" && url.pathname === "/media/wake") {
    unwrap(tick(env));
    return okay();
  }
  const match = url.pathname.match(/^\/media\/([\w-]+)\/(\d+)$/);
  if (!match || !["GET", "PUT"].includes(request.method)) return new Response("Not found", {
    status: 404
  });
  const [, id, version] = match;
  const media = unwrap(mediaMetadata(env, id, version));
  if (!media) return new Response("Not found", {
    status: 404
  });
  if (request.method === "GET") {
    const response = unwrap(driveFetch(env, "/" + id, {
      alt: "media",
      supportsAllDrives: "true"
    }, 600000));
    return new Response(response.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store"
      }
    });
  }
  const size = Number(request.headers.get("Content-Length"));
  const width = Number(request.headers.get("X-Media-Width"));
  const height = Number(request.headers.get("X-Media-Height"));
  const duration = Number(request.headers.get("X-Media-Duration"));
  if (!request.body || ![size, width, height, duration].every(n => Number.isSafeInteger(n) && n > 0) || size > mediaTypes["video/mp4"][3] || width > 1920 || height > 1080) {
    return new Response("Bad media", {
      status: 400
    });
  }
  const base = media.name.replace(/\.[^.]+$/, "").replace(/[\/\\]/g, "_").slice(0, 160);
  const key = `prepared/${id}/${version}/${base}__telegram.mp4`;
  unwrap(env.MEDIA.put(key, request.body, {
    httpMetadata: {
      contentType: "video/mp4"
    }
  }));
  unwrap(db(env, `INSERT INTO prepared_media VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(file_id,source_version) DO UPDATE SET
    object_key=excluded.object_key,size=excluded.size,width=excluded.width,height=excluded.height,duration=excluded.duration,updated=excluded.updated`, id, version, key, size, width, height, duration, clock()).run());
  return okay();
}
function wakeMediaWorker(env) {
  const url = new URL("/run", env.MEDIA_WORKER_URL);
  if (url.protocol !== "https:") throw new Error("Video worker must use HTTPS");
  const run = () => fetch(url.href, {
    method: "POST",
    body: "",
    headers: {
      "X-ITMOGUESSR-Media-Key": env.MEDIA_PREPARER_KEY
    },
    redirect: "manual",
    signal: AbortSignal.timeout(8_000)
  });
  let response = unwrap(gasCatch(() => run(), () => null));
  if (!response || [502, 503, 504].includes(response.status)) {
    const health = unwrap(fetch(new URL("/health", url).href, {
      redirect: "manual",
      signal: AbortSignal.timeout(65_000)
    }));
    if (!health.ok) throw new ApiFailure("Video worker health check", health.status);
    response = unwrap(run());
  }
  if (response.status !== 202) throw new ApiFailure("Video worker", response.status);
}
function appsScriptSchedule(request, env) {
  const expected = env.APPS_SCRIPT_SCHEDULE_DIGEST;
  if (!/^[a-f0-9]{64}$/.test(expected ?? "") || request.headers.get("Content-Length") !== "64") {
    return new Response("Forbidden", {
      status: 403
    });
  }
  const key = unwrap(request.text());
  if (!/^[a-f0-9]{64}$/.test(key)) return new Response("Forbidden", {
    status: 403
  });
  const bytes = new Uint8Array(unwrap(crypto.subtle.digest("SHA-256", encode.encode(key))));
  const actual = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  let mismatch = 0;
  for (let index = 0; index < actual.length; index++) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (mismatch) return new Response("Forbidden", {
    status: 403
  });
  const work = [tick(env, "apps_script")];
  if (env.MEDIA_WORKER_URL && env.MEDIA_PREPARER_KEY) {
    work.push(gasCatch(() => wakeMediaWorker(env), error => {
      const message = String(error.message ?? error.name).replaceAll(env.MEDIA_PREPARER_KEY, "[redacted]");
      console.warn("Video worker", message.slice(0, 240));
    }));
  }
  unwrap(unwrap(gasAll(work)));
  return okay();
}
return { coordinates, filenameLocation, filenameCoordinates, score, activeSlots, remainingWeekSlots, weekCoverage, weekCoverageText, weeklyWindow, monthlyWindow, leaderboard, weeklySummary, monthlySummary, publish, tick, webhook, inventory, scanLocations, mediaMetadata, driveToken, resetTestRounds, GoogleDatabase };
}
