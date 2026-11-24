/** Cloud-owned OpusClip OAuth and MCP transport. Never log tokens or session identifiers. */
const OC = Object.freeze({
  endpoint:'https://mcp.opus.pro/mcp',
  issuer:'https://focused-horizon-38.authkit.app',
  get org(){return requiredSetting_('OPUS_ORG_ID');},
  scopes:'openid profile email offline_access'
});
function cloudAuthMeta_() {
  const m=JSON.parse(props_().getProperty('OPUS_CLOUD_AUTH_METADATA') || '{}');
  if(m.issuer!==OC.issuer || !m.token_endpoint || !m.registration_endpoint)
    throw new Error('OPUS_AUTH_DISCOVERY_REQUIRED');
  for(const key of ['token_endpoint','registration_endpoint','authorization_endpoint'])
    if(!String(m[key]).startsWith(OC.issuer+'/')) throw new Error('UNTRUSTED_OPUS_AUTH_ENDPOINT');
  return m;
}
function cloudJson_(r, codes) {expect_(r,codes);return JSON.parse(r.getContentText());}
function saveCloudTokens_(t) {
  if(!t.access_token || !t.refresh_token)throw new Error('RENEWABLE_OPUS_AUTHORIZATION_REQUIRED');
  props_().setProperties({OPUS_CLOUD_ACCESS_TOKEN:t.access_token,OPUS_CLOUD_REFRESH_TOKEN:t.refresh_token,
    OPUS_CLOUD_TOKEN_EXPIRES:String(Date.now()+Number(t.expires_in || 3600)*1000)});
}
function cloudAccessToken_() {
  const p=props_();let token=p.getProperty('OPUS_CLOUD_ACCESS_TOKEN');
  if(token && Number(p.getProperty('OPUS_CLOUD_TOKEN_EXPIRES'))>Date.now()+60000)return token;
  const refresh=p.getProperty('OPUS_CLOUD_REFRESH_TOKEN');if(!refresh)throw new Error('OPUS_CLOUD_AUTHORIZATION_REQUIRED');
  if(p.getProperty('OPUS_CLOUD_REFRESH_IN_PROGRESS'))throw new Error('OPUS_TOKEN_REFRESH_RECONCILIATION_REQUIRED');
  p.setProperty('OPUS_CLOUD_REFRESH_IN_PROGRESS',String(Date.now()));
  const m=cloudAuthMeta_(),client=JSON.parse(p.getProperty('OPUS_CLOUD_CLIENT') || '{}');
  const r=fetch_(m.token_endpoint,{method:'post',payload:{grant_type:'refresh_token',refresh_token:refresh,client_id:client.client_id}},false);
  if(r.getResponseCode()!==200)throw new Error('OPUS_CLOUD_TOKEN_REFRESH_FAILED');
  const t=JSON.parse(r.getContentText());if(!t.refresh_token)t.refresh_token=refresh;
  saveCloudTokens_(t);p.deleteProperty('OPUS_CLOUD_REFRESH_IN_PROGRESS');return p.getProperty('OPUS_CLOUD_ACCESS_TOKEN');
}
function parseRpc_(text,id) {
  let entries=[];
  if(text.trim().startsWith('{'))entries=[JSON.parse(text)];
  else for(const block of text.split(/\r?\n\r?\n/)) {
    const data=block.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
    if(data)entries.push(JSON.parse(data));
  }
  const reply=entries.find(x=>x.id===id);if(!reply)throw new Error('MCP_RESPONSE_UNCERTAIN');
  if(reply.error)throw new Error('MCP_REMOTE_ERROR');return reply.result;
}
function rpcRequest_(method,params,notification) {
  const id=Utilities.getUuid(),p=props_();
  const h={Authorization:'Bearer '+cloudAccessToken_(),Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'};
  const session=p.getProperty('OPUS_CLOUD_MCP_SESSION');if(session)h['Mcp-Session-Id']=session;
  const body={jsonrpc:'2.0',method:method,params:params || {}};if(!notification)body.id=id;
  const r=fetch_(OC.endpoint,{method:'post',contentType:'application/json',headers:h,payload:JSON.stringify(body)},false);
  if(![200,201,202].includes(r.getResponseCode()))throw new Error('MCP_HTTP_'+r.getResponseCode());
  const newSession=header_(r,'Mcp-Session-Id');if(newSession)p.setProperty('OPUS_CLOUD_MCP_SESSION',newSession);
  return notification?{}:parseRpc_(r.getContentText(),id);
}
let MCP_RUN_READY=false;
function initializeCloudMcp_() {
  if(MCP_RUN_READY)return;
  props_().deleteProperty('OPUS_CLOUD_MCP_SESSION');
  rpcRequest_('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'Private cloud video workflow',version:'2.0'}});
  rpcRequest_('notifications/initialized',{},true);MCP_RUN_READY=true;
}
function cloudTool_(name,args) {
  initializeCloudMcp_();const r=rpcRequest_('tools/call',{name:name,arguments:args || {}});
  if(r.isError)throw new Error('OPUS_TOOL_FAILED');
  if(r.structuredContent)return r.structuredContent;
  const text=(r.content || []).filter(x=>x.type==='text').map(x=>x.text).join('\n');
  if(!text)throw new Error('OPUS_TOOL_EMPTY_RESPONSE');return JSON.parse(text);
}
function verifyCloudTools() {
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw new Error('BUSY');
  try {
    const who=cloudTool_('opusclip_whoami',{});if(who.org_id!==OC.org || !who.has_api_access)throw new Error('WRONG_OPUS_ORGANIZATION');
    const usage=cloudTool_('opusclip_get_usage',{});
    initializeCloudMcp_();let tools=[],cursor;
    do {const page=rpcRequest_('tools/list',cursor?{cursor:cursor}:{});tools=tools.concat((page.tools || []).map(x=>x.name));cursor=page.nextCursor;}while(cursor);
    props_().setProperty('OPUS_CLOUD_TOOL_NAMES',JSON.stringify(tools));
    console.log(JSON.stringify({connected:true,orgId:who.org_id,credits:usage.credits,tools:tools}));
  } finally {lock.releaseLock();}
}

/** PKCE redirect flow for servers whose device sign-in does not preserve the request. */
function startCloudBrowserAuthorization() {
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw new Error('BUSY');
  try {
    const p=props_(),m=cloudAuthMeta_(),c=JSON.parse(p.getProperty('OPUS_CLOUD_CLIENT') || '{}');
    if(!c.client_id)throw new Error('OPUS_CLIENT_REGISTRATION_REQUIRED');
    if(p.getProperty('OPUS_CLOUD_ACCESS_TOKEN')){console.log('Cloud authorization is already stored.');return;}
    const verifier=Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,'');
    const challenge=Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,verifier)).replace(/=+$/,'');
    const nonce=Utilities.getUuid();
    const state=ScriptApp.newStateToken().withMethod('opusCloudOAuthCallback').withArgument('nonce',nonce).withTimeout(1800).createToken();
    p.setProperty('OPUS_CLOUD_PKCE',JSON.stringify({verifier:verifier,nonce:nonce,expiresAt:Date.now()+1800000}));
    const params={response_type:'code',client_id:c.client_id,redirect_uri:cloudCallbackUri_(),scope:OC.scopes,
      resource:OC.endpoint,code_challenge:challenge,code_challenge_method:'S256',state:state};
    const url=m.authorization_endpoint+'?'+Object.keys(params).map(k=>encodeURIComponent(k)+'='+encodeURIComponent(params[k])).join('&');
    p.setProperty('OPUS_CLOUD_AUTHORIZATION_URL',url);
    console.log(JSON.stringify({authorizationUrl:url,client:'Private cloud video workflow',expiresInMinutes:30}));
  } finally {lock.releaseLock();}
}
function cloudCallbackUri_(){return 'https://script.google.com/macros/d/'+ScriptApp.getScriptId()+'/usercallback';}
function opusCloudOAuthCallback(e) {
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw new Error('BUSY');
  try {
    const p=props_(),m=cloudAuthMeta_(),c=JSON.parse(p.getProperty('OPUS_CLOUD_CLIENT') || '{}');
    const proof=JSON.parse(p.getProperty('OPUS_CLOUD_PKCE') || '{}'),args=(e || {}).parameter || {};
    if(!proof.verifier || proof.expiresAt<Date.now() || proof.nonce!==args.nonce || !args.code || args.error)
      throw new Error('INVALID_OPUS_AUTH_CALLBACK');
    p.deleteProperty('OPUS_CLOUD_PKCE');
    const r=fetch_(m.token_endpoint,{method:'post',payload:{grant_type:'authorization_code',code:args.code,
      redirect_uri:cloudCallbackUri_(),client_id:c.client_id,code_verifier:proof.verifier,resource:OC.endpoint}},false);
    const t=cloudJson_(r,[200]);saveCloudTokens_(t);
    p.deleteProperty('OPUS_CLOUD_AUTHORIZATION_URL');p.deleteProperty('OPUS_CLOUD_DEVICE');
    return HtmlService.createHtmlOutput('<h2>OpusClip cloud workflow connected</h2><p>Return to the chat. Your authorization was saved privately; no video has been published by this connection yet.</p>');
  } catch (_) {return HtmlService.createHtmlOutput('<h2>Cloud connection needs another attempt</h2><p>No credentials are displayed. Return to the chat for the connection check.</p>');}
  finally {lock.releaseLock();}
}
