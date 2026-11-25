const query = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export const uploadOwner = (env) => String(env.LOCATION_OWNER_ID || String(env.ADMIN_IDS || "").split(/[,\s]+/).find(Boolean) || "");
export const isPanoramaAdmin = (env, user) => String(user) === uploadOwner(env) ||
  String(env.ADMIN_IDS || "").split(/[,\s]+/).includes(String(user));
const promptMedia = "Пришли одно фото или видео. Выход — /done, отменить текущую локацию — /cancel.";
const promptPoint = "Пришли ссылку на метку Google Maps, координаты (например, 55.7558, 37.6173) или обычную геопозицию. /cancel — отменить.";
const promptDifficulty = "Укажи сложность числом от 1 до 5. 1 — легко, 5 — очень сложно. /cancel — отменить.";
const promptScore = "Сколько очков ты набрал? Пришли целое число от 0 до 5000. /cancel — отменить.";
const prompts = { video: promptMedia, coordinates: promptPoint, difficulty: promptDifficulty, points: promptScore };
const clearDraft = "file_id=NULL,file_unique_id=NULL,latitude=NULL,longitude=NULL,media_type='video',difficulty=NULL";

export async function addLocation(env, message, command, locationPoint, coverage) {
  const user = message.from.id;
  const control = ["/add", "/done", "/cancel"].includes(command);
  const session = await query(env, "SELECT * FROM location_upload_sessions WHERE user=?", user).first();
  if (!control && (!session || session.step === "off")) return null;
  const id = message.message_id;
  if (!Number.isSafeInteger(id) || (session && id <= session.last_message)) return "Это сообщение уже обработано.";
  if (command === "/done" || command === "/cancel") {
    if (!session || session.step === "off") return "Режим добавления выключен. Начать — /add.";
    await query(env, `UPDATE location_upload_sessions SET step=?,last_message=?,${clearDraft}
      WHERE user=? AND last_message<?`, command === "/done" ? "off" : "video", id, user, id).run();
    return command === "/done" ? "Режим добавления выключен. Готовые локации сохранены." : "Текущая локация отменена. " + promptMedia;
  }
  if (await query(env, "SELECT 1 FROM panorama_mutes WHERE user=?", user).first()) {
    return "Добавление панорам для тебя отключено.";
  }
  if (command === "/add") {
    const username = /^[a-z0-9_]{1,32}$/i.test(message.from.username || "") ? message.from.username.toLowerCase() : null;
    await env.DB.batch([
      query(env, "UPDATE panorama_authors SET username=NULL WHERE username=? AND user<>?", username, user),
      query(env, `INSERT INTO panorama_authors VALUES(?,?)
        ON CONFLICT(user) DO UPDATE SET username=excluded.username`, user, username),
    ]);
    if (session && session.step !== "off") return prompts[session.step];
    await query(env, `INSERT INTO location_upload_sessions(user,step,last_message)
      SELECT ?,'video',? WHERE NOT EXISTS(SELECT 1 FROM panorama_mutes WHERE user=?)
      ON CONFLICT(user) DO UPDATE SET step='video',last_message=excluded.last_message,${clearDraft}
      WHERE last_message<excluded.last_message`, user, id, user).run();
    return "Режим добавления включён. " + promptMedia;
  }
  if (command) return "Сейчас включено добавление локаций. " + prompts[session.step];
  if (message.media_group_id) return "Отправляй фото и видео по одному, без альбома. " + prompts[session.step];
  if (session.step === "video") {
    const media = message.video || message.photo?.at(-1);
    if (!media?.file_id || !media.file_unique_id) return "Пришли панораму как видео или фото в Telegram. " + promptMedia;
    if (await query(env, "SELECT 1 FROM locations WHERE file_unique_id=?", media.file_unique_id).first()) {
      return "Эта панорама уже есть в очереди или была сыграна. " + promptMedia;
    }
    await query(env, `UPDATE location_upload_sessions SET step='coordinates',last_message=?,file_id=?,file_unique_id=?,media_type=?
      WHERE user=? AND step='video' AND last_message=?`, id, media.file_id, media.file_unique_id,
    message.video ? "video" : "photo", user, session.last_message).run();
    return promptPoint;
  }
  if (session.step === "coordinates") {
    const point = await locationPoint(message);
    if (!point) return "Не распознал координаты. " + promptPoint;
    await query(env, `UPDATE location_upload_sessions SET step='difficulty',last_message=?,latitude=?,longitude=?
      WHERE user=? AND step='coordinates' AND last_message=?`, id, ...point, user, session.last_message).run();
    return promptDifficulty;
  }
  const text = String(message.text || "").trim();
  if (session.step === "difficulty") {
    if (!/^[1-5]$/.test(text)) return promptDifficulty;
    await query(env, `UPDATE location_upload_sessions SET step='points',last_message=?,difficulty=?
      WHERE user=? AND step='difficulty' AND last_message=?`, id, Number(text), user, session.last_message).run();
    return promptScore;
  }
  if (!/^\d{1,4}$/.test(text) || Number(text) > 5000) return "Нужно целое число от 0 до 5000. " + promptScore;
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ").trim() ||
    (message.from.username ? "@" + message.from.username : "Игрок");
  const [saved] = await env.DB.batch([
    query(env, `INSERT INTO locations(file_unique_id,file_id,latitude,longitude,author_points,owner,created,media_type,difficulty,author_name)
      SELECT file_unique_id,file_id,latitude,longitude,?,user,?,media_type,difficulty,? FROM location_upload_sessions
      WHERE user=? AND step='points' AND last_message=? AND NOT EXISTS(SELECT 1 FROM panorama_mutes WHERE user=?)
      ON CONFLICT(file_unique_id) DO NOTHING`, Number(text), Math.floor(Date.now() / 1000),
    isPanoramaAdmin(env, user) ? null : name.slice(0, 80), user, session.last_message, user),
    query(env, `UPDATE location_upload_sessions SET step='video',last_message=?,${clearDraft}
      WHERE user=? AND step='points' AND last_message=?`, id, user, session.last_message),
  ]);
  if (!(saved.meta?.changes ?? saved.changes)) return "Эта панорама уже сохранена или добавление отключено. " + promptMedia;
  let weekly = "";
  if (coverage && isPanoramaAdmin(env, user)) {
    try { weekly = "\n\n" + await coverage(env); }
    catch { weekly = "\n\nОстаток до вечера воскресенья сейчас не удалось посчитать. Панорама сохранена."; }
  }
  return `Сохранено: ${session.latitude}, ${session.longitude}. Твой результат: ${Number(text)} / 5000.${weekly}\n\n${promptMedia}`;
}

