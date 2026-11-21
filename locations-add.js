const query = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export const uploadOwner = (env) => String(env.LOCATION_OWNER_ID || String(env.ADMIN_IDS || "").split(/[,\s]+/).find(Boolean) || "");
const promptVideo = "Пришли следующее видео. Выход — /done, отменить текущую локацию — /cancel.";
const promptPoint = "Теперь пришли координаты: широта, долгота (например, 55.7558, 37.6173) или обычную геопозицию. /cancel — отменить.";
const promptScore = "Сколько очков ты набрал? Пришли целое число от 0 до 5000. /cancel — отменить.";
const prompts = { video: promptVideo, coordinates: promptPoint, points: promptScore };

export async function addLocation(env, message, command, coordinates, coverage) {
  const user = message.from.id;
  const control = ["/add", "/done", "/cancel"].includes(command);
  if (String(user) !== uploadOwner(env)) return control ? "Добавление локаций доступно только владельцу бота." : null;
  const session = await query(env, "SELECT * FROM location_upload_sessions WHERE user=?", user).first();
  if (!control && (!session || session.step === "off")) return null;
  const id = message.message_id;
  // Telegram can redeliver webhook updates. Never let an old message advance a new step.
  if (!Number.isSafeInteger(id) || (session && id <= session.last_message)) return control || (session && session.step !== "off") ? "Это сообщение уже обработано." : null;
  if (command === "/add") {
    if (session && session.step !== "off") return prompts[session.step];
    await query(env, `INSERT INTO location_upload_sessions(user,step,last_message) VALUES(?,'video',?)
      ON CONFLICT(user) DO UPDATE SET step='video',last_message=excluded.last_message,
      file_id=NULL,file_unique_id=NULL,latitude=NULL,longitude=NULL WHERE last_message<excluded.last_message`, user, id).run();
    return "Режим добавления включён. Пришли одно видео как видео в Telegram, затем я спрошу координаты и твой счёт. Выход — /done.";
  }
  if (command === "/done" || command === "/cancel") {
    if (!session || session.step === "off") return "Режим добавления выключен. Начать — /add.";
    await query(env, `UPDATE location_upload_sessions SET step=?,last_message=?,file_id=NULL,file_unique_id=NULL,
      latitude=NULL,longitude=NULL WHERE user=? AND last_message<?`, command === "/done" ? "off" : "video", id, user, id).run();
    return command === "/done" ? "Вышел из режима добавления. Готовые локации сохранены, незавершённая отменена." : "Текущая локация отменена. " + promptVideo;
  }
  if (!session || session.step === "off") return null;
  if (command) return "Сейчас включено добавление локаций. " + prompts[session.step];
  if (message.media_group_id) return "Отправляй видео по одному, без альбома. " + prompts[session.step];
  if (session.step === "video") {
    const video = message.video;
    if (!video?.file_id || !video.file_unique_id) return "Пришли ролик как видео, а не как файл. " + promptVideo;
    if (await query(env, "SELECT 1 FROM locations WHERE file_unique_id=?", video.file_unique_id).first()) return "Это видео уже есть в locations. " + promptVideo;
    await query(env, `UPDATE location_upload_sessions SET step='coordinates',last_message=?,file_id=?,file_unique_id=?
      WHERE user=? AND step='video' AND last_message=?`, id, video.file_id, video.file_unique_id, user, session.last_message).run();
    return promptPoint;
  }
  if (session.step === "coordinates") {
    const geo = message.location;
    const point = geo ? (!geo.live_period && Number.isFinite(geo.latitude) && Number.isFinite(geo.longitude)
      && Math.abs(geo.latitude)<=90 && Math.abs(geo.longitude)<=180 ? [geo.latitude,geo.longitude] : null) : coordinates(message.text);
    if (!point) return "Не распознал координаты. " + promptPoint;
    await query(env, `UPDATE location_upload_sessions SET step='points',last_message=?,latitude=?,longitude=?
      WHERE user=? AND step='coordinates' AND last_message=?`, id, ...point, user, session.last_message).run();
    return promptScore;
  }
  const text = String(message.text || "").trim();
  if (!/^\d{1,4}$/.test(text) || Number(text)>5000) return "Нужно целое число от 0 до 5000. " + promptScore;
  // Commit the completed location and clear its draft together; webhook retries cannot insert it twice.
  await env.DB.batch([
    query(env, `INSERT INTO locations(file_unique_id,file_id,latitude,longitude,author_points,owner,created)
      SELECT file_unique_id,file_id,latitude,longitude,?,user,? FROM location_upload_sessions
      WHERE user=? AND step='points' AND last_message=? ON CONFLICT(file_unique_id) DO NOTHING`, Number(text), Math.floor(Date.now()/1000), user, session.last_message),
    query(env, `UPDATE location_upload_sessions SET step='video',last_message=?,file_id=NULL,file_unique_id=NULL,
      latitude=NULL,longitude=NULL WHERE user=? AND step='points' AND last_message=?`, id, user, session.last_message),
  ]);
  let weekly = "";
  if (coverage) {
    try { weekly = "\n\n" + await coverage(env); }
    catch { weekly = "\n\nОстаток до вечера воскресенья сейчас не удалось посчитать. Видео сохранено."; }
  }
  return `Сохранено в locations: ${session.latitude}, ${session.longitude}. Твой результат: ${Number(text)} / 5000.${weekly}\n\n${promptVideo}`;
}

export async function telegramLocation(env, failedFolder) {
  const row = await query(env, `SELECT l.* FROM locations l
    WHERE ('telegram:' || l.file_unique_id)<>? AND NOT EXISTS(
      SELECT 1 FROM rounds r WHERE r.status<>'failed' AND (r.folder='telegram:' || l.file_unique_id
        OR (r.latitude=l.latitude AND r.longitude=l.longitude)))
    AND NOT EXISTS(SELECT 1 FROM retired_locations r WHERE r.folder='telegram:' || l.file_unique_id)
    ORDER BY RANDOM() LIMIT 1`, failedFolder || "").first();
  return row ? { folder: "telegram:" + row.file_unique_id, telegramFileId: row.file_id,
    point: [row.latitude,row.longitude], authorPoints: row.author_points } : null;
}

export async function telegramInventory(env) {
  return query(env, `SELECT COUNT(*) AS n FROM locations l WHERE NOT EXISTS(
    SELECT 1 FROM rounds r WHERE r.status<>'failed' AND (r.folder='telegram:' || l.file_unique_id
      OR (r.latitude=l.latitude AND r.longitude=l.longitude)))
    AND NOT EXISTS(SELECT 1 FROM retired_locations r WHERE r.folder='telegram:' || l.file_unique_id)`).first("n");
}

export async function telegramQueuePoints(env) {
  const rows = await query(env, `SELECT DISTINCT latitude,longitude FROM locations l WHERE NOT EXISTS(
    SELECT 1 FROM rounds r WHERE r.status<>'failed' AND (r.folder='telegram:' || l.file_unique_id
      OR (r.latitude=l.latitude AND r.longitude=l.longitude)))
    AND NOT EXISTS(SELECT 1 FROM retired_locations r WHERE r.folder='telegram:' || l.file_unique_id)`).all();
  return new Set(rows.results.map((row) => `${row.latitude},${row.longitude}`));
}
