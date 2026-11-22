// Replace only this commit placeholder with the reviewed installation commit.
const BOT_CODE_COMMIT = '__SOURCE_COMMIT__';
function runGoogleBot_(name, event) {
  if (!/^[a-f0-9]{40}$/.test(BOT_CODE_COMMIT)) throw new Error('Pin the installation commit');
  const file = PropertiesService.getScriptProperties().getProperty('CONTROLLER_FILE_ID');
  const source = file
    ? UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file) + '?alt=media', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    }).getContentText()
    : UrlFetchApp.fetch('https://raw.githubusercontent.com/wayoki/itmoguessr.bot/' + BOT_CODE_COMMIT + '/google/dist/Code.gs').getContentText().replace('__SOURCE_COMMIT__', BOT_CODE_COMMIT);
  const handlers = eval('(function(){' + source + '\nreturn {installGoogleBot, verifyGoogleBot, scheduledCheck, doGet, doPost};})()');
  return handlers[name](event);
}
function installGoogleBot() { return runGoogleBot_('installGoogleBot'); }
function verifyGoogleBot() { return runGoogleBot_('verifyGoogleBot'); }
function scheduledCheck() { return runGoogleBot_('scheduledCheck'); }
function doGet(event) { return runGoogleBot_('doGet', event); }
function doPost(event) { return runGoogleBot_('doPost', event); }
