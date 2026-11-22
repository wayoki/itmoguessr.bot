function migrateSource_(action) {
  const response=UrlFetchApp.fetch(MIGRATION_ACCESS.origin+'/migration/'+action,{method:'post',headers:{'X-ITMOGUESSR-Migration-Key':MIGRATION_ACCESS.key},muteHttpExceptions:true});
  if(response.getResponseCode()!==200) throw new Error('MigrationSourceUnavailable');
  return JSON.parse(response.getContentText());
}
function migrateUpgrade_() {
  const root='https://raw.githubusercontent.com/wayoki/itmoguessr.bot/389cc526ee3e3200296f2ff80b98b21e61795123/google/dist/';
  const manifest=JSON.parse(UrlFetchApp.fetch(root+'manifest.json').getContentText());
  const core=UrlFetchApp.fetch(root+'core.js').getContentText();
  if(sha256_(core)!==manifest['core.js'].sha256)throw new Error('CoreChecksum');
  const p=PropertiesService.getScriptProperties();
  driveWrite_(p.getProperty('CORE_FILE_ID'),core);
  p.setProperties({SOURCE_COMMIT:'389cc526ee3e3200296f2ff80b98b21e61795123',MEDIA_SOURCE:'telegram',GOOGLE_BOT_ACTIVE:'false'});
  return {ok:true,source:'telegram'};
}
function migrateImport_() {
  const p=PropertiesService.getScriptProperties();
  if(p.getProperty('GOOGLE_BOT_ACTIVE')==='true')throw new Error('DestinationAlreadyActive');
  const data=migrateSource_('export');
  if(data.version!==1||!data.env.BOT_TOKEN||!data.env.WEBHOOK_SECRET)throw new Error('InvalidMigration');
  const names=['rounds','guesses','selected','settings','outbox','prepared_media','retired_locations','weekly_reports','monthly_reports','locations','location_upload_sessions'];
  const properties=data.env;
  if(Object.keys(properties).some(k=>!['BOT_TOKEN','WEBHOOK_SECRET','ADMIN_IDS','LOCATION_OWNER_ID','TELEGRAM_CHANNEL','TELEGRAM_ANNOUNCEMENT_CHANNEL','SCHEDULE_ENABLED','PUBLIC_GUESS_SCORE_FROM_ROUND','MEDIA_PREPARER_KEY'].includes(k)))throw new Error('UnexpectedConfiguration');
  const settings=Object.fromEntries(data.tables.settings.map(x=>[x.key,x.value]));
  const counts=withGoogleRuntime_(runtime=>{
    const sql=runtime.sqlite;
    driveCreate_('database-before-import-'+Date.now()+'.base64',runtime.env.DATA_FOLDER_ID,Utilities.base64Encode(bytesSigned_(sql.export())));
    const triggers=(sql.exec("SELECT sql FROM sqlite_master WHERE type='trigger'")[0]?.values||[]).map(x=>x[0]);
    const triggerNames=(sql.exec("SELECT name FROM sqlite_master WHERE type='trigger'")[0]?.values||[]).map(x=>x[0]);
    sql.run('PRAGMA foreign_keys=OFF');sql.run('BEGIN');
    try {
      for(const name of triggerNames)sql.run('DROP TRIGGER "'+name.replace(/"/g,'""')+'"');
      for(const name of names)sql.run('DELETE FROM '+name);
      for(const name of names){
        if(!Array.isArray(data.tables[name]))throw new Error('MissingTable');
        const columns=sql.exec('PRAGMA table_info('+name+')')[0].values.map(x=>x[1]);
        const statement=sql.prepare('INSERT INTO '+name+'('+columns.map(x=>'"'+x+'"').join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
        try{for(const row of data.tables[name]){
          if(Object.keys(row).some(x=>!columns.includes(x)))throw new Error('UnexpectedColumn');
          const values=columns.map(x=>row[x]===undefined?null:row[x]);
          if(values.some(x=>x!==null&&!['string','number'].includes(typeof x)))throw new Error('UnexpectedValue');
          statement.run(values);
        }}finally{statement.free();}
      }
      sql.run("INSERT INTO settings(key,value) VALUES('paused','1') ON CONFLICT(key) DO UPDATE SET value='1'");
      for(const statement of triggers)sql.run(statement);
      if(sql.exec('PRAGMA integrity_check')[0].values[0][0]!=='ok'||sql.exec('PRAGMA foreign_key_check').length)throw new Error('InvalidSnapshot');
      sql.run('COMMIT');
    }catch(error){sql.run('ROLLBACK');throw error;}finally{sql.run('PRAGMA foreign_keys=ON');}
    runtime.persist(sql.export());
    return Object.fromEntries(names.map(name=>[name,sql.exec('SELECT COUNT(*) FROM '+name)[0].values[0][0]]));
  });
  p.setProperties({...properties,MIGRATION_ORIGINAL_PAUSED:settings.paused||'0',MIGRATION_FINAL_FROZEN:settings.migration_frozen==='1'?'true':'false',GOOGLE_BOT_ACTIVE:'false',MEDIA_SOURCE:'telegram'});
  return {ok:true,counts,sourceFrozen:settings.migration_frozen==='1'};
}
function migrateStatus_(){
  const p=PropertiesService.getScriptProperties();
  const result=withGoogleRuntime_(r=>({ready:true,active:r.env.GOOGLE_BOT_ACTIVE==='true',mediaSource:r.env.MEDIA_SOURCE,source:r.env.SOURCE_COMMIT,counts:Object.fromEntries(['rounds','guesses','locations','google_updates'].map(name=>[name,r.env.DB.prepare('SELECT COUNT(*) AS n FROM '+name).first('n')])),paused:r.env.DB.prepare("SELECT value FROM settings WHERE key='paused'").first('value')}));
  if(p.getProperty('BOT_TOKEN')){
    const info=googlePlatform().telegram({BOT_TOKEN:p.getProperty('BOT_TOKEN')},'getWebhookInfo',{},'application/json',Error);
    result.webhook=String(info.url||'').split('?')[0];result.pending=info.pending_update_count;result.lastErrorDate=info.last_error_date||null;
  }
  result.triggers=ScriptApp.getProjectTriggers().filter(x=>x.getHandlerFunction()==='scheduledCheck').length;
  return result;
}
function migrateActivate_(url){
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url))throw new Error('InvalidDeployment');
  const p=PropertiesService.getScriptProperties();
  if(p.getProperty('MIGRATION_FINAL_FROZEN')!=='true')throw new Error('FinalSnapshotRequired');
  const env=p.getProperties();
  p.setProperties({GOOGLE_WEBAPP_URL:url,GOOGLE_BOT_ACTIVE:'true'});
  try{
    withGoogleRuntime_(r=>r.env.DB.prepare("UPDATE settings SET value=? WHERE key='paused'").bind(env.MIGRATION_ORIGINAL_PAUSED||'0').run());
    googlePlatform().telegram(env,'setWebhook',{url:url+'?key='+encodeURIComponent(env.WEBHOOK_SECRET),secret_token:env.WEBHOOK_SECRET,max_connections:1,drop_pending_updates:false,allowed_updates:['message']},'application/json',Error);
    if(!ScriptApp.getProjectTriggers().some(x=>x.getHandlerFunction()==='scheduledCheck'))ScriptApp.newTrigger('scheduledCheck').timeBased().everyMinutes(1).create();
    return migrateStatus_();
  }catch(error){p.setProperty('GOOGLE_BOT_ACTIVE','false');throw error;}
}
function migrateProbe_(){
  const p=PropertiesService.getScriptProperties();
  const user=Number(p.getProperty('LOCATION_OWNER_ID')||String(p.getProperty('ADMIN_IDS')||'').split(/[,\s]+/).find(Boolean));
  if(!Number.isSafeInteger(user)||!user||p.getProperty('GOOGLE_BOT_ACTIVE')!=='true')throw new Error('NotActive');
  const response=UrlFetchApp.fetch(p.getProperty('GOOGLE_WEBAPP_URL')+'?key='+encodeURIComponent(p.getProperty('WEBHOOK_SECRET')),{method:'post',contentType:'application/json',payload:JSON.stringify({update_id:-Date.now(),message:{message_id:1,chat:{id:user,type:'private'},from:{id:user},text:'/status'}}),muteHttpExceptions:true});
  return {http:response.getResponseCode(),ok:response.getResponseCode()===200};
}
function doPost(event){
  let body;try{body=JSON.parse(event.postData.contents);}catch(_){return googleOutput_({error:'InvalidRequest'});}
  if(!String(body.action||'').startsWith('migrate_'))return runtimeDoPost_(event);
  if(Date.now()/1000>MIGRATION_ACCESS.expires||!safeEqual_(body.key,MIGRATION_ACCESS.key))return googleOutput_({error:'Forbidden'});
  try{
    let result;
    if(body.action==='migrate_upgrade')result=migrateUpgrade_();
    else if(body.action==='migrate_import')result=migrateImport_();
    else if(body.action==='migrate_status')result=migrateStatus_();
    else if(body.action==='migrate_activate')result=migrateActivate_(body.url);
    else if(body.action==='migrate_probe')result=migrateProbe_();
    else return googleOutput_({error:'UnknownAction'});
    return googleOutput_(result);
  }catch(error){console.error('Migration operation',body.action,error.name);return googleOutput_({error:'MigrationOperationFailed',operation:body.action,kind:error.name});}
}
