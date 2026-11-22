import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile('google/bootstrap.gs','utf8');
test('a failed webhook can be retried, while a completed update is acknowledged without replay',()=>{
  let status, calls=0;
  const env={DB:{prepare(sql){return {bind(){return this;},first(){return status?{status}:null;},run(){status=sql.startsWith('INSERT')?'processing':'done';}};}}};
  const core={webhook(){calls++;if(calls===1)throw new Error('TransientFailure');return {};}};
  const sandbox=vm.createContext({Date,PropertiesService:{getScriptProperties:()=>({getProperty:key=>({GOOGLE_BOT_ACTIVE:'true',WEBHOOK_SECRET:'test-secret'})[key]})},HtmlService:{createHtmlOutput:body=>({body,http:200})}});
  vm.runInContext(source,sandbox);
  sandbox.safeEqual_=(left,right)=>left===right;
  sandbox.withGoogleRuntime_=fn=>fn({env,core});
  sandbox.event={parameter:{key:'test-secret'},postData:{contents:JSON.stringify({update_id:123,message:{text:'/status'}})}};
  assert.throws(()=>vm.runInContext('doPost(event)',sandbox),/TransientFailure/);
  assert.equal(status,'processing');
  assert.equal(vm.runInContext('doPost(event)',sandbox).http,200);
  assert.equal(status,'done');assert.equal(calls,2);
  assert.equal(vm.runInContext('doPost(event)',sandbox).http,200);
  assert.equal(calls,2);
});
test('Google timer keeps publication and report windows while skipping idle minutes',()=>{
  let label='12:01',active='true',calls=0;
  const sandbox=vm.createContext({Date,PropertiesService:{getScriptProperties:()=>({getProperty:()=>active})},Utilities:{formatDate:()=>label}});
  vm.runInContext(source,sandbox);
  sandbox.withGoogleRuntime_=action=>action({env:{},core:{tick(){calls++;}}});
  for(const time of ['9:00','9:09','9:30','10:05','19:02','20:09','12:15']){label=time;vm.runInContext('scheduledCheck()',sandbox);}
  assert.equal(calls,7);
  for(const time of ['9:11','10:14','12:01']){label=time;vm.runInContext('scheduledCheck()',sandbox);}
  assert.equal(calls,7);
  active='false';label='20:00';vm.runInContext('scheduledCheck()',sandbox);assert.equal(calls,7);
});
