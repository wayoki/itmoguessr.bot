// Run from the existing Apps Script editor using a pinned GitHub source commit.
function releaseCommunityPanoramas_(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Pin the reviewed GitHub commit');
  const properties = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Bot is busy; run again');
  try {
    const env = properties.getProperties();
    if (env.GOOGLE_BOT_ACTIVE !== 'true' || !env.DATA_FILE_ID || !env.WEBHOOK_SECRET) throw new Error('Existing live bot is required');
    const root = 'https://raw.githubusercontent.com/wayoki/itmoguessr.bot/' + commit + '/google/dist/';
    const manifest = JSON.parse(UrlFetchApp.fetch(root + 'manifest.json').getContentText());
    const coreText = UrlFetchApp.fetch(root + 'core.js').getContentText();
    if (sha256_(coreText) !== manifest['core.js'].sha256) throw new Error('Core checksum mismatch');
    const platform = googlePlatform();
    const core = eval(coreText + '\ncreateGoogleCore(platform);');
    const SQL = eval(cachedCode_(env.SQLITE_FILE_ID, env.SOURCE_COMMIT) + '\nloadGoogleSqlite();');
    const snapshot = driveRead_(env.DATA_FILE_ID).getContentText();
    const database = new SQL.Database(Uint8Array.from(Utilities.base64Decode(snapshot)));
    let counts;
    try {
      const count = table => database.exec('SELECT COUNT(*) FROM ' + table)[0].values[0][0];
      const tables = ['locations', 'location_upload_sessions', 'rounds', 'guesses', 'outbox'];
      counts = Object.fromEntries(tables.map(table => [table, count(table)]));
      const previous = database.exec('SELECT file_unique_id,file_id,latitude,longitude,author_points,owner,created FROM locations ORDER BY file_unique_id');
      new core.GoogleDatabase(database);
      if (tables.some(table => count(table) !== counts[table]) ||
          JSON.stringify(previous) !== JSON.stringify(database.exec('SELECT file_unique_id,file_id,latitude,longitude,author_points,owner,created FROM locations ORDER BY file_unique_id'))) {
        throw new Error('Migration would alter existing game data');
      }
    } finally { database.close(); }
    const info = platform.telegram(env, 'getWebhookInfo', {}, 'application/json', Error);
    const baseUrl = 'https://script.google.com/macros/s/AKfycbxNT6pjMbFB1bnOkJPfI4uoY5fbxCsxle59jOXGKdDIR5L6iSW3Ya7hbJ6OC28JUYmpxg/exec';
    if (info.url !== baseUrl + '?key=' + encodeURIComponent(env.WEBHOOK_SECRET)) throw new Error('Unexpected webhook; preserved existing URL');
    const coreId = env.SOURCE_COMMIT === commit ? env.CORE_FILE_ID
      : driveCreate_('core-' + commit + '.js', env.DATA_FOLDER_ID, coreText);
    if (!info.allowed_updates?.includes('callback_query')) {
      platform.telegram(env, 'setWebhook', { url: info.url, secret_token: env.WEBHOOK_SECRET,
        max_connections: info.max_connections || 1, drop_pending_updates: false,
        allowed_updates: [...new Set([...(info.allowed_updates || []), 'message', 'callback_query'])] }, 'application/json', Error);
    }
    const confirmed = platform.telegram(env, 'getWebhookInfo', {}, 'application/json', Error);
    if (confirmed.url !== info.url || !confirmed.allowed_updates?.includes('callback_query')) throw new Error('Webhook verification failed');
    properties.setProperties({ CORE_FILE_ID: coreId, SOURCE_COMMIT: commit });
    try {
      const runtime = googleRuntime_();
      try {
        counts.panorama_votes = runtime.env.DB.prepare('SELECT COUNT(*) AS n FROM panorama_votes').first('n');
      } finally { runtime.sqlite.close(); }
    } catch (error) {
      properties.setProperties({ CORE_FILE_ID: env.CORE_FILE_ID, SOURCE_COMMIT: env.SOURCE_COMMIT });
      throw error;
    }
    console.log(JSON.stringify({ released: commit, counts, pendingUpdates: confirmed.pending_update_count }));
  } finally { lock.releaseLock(); }
}
