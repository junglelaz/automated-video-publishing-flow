const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const code = fs.readFileSync(__dirname + '/Code.gs','utf8');
function setup() {
  const values = {DRIVE_FOLDER_ID:'demo_source_folder',NOTIFICATION_EMAIL:'owner@example.com',INTAKE_START_AT:'2026-01-01T00:00:00Z'}, calls = [], emails = [];
  const ctx = {console:{log(){},error(){}}, Date, JSON, Object, Number, String, Math,
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>values[k] || null,
      setProperty:(k,v)=>{values[k]=v;},getProperties:()=>({...values})})},
    MailApp:{sendEmail:(...a)=>emails.push(a)},
    Utilities:{sleep(){}},
    ScriptApp:{getOAuthToken:()=> 'PRIVATE_GOOGLE_TOKEN'},
    UrlFetchApp:{fetch:(url,opts)=>{calls.push({url,opts}); throw Error('unexpected fetch');}}
  };
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(__dirname+'/Config.gs','utf8'),ctx);vm.runInContext(code,ctx);
  return {ctx,values,calls,emails};
}
function response(c,h={},bytes=[]) {return {getResponseCode:()=>c,getAllHeaders:()=>h,
  getBlob:()=>({getBytes:()=>bytes}),getContentText:()=>JSON.stringify(h.body||{})};}
const tests=[];
function test(name,fn){fn();tests.push(name);}
test('Upload 308 responses use the acknowledged offset, including empty initial range',()=>{
  const {ctx}=setup();assert.equal(ctx.nextOffset_(response(308),100),0);
  assert.equal(ctx.nextOffset_(response(308,{Range:'bytes=0-31'}),100),32);
  assert.equal(ctx.nextOffset_(response(200),100),100);
  assert.throws(()=>ctx.nextOffset_(response(308,{Range:'bytes=0-999'}),100));
  assert.throws(()=>ctx.nextOffset_(response(403),100));
});
test('Source replacement and wrong parent fail closed',()=>{
  const {ctx}=setup();const s={size:100,version:'1',md5Checksum:'abc'};
  const m={id:'a',size:'100',version:'1',md5Checksum:'abc',parents:['demo_source_folder'],mimeType:'video/quicktime',name:'x.mov'};
  ctx.assertUnchanged_(s,m);
  assert.throws(()=>ctx.assertUnchanged_(s,{...m,version:'2'}));
  assert.throws(()=>ctx.assertUnchanged_(s,{...m,parents:['elsewhere']}));
});
test('Authenticated Drive range must match status, exact range and byte count',()=>{
  const {ctx}=setup();ctx.drive_=()=>response(206,{'Content-Range':'bytes 0-3/100'},[1,2,3,4]);
  assert.equal(ctx.readChunk_({fileId:'a',size:100},0,3).length,4);
  ctx.drive_=()=>response(200,{},[1,2,3,4]);assert.throws(()=>ctx.readChunk_({fileId:'a',size:100},0,3));
  ctx.drive_=()=>response(206,{'Content-Range':'bytes 0-3/100'},[1]);assert.throws(()=>ctx.readChunk_({fileId:'a',size:100},0,3));
});
test('Ambiguous project submission writes barrier before network and never repeats on tick',()=>{
  const {ctx,values}=setup();values.SUBMIT_ENABLED='true';
  ctx.meta_=()=>({videoMediaMetadata:{durationMillis:31473}});ctx.assertUnchanged_=()=>{};ctx.checkUsage_=()=>{};
  let posts=0;ctx.opus_=()=>{posts++;assert.equal(JSON.parse(values['file:a']).status,'submitting');throw Error('NETWORK_UNCERTAIN');};
  const s={fileId:'a',size:1,status:'uploaded',uploadId:'UPL_a'};
  assert.throws(()=>ctx.submit_(s));assert.equal(posts,1);assert.equal(s.status,'submitting');
  values.INTAKE_ENABLED='true';ctx.discover_=()=>['a'];
  ctx.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})};
  ctx.intakeTick_();ctx.intakeTick_();assert.equal(posts,1);assert.equal(JSON.parse(values['file:a']).status,'reconciliation_required');
});
test('Submission is disabled by default and a returned project is recorded behind QC',()=>{
  const {ctx,values}=setup();let posts=0;
  ctx.meta_=()=>({videoMediaMetadata:{durationMillis:31473}});ctx.assertUnchanged_=()=>{};ctx.checkUsage_=()=>{};
  ctx.opus_=()=>{posts++;return response(201,{body:{projectId:'P_test'}});};
  let s={fileId:'a',status:'uploaded'};ctx.submit_(s);assert.equal(posts,0);
  values.SUBMIT_ENABLED='true';ctx.submit_(s);assert.equal(posts,1);
  assert.equal(JSON.parse(values['file:a']).projectId,'P_test');assert.equal(s.qc.passed,false);
});
test('Resume after lost chunk reply probes the remote offset before sending more',()=>{
  const {ctx}=setup();let positions=[],puts=0;
  ctx.fetch_=()=>{puts++;return puts===1?response(308,{Range:'bytes=0-7'}):response(200);};
  ctx.readChunk_=(s,start,end)=>{positions.push(start);return [1,2];};
  const s={fileId:'a',size:10,offset:0,session:'private',status:'uploading'};
  ctx.upload_(s,Date.now()+1000);assert.deepEqual(positions,[8]);assert.equal(s.status,'uploaded');assert.equal(s.session,undefined);
});
test('Mutation requests are not retried, reads have at most three attempts',()=>{
  const {ctx}=setup();let n=0;ctx.UrlFetchApp.fetch=()=>{n++;return response(503);};
  ctx.fetch_('x',{},false);assert.equal(n,1);n=0;ctx.fetch_('x',{},true);assert.equal(n,3);
});
test('Notifications deduplicate and contain no session credential',()=>{
  const {ctx,emails}=setup();const s={fileId:'a',session:'SECRET_UPLOAD_URL',status:'failed'};
  ctx.notify_(s,'FAILED');ctx.notify_(s,'FAILED');assert.equal(emails.length,1);assert(!JSON.stringify(emails).includes('SECRET_UPLOAD_URL'));
});
test('Contending invocation does no work and does not release another owner lock',()=>{
  const {ctx}=setup();ctx.LockService={getScriptLock:()=>({tryLock:()=>false,releaseLock(){throw Error('wrong owner');}})};
  ctx.intakeTick_();
});
test('A completed upload awaiting review does not starve later files',()=>{
  const {ctx,values}=setup();values.INTAKE_ENABLED='true';
  ctx.save_({fileId:'a',status:'uploaded',size:1,version:'1'});
  ctx.discover_=()=>['a','b'];ctx.assertUnchanged_=()=>{};
  ctx.meta_=(id)=>({id,size:1,version:'1'});ctx.validMeta_=()=>{};
  ctx.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})};
  const created=[];ctx.createSlot_=(s)=>{created.push(s.fileId);s.status='uploaded';};
  ctx.intakeTick_();assert.deepEqual(created,['b']);
});
test('Published videos remain terminal and cannot be resubmitted by the timer',()=>{
  const {ctx,values}=setup();values.INTAKE_ENABLED='true';values.SUBMIT_ENABLED='true';
  ctx.save_({fileId:'a',status:'published',projectId:'P_existing'});ctx.discover_=()=>['a'];
  ctx.meta_=()=>{throw Error('terminal state must be skipped');};
  ctx.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})};
  ctx.intakeTick_();assert.equal(JSON.parse(values['file:a']).status,'published');
});
console.log(JSON.stringify({passed:tests.length,tests},null,2));
