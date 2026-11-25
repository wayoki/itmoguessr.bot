function googlePlatform() {
  const response = function(body, options) { this.body = body; this.status = options && options.status || 200; };
  response.json = value => ({ data: value });
  function request(url, options) {
    try { return UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, options)); }
    catch (_) { throw new Error('External service network error'); }
  }
  function jsonResponse(result, Failure, service) {
    const status = result.getResponseCode();
    if (status < 200 || status >= 300) throw new Failure(service, status);
    return { json: () => JSON.parse(result.getContentText()), body: { blob: result.getBlob(), cancel: () => {}, locked: false } };
  }
  function send(env, method, payload, Failure) {
    if (!env.BOT_TOKEN) throw new Error('Missing Telegram token');
    const multipart = Object.values(payload).some(value => value && typeof value.getBytes === 'function');
    const result = request('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, multipart
      ? { method: 'post', payload }
      : { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload) });
    let data;
    try { data = JSON.parse(result.getContentText()); } catch (_) { throw new Error('Telegram response is unconfirmed'); }
    if (!data.ok) throw new Failure('Telegram', data.error_code || result.getResponseCode(), data.parameters && data.parameters.retry_after);
    return data.result;
  }
  function token(env, Failure) {
    if (!env.DRIVE_SERVICE_ACCOUNT) return ScriptApp.getOAuthToken();
    const account = JSON.parse(env.DRIVE_SERVICE_ACCOUNT);
    const now = Math.floor(Date.now() / 1000);
    const payload = data => Utilities.base64EncodeWebSafe(JSON.stringify(data)).replace(/=+$/, '');
    const jwt = payload({ alg: 'RS256', typ: 'JWT' }) + '.' + payload({
      iss: account.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    });
    const signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(jwt, account.private_key)).replace(/=+$/, '');
    const result = request('https://oauth2.googleapis.com/token', { method: 'post', payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt + '.' + signature,
    } });
    return jsonResponse(result, Failure, 'Google OAuth').json().access_token;
  }
  let cachedToken;
  return {
    Response: response, uuid: () => Utilities.getUuid(),
    telegram: (env, method, body, contentType, Failure) => send(env, method, body, Failure),
    driveToken: (env, Failure) => cachedToken || (cachedToken = token(env, Failure)),
    driveFetch: (env, path, params, timeout, Failure) => {
      cachedToken = cachedToken || token(env, Failure);
      const query = Object.keys(params).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(params[key])).join('&');
      return jsonResponse(request('https://www.googleapis.com/drive/v3/files' + path + '?' + query, {
        headers: { Authorization: 'Bearer ' + cachedToken },
      }), Failure, 'Google Drive');
    },
    mapsRedirect: url => {
      const response = request(url, { followRedirects: false });
      const status = response.getResponseCode();
      if (status < 300 || status >= 400) return null;
      const headers = response.getHeaders();
      return headers.Location || headers.location || null;
    },
    upload: (env, location, round, source, Failure, post) => {
      const field = location.format[1];
      const blob = source.blob;
      if (!blob || blob.getBytes().length > 30000000) throw new Error('Prepared media is missing or exceeds the Google upload limit');
      blob.setName('round-' + round.id + '.' + location.format[2]);
      const payload = { ...post, reply_markup: JSON.stringify(post.reply_markup) };
      payload[field] = blob;
      if (field === 'video') payload.supports_streaming = 'true';
      return send(env, location.format[0], payload, Failure);
    },
  };
}
