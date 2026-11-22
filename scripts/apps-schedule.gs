const SCHEDULE_URL = 'https://itmoguessr-training-bot.handydandelion1.chatgpt.site/schedule/check';
const SCHEDULE_KEY_PROPERTY = 'ITMOGUESSR_SCHEDULE_KEY';

function prepareSchedule() {
  const properties = PropertiesService.getScriptProperties();
  let key = properties.getProperty(SCHEDULE_KEY_PROPERTY);
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
    properties.setProperty(SCHEDULE_KEY_PROPERTY, key);
  }
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8);
  console.log('Schedule digest: ' + digest.map(byte => (byte & 255).toString(16).padStart(2, '0')).join(''));
}

function installSchedule() {
  checkSchedule();
  const installed = ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === 'scheduledCheck');
  if (!installed) {
    ScriptApp.newTrigger('scheduledCheck').timeBased().everyMinutes(1).create();
  }
}

function scheduledCheck() {
  const [hour, minute] = Utilities.formatDate(new Date(), 'Europe/Moscow', 'H:m').split(':').map(Number);
  const dueHour = [9, 10, 19, 20].includes(hour);
  if ((dueHour && minute < 10) || minute % 5 === 0) {
    checkSchedule();
  }
}

function checkSchedule() {
  const key = PropertiesService.getScriptProperties().getProperty(SCHEDULE_KEY_PROPERTY);
  if (!key) throw new Error('Run prepareSchedule first.');
  const response = UrlFetchApp.fetch(SCHEDULE_URL, {
    method: 'post',
    contentType: 'text/plain',
    payload: key,
    followRedirects: false,
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  if (status !== 200) throw new Error('ITMOGUESSR schedule HTTP ' + status);
}