const availableLocation = `NOT EXISTS(
    SELECT 1 FROM rounds r WHERE r.status<>'failed' AND (r.folder='telegram:' || l.file_unique_id
      OR (r.latitude=l.latitude AND r.longitude=l.longitude)))
  AND NOT EXISTS(SELECT 1 FROM retired_locations r WHERE r.folder='telegram:' || l.file_unique_id)`;

export async function telegramLocation(env, failedFolder) {
  const row = await query(env, `SELECT l.* FROM locations l WHERE ('telegram:' || l.file_unique_id)<>?
    AND ${availableLocation} ORDER BY RANDOM() LIMIT 1`, failedFolder || "").first();
  return row ? { folder: "telegram:" + row.file_unique_id, telegramFileId: row.file_id, mediaType: row.media_type,
    point: [row.latitude, row.longitude], authorPoints: row.author_points, authorUser: row.owner,
    authorName: row.author_name, difficulty: row.difficulty } : null;
}

export async function telegramInventory(env) {
  return query(env, `SELECT COUNT(*) AS n FROM locations l WHERE ${availableLocation}`).first("n");
}

export async function telegramQueuePoints(env) {
  const rows = await query(env, `SELECT DISTINCT latitude,longitude FROM locations l WHERE ${availableLocation}`).all();
  return new Set(rows.results.map((row) => `${row.latitude},${row.longitude}`));
}
