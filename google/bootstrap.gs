// Set to the immutable GitHub commit selected for this installation.
const GOOGLE_BOT_SOURCE_COMMIT = '__SOURCE_COMMIT__';

function driveRequest_(method, path, payload, contentType) {
  const options = { method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (payload !== undefined) {
    options.payload = contentType === 'application/json' ? JSON.stringify(payload) : payload;
    if (contentType) options.contentType = contentType;
  }
  const response = UrlFetchApp.fetch('https://www.googleapis.com/' + path, options);
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('Private Drive storage HTTP ' + response.getResponseCode());
  return response;
}
function driveRead_(id) { return driveRequest_('get', 'drive/v3/files/' + encodeURIComponent(id) + '?alt=media'); }
// Cache immutable code only. The changing game database is always read from Drive under the script lock.
function cachedCode_(id, commit) {
  const key = 'code:' + id + ':' + commit;
  let cache;
  try {
    cache = CacheService.getScriptCache();
    const meta = JSON.parse(cache.get(key + ':meta') || 'null');
    if (meta && Number.isSafeInteger(meta.count) && meta.count > 0 && meta.count <= 200) {
      const keys = Array.from({ length: meta.count }, (_, i) => key + ':' + i);
      const parts = cache.getAll(keys);
      if (keys.every(name => typeof parts[name] === 'string')) {
        const text = keys.map(name => parts[name]).join('');
        if (sha256_(text) === meta.sha256) return text;
      }
    }
  } catch (_) {}
  const text = driveRead_(id).getContentText();
  try {
    if (cache) {
      const values = {}, count = Math.ceil(text.length / 24000);
      if (count > 0 && count <= 200) {
        for (let i = 0; i < count; i++) values[key + ':' + i] = text.slice(i * 24000, (i + 1) * 24000);
        values[key + ':meta'] = JSON.stringify({ count, sha256: sha256_(text) });
        cache.putAll(values, 21600);
      }
    }
  } catch (_) {}
  return text;
}
function driveWrite_(id, contents, mime) {
  return driveRequest_('patch', 'upload/drive/v3/files/' + encodeURIComponent(id) + '?uploadType=media', contents, mime || 'text/plain');
}
function driveCreate_(name, parent, contents, mime) {
  const metadata = { name, mimeType: mime || 'text/plain' };
  if (parent) metadata.parents = [parent];
  const file = JSON.parse(driveRequest_('post', 'drive/v3/files', metadata, 'application/json').getContentText());
  if (contents !== undefined) driveWrite_(file.id, contents, mime);
  return file.id;
}
function bytesSigned_(bytes) { return Array.from(bytes, value => value > 127 ? value - 256 : value); }
function sha256_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
}
function safeEqual_(left, right) {
  if (!left || !right) return false;
  const a = sha256_(String(left)), b = sha256_(String(right));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function installGoogleBot() {
  if (!/^[a-f0-9]{40}$/.test(GOOGLE_BOT_SOURCE_COMMIT)) throw new Error('Set the reviewed source commit first');
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('DATA_FILE_ID')) throw new Error('Already installed; existing data was preserved');
  const root = 'https://raw.githubusercontent.com/wayoki/itmoguessr.bot/' + GOOGLE_BOT_SOURCE_COMMIT + '/google/dist/';
  const manifest = JSON.parse(UrlFetchApp.fetch(root + 'manifest.json').getContentText());
  const sources = {};
  for (const name of ['sqlite.js', 'core.js', 'schema.sql']) {
    const result = UrlFetchApp.fetch(root + manifest[name].download);
    const text = manifest[name].gzip ? Utilities.ungzip(result.getBlob()).getDataAsString() : result.getContentText();
    if (sha256_(text) !== manifest[name].sha256) throw new Error('Source checksum mismatch: ' + name);
    sources[name] = text;
  }
  const folder = driveCreate_('ITMOGUESSR private bot', null, undefined, 'application/vnd.google-apps.folder');
  const sqliteId = driveCreate_('sqlite.js', folder, sources['sqlite.js']);
  const coreId = driveCreate_('core.js', folder, sources['core.js']);
  const SQL = eval(sources['sqlite.js'] + '\nloadGoogleSqlite();');
  const database = new SQL.Database();
  database.run(sources['schema.sql']);
  database.run("INSERT INTO settings VALUES('paused','1')");
  const dataId = driveCreate_('bot.sqlite.base64', folder, Utilities.base64Encode(bytesSigned_(database.export())));
  const controllerText = UrlFetchApp.fetch(root + 'Code.gs').getContentText().replace('__SOURCE_COMMIT__', GOOGLE_BOT_SOURCE_COMMIT);
  const controllerId = driveCreate_('controller.js', folder, controllerText);
  database.close();
  properties.setProperties({ DATA_FOLDER_ID: folder, DATA_FILE_ID: dataId, SQLITE_FILE_ID: sqliteId,
    CORE_FILE_ID: coreId, CONTROLLER_FILE_ID: controllerId, SOURCE_COMMIT: GOOGLE_BOT_SOURCE_COMMIT, GOOGLE_BOT_ACTIVE: 'false', MEDIA_SOURCE: 'telegram' });
  console.log('Private Google runtime installed in staging mode. No Telegram webhook or timer changed.');
}
function googleRuntime_() {
  const properties = PropertiesService.getScriptProperties();
  const env = properties.getProperties();
  env.MEDIA_SOURCE = 'telegram';
  env.DRIVE_SERVICE_ACCOUNT = '';
  if (!env.DATA_FILE_ID) throw new Error('Google bot is not installed');
  if (!Array.prototype.toSorted) Array.prototype.toSorted = function(compare) { return this.slice().sort(compare); };
  const SQL = eval(cachedCode_(env.SQLITE_FILE_ID, env.SOURCE_COMMIT) + '\nloadGoogleSqlite();');
  const platform = googlePlatform();
  const core = eval(cachedCode_(env.CORE_FILE_ID, env.SOURCE_COMMIT) + '\ncreateGoogleCore(platform);');
  const sqlite = new SQL.Database(Uint8Array.from(Utilities.base64Decode(driveRead_(env.DATA_FILE_ID).getContentText())));
  const persist = bytes => {
    const text = Utilities.base64Encode(bytesSigned_(bytes));
    if (text.length > 8000000) throw new Error('Database exceeds the reviewed Google runtime size limit');
    driveWrite_(env.DATA_FILE_ID, text);
  };
  try {
    env.DB = new core.GoogleDatabase(sqlite, persist);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  env.MEDIA = { get: () => { throw new Error('Upload videos directly to the bot with /add'); } };
  if (!env.DRIVE_SERVICE_ACCOUNT) env.DRIVE_SERVICE_ACCOUNT = '';
  return { env, core, sqlite, persist };
}
function withGoogleRuntime_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Bot is busy; retry the request');
  let runtime;
  try { runtime = googleRuntime_(); return action(runtime); }
  finally { if (runtime) runtime.sqlite.close(); lock.releaseLock(); }
}
function verifyGoogleBot() {
  return withGoogleRuntime_(runtime => {
    const count = name => runtime.env.DB.prepare('SELECT COUNT(*) AS n FROM ' + name).first('n');
    console.log(JSON.stringify({ ready: true, active: runtime.env.GOOGLE_BOT_ACTIVE === 'true', rounds: count('rounds'), guesses: count('guesses'), locations: count('locations'), panoramaVotes: count('panorama_votes'), sourceCommit: runtime.env.SOURCE_COMMIT }));
  });
}
function scheduledCheck() {
  if (PropertiesService.getScriptProperties().getProperty('GOOGLE_BOT_ACTIVE') !== 'true') return;
  const fields = Utilities.formatDate(new Date(), 'Europe/Moscow', 'H:m').split(':').map(Number);
  if (!(([9,10,19,20].includes(fields[0]) && fields[1] < 10) || fields[1] % 5 === 0)) return;
  const started = Date.now();
  const result = withGoogleRuntime_(runtime => runtime.core.tick(runtime.env, 'apps_script'));
  PropertiesService.getScriptProperties().setProperty('last_timer_duration_ms', String(Date.now() - started));
  return result;
}
function googleOutput_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return googleOutput_({ ready: Boolean(PropertiesService.getScriptProperties().getProperty('DATA_FILE_ID')) }); }
function telegramAck_() { return HtmlService.createHtmlOutput('OK'); }
function doPost(event) {
  let body;
  try { body = JSON.parse(event.postData.contents); } catch (_) { throw new Error('Invalid JSON'); }
  const properties = PropertiesService.getScriptProperties();
  if (!body.action) {
    if (properties.getProperty('GOOGLE_BOT_ACTIVE') !== 'true' || !safeEqual_(event.parameter && event.parameter.key, properties.getProperty('WEBHOOK_SECRET'))) throw new Error('Forbidden');
    return withGoogleRuntime_(runtime => {
      const updateId = body.update_id;
      if (!Number.isSafeInteger(updateId)) throw new Error('Invalid update');
      const previous = runtime.env.DB.prepare('SELECT status FROM google_updates WHERE id=?').bind(updateId).first();
      if (previous && previous.status === 'done') return telegramAck_();
      if (!previous) runtime.env.DB.prepare("INSERT INTO google_updates VALUES(?,'processing',?)").bind(updateId, Math.floor(Date.now() / 1000)).run();
      const response = runtime.core.webhook(runtime.env, { waitUntil: value => value }, {
        json: () => body,
        headers: { get: name => name === 'X-Telegram-Bot-Api-Secret-Token' ? runtime.env.WEBHOOK_SECRET : null },
      });
      if (response && response.data && response.data.method) {
        const payload = Object.assign({}, response.data), method = payload.method;
        delete payload.method;
        googlePlatform().telegram(runtime.env, method, payload, 'application/json', Error);
      }
      runtime.env.DB.prepare("UPDATE google_updates SET status='done' WHERE id=?").bind(updateId).run();
      return telegramAck_();
    });
  }
  if (!safeEqual_(body.key, properties.getProperty('MEDIA_PREPARER_KEY'))) throw new Error('Forbidden');
  return withGoogleRuntime_(runtime => {
    const { env, core } = runtime;
    if (body.action === 'check') return googleOutput_({ ready: true, active: env.GOOGLE_BOT_ACTIVE === 'true', mediaSource: env.MEDIA_SOURCE,
      lastGoogleTick: env.DB.prepare("SELECT value FROM settings WHERE key='last_apps_script_tick'").first('value'),
      lastTick: env.DB.prepare("SELECT value FROM settings WHERE key='last_tick'").first('value') });
    if (body.action === 'wake') {
      if (env.GOOGLE_BOT_ACTIVE !== 'true') throw new Error('Destination is not active');
      core.tick(env, 'apps_script'); return googleOutput_({ ok: true });
    }
    if (body.action === 'queue') return googleOutput_({ items: [], next: null, source: 'telegram' });
    throw new Error('Unknown action');
  });
}
