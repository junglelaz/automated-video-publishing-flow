/** Private cloud intake; all owner-specific settings come from Script Properties. */
function props_() { return PropertiesService.getScriptProperties(); }
function load_(id) { const v = props_().getProperty('file:' + id); return v ? JSON.parse(v) : null; }
function save_(s) {
  s.updatedAt = new Date().toISOString();
  const text = JSON.stringify(s);
  if (text.length > 8000) throw new Error('STATE_RECORD_FULL');
  const p = props_();
  const all = p.getProperties();
  const size = Object.keys(all).reduce((n, k) => n + k.length + all[k].length, 0);
  if (size > 440000 && !all['file:' + s.fileId]) throw new Error('STATE_STORE_FULL');
  p.setProperty('file:' + s.fileId, text);
}
function header_(r, name) {
  const h = r.getAllHeaders();
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? String(h[key]) : '';
}
function fetch_(url, options, retry) {
  // Never put response bodies, bearer tokens, signed URLs or session URLs in errors/logs.
  for (let n = 0; n < (retry ? 3 : 1); n++) {
    let r;
    try { r = UrlFetchApp.fetch(url, Object.assign({muteHttpExceptions: true, followRedirects: false}, options)); }
    catch (_) { if (retry && n < 2) { Utilities.sleep(1000 * Math.pow(2, n)); continue; } throw new Error('NETWORK_UNCERTAIN'); }
    const c = r.getResponseCode();
    if (retry && (c === 429 || c >= 500) && n < 2) { Utilities.sleep(1000 * Math.pow(2, n)); continue; }
    return r;
  }
}
function expect_(r, codes) {
  if (!codes.includes(r.getResponseCode())) throw new Error('HTTP_' + r.getResponseCode());
  return r;
}
function drive_(path, headers) {
  return fetch_('https://www.googleapis.com/drive/v3/' + path,
    {headers: Object.assign({Authorization: 'Bearer ' + ScriptApp.getOAuthToken()}, headers || {})}, true);
}
function meta_(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('INVALID_FILE_ID');
  return JSON.parse(expect_(drive_('files/' + id + '?fields=id,name,size,version,md5Checksum,modifiedTime,parents,mimeType,trashed,videoMediaMetadata'), [200]).getContentText());
}
function validMeta_(m) {
  if (m.trashed || !(m.parents || []).includes(JL.folder)) throw new Error('OUTSIDE_SOURCE_FOLDER');
  if (!/^video\//.test(m.mimeType) || !/\.(mov|mp4|mkv)$/i.test(m.name)) throw new Error('UNSUPPORTED_SOURCE');
  if (!(Number(m.size) > 0 && Number(m.size) <= JL.maxBytes)) throw new Error('INVALID_SOURCE_SIZE');
}
function assertUnchanged_(s, m) {
  validMeta_(m);
  if (String(m.size) !== String(s.size) || String(m.version) !== String(s.version) || m.md5Checksum !== s.md5Checksum)
    throw new Error('SOURCE_CHANGED_REVIEW_REQUIRED');
}
function opus_(path, method, payload, retry) {
  const key = props_().getProperty('OPUSCLIP_API_KEY');
  if (!key) throw new Error('MISSING_OPUSCLIP_API_KEY');
  const opt = {method: method || 'get', headers: {Authorization: 'Bearer ' + key}, contentType: 'application/json'};
  if (payload !== undefined) opt.payload = JSON.stringify(payload);
  return fetch_('https://api.opus.pro/api/' + path, opt, !!retry);
}
function notify_(s, code) {
  if (s.lastNotice === code) return;
  // Persist notification intent before delivery; built-in trigger error emails remain a backup.
  s.lastNotice = code; save_(s);
  MailApp.sendEmail(JL.notify, 'Cloud video video: ' + code,
    'File ID: ' + s.fileId + '\nProject ID: ' + (s.projectId || 'none recorded') +
    '\nStatus: ' + s.status + '\n' + (s.status==='published' ? 'Published successfully to all four authorized destinations.' : 'The automatic workflow needs attention; no approval is normally required.') + '\nOpen the private Apps Script execution log for status.');
}
function readChunk_(s, start, end) {
  const r = expect_(drive_('files/' + s.fileId + '?alt=media', {Range: 'bytes=' + start + '-' + end}), [206]);
  if (header_(r, 'Content-Range') !== 'bytes ' + start + '-' + end + '/' + s.size) throw new Error('BAD_SOURCE_RANGE');
  const b = r.getBlob().getBytes();
  if (b.length !== end - start + 1) throw new Error('BAD_SOURCE_BYTES');
  return b;
}
function createSlot_(s) {
  // Slot creation is also non-idempotent: do not automatically repeat an ambiguous POST.
  s.status = 'slot_creating'; save_(s);
  const r = expect_(opus_('upload-links-v2', 'post', {usecase:'LocalUpload'}, false), [200,201]);
  const u = JSON.parse(r.getContentText());
  if (!/^https:\/\/storage\.googleapis\.com\//.test(u.url) || !u.uploadId || !u.requiredHeaders) throw new Error('BAD_UPLOAD_SLOT');
  s.uploadId = u.uploadId; s.status = 'slot_created'; s.signedUrl = u.url; s.requiredHeaders = u.requiredHeaders; save_(s);
}
function startSession_(s) {
  const r = expect_(fetch_(s.signedUrl, {method:'post', headers:s.requiredHeaders, payload:''}, false), [200,201]);
  const session = header_(r, 'Location');
  if (!/^https:\/\/storage\.googleapis\.com\//.test(session)) throw new Error('BAD_UPLOAD_SESSION');
  // Script Properties are private to project editors. Never store these URLs in GitHub or emails.
  s.session = session; delete s.signedUrl; delete s.requiredHeaders;
  s.offset = 0; s.status = 'uploading'; save_(s);
}
function nextOffset_(r, size) {
  const c = r.getResponseCode();
  if (c === 200 || c === 201) return size;
  if (c !== 308) throw new Error('UPLOAD_HTTP_' + c);
  const range = header_(r, 'Range');
  if (!range) return 0;
  const m = /^bytes=0-(\d+)$/.exec(range);
  if (!m || Number(m[1]) + 1 > size) throw new Error('BAD_UPLOAD_RANGE');
  return Number(m[1]) + 1;
}
function probe_(s) {
  const r = fetch_(s.session, {method:'put', contentType:'application/octet-stream',
    headers:{'Content-Range':'bytes */' + s.size}, payload:''}, true);
  s.offset = nextOffset_(r, s.size);
  if (s.offset === s.size) { s.status = 'uploaded'; delete s.session; }
  save_(s);
}
function upload_(s, deadline) {
  probe_(s); // A crash after the previous PUT is recovered from the server's acknowledged offset.
  while (s.status === 'uploading' && Date.now() < deadline) {
    const start = s.offset, end = Math.min(s.size, start + JL.chunk) - 1;
    const bytes = readChunk_(s, start, end);
    try {
      const r = fetch_(s.session, {method:'put', contentType:'application/octet-stream', payload:bytes,
        headers:{'Content-Range':'bytes ' + start + '-' + end + '/' + s.size}}, false);
      s.offset = nextOffset_(r, s.size);
      if (s.offset <= start || s.offset > end + 1) throw new Error('BAD_UPLOAD_PROGRESS');
      if (s.offset === s.size) { s.status = 'uploaded'; delete s.session; }
      save_(s);
    } catch (_) {
      // No blind chunk retry: probe in the next invocation before sending further data.
      throw new Error('UPLOAD_RECONCILE_ON_NEXT_TICK');
    }
  }
}
function submit_(s) {
  if (props_().getProperty('SUBMIT_ENABLED') !== 'true') return;
  const source=meta_(s.fileId); assertUnchanged_(s, source);
  const seconds=Number(source.videoMediaMetadata?.durationMillis)/1000;
  if (!(seconds>3 && seconds<=180)) throw new Error('SOURCE_DURATION_UNSUPPORTED');
  checkUsage_(); s.sourceDurationSec=seconds;
  s.status = 'submitting'; s.submittedAt = new Date().toISOString(); save_(s);
  // This is the durable write-ahead barrier. A lost response never causes an automatic new project.
  const payload = {videoUrl:s.uploadId, uploadedVideoAttr:{title:'Cloud video ' + s.fileId},
    curationPref:{skipSlicing:true, enableAutoHook:false},
    renderPref:{layoutAspectRatio:'portrait', quickstartConfig:{enableRemoveFillerWords:false}},
    brandTemplateId:'preset-fancy-Karaoke',
    conclusionActions:[{type:'EMAIL', email:JL.notify, notifyFailure:true}]};
  const r = expect_(opus_('clip-projects', 'post', payload, false), [200,201,202]);
  const data = JSON.parse(r.getContentText());
  const id = data.projectId || (data.data || {}).projectId || data.id;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('SUBMISSION_RESPONSE_UNCERTAIN');
  s.projectId = id; s.status = 'qc_required'; s.qc = {passed:false, reason:'Rendered export has not been visually verified'};
  save_(s); if (props_().getProperty('AUTO_WORKFLOW_ENABLED')!=='true') notify_(s, 'RENDER_AND_VISUAL_QC_REQUIRED');
}
function discover_() {
  let page = '', found = [];
  do {
    const q = "'" + JL.folder + "' in parents and trashed=false and mimeType contains 'video/'";
    const path = 'files?q=' + encodeURIComponent(q) + '&fields=nextPageToken,files(id)&pageSize=100' + (page ? '&pageToken=' + encodeURIComponent(page) : '');
    const data = JSON.parse(expect_(drive_(path), [200]).getContentText());
    found = found.concat((data.files || []).map(x => x.id)); page = data.nextPageToken || '';
    if (found.length > 500) throw new Error('INTAKE_BACKLOG_REQUIRES_REVIEW');
  } while (page);
  return found;
}
function intakeTick_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const started = Date.now();
  const day = new Date().toISOString().slice(0,10);
  const p = props_();
  let budget = JSON.parse(p.getProperty('runtime') || '{}');
  if (budget.day !== day) budget = {day:day, ms:0};
  try {
    if (p.getProperty('INTAKE_ENABLED') !== 'true' || budget.ms >= JL.dailyMs) return;
    const ids = discover_();
    for (const id of ids) {
      if (Date.now() - started > JL.maxRunMs - 30000) break;
      let s = load_(id);
      if (s && s.flow) continue;
      if (!s) {
        const m = meta_(id); validMeta_(m);
        s = {fileId:id, size:Number(m.size), version:String(m.version), md5Checksum:m.md5Checksum,
          status:'new', failures:0}; save_(s);
      }
      if (['ignored_existing','dry_run_complete','qc_required','publishing','published','failed','reconciliation_required','submitting','slot_creating'].includes(s.status)) {
        if (['submitting','slot_creating'].includes(s.status)) { s.status='reconciliation_required'; save_(s); notify_(s,'AMBIGUOUS_OPERATION_REVIEW_REQUIRED'); }
        continue;
      }
      if (s.status === 'uploaded' && p.getProperty('SUBMIT_ENABLED') !== 'true') {
        notify_(s, 'UPLOAD_READY_FOR_REVIEW');
        continue;
      }
      if (s.nextAttemptAt && Date.now() < s.nextAttemptAt) continue;
      try {
        assertUnchanged_(s, meta_(id));
        if (s.status === 'new') createSlot_(s);
        if (s.status === 'slot_created') startSession_(s);
        if (s.status === 'uploading') upload_(s, started + JL.maxRunMs - 30000);
        if (s.status === 'uploaded') submit_(s);
      } catch (e) {
        const code = /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'INTERNAL_ERROR';
        s.failures = (s.failures || 0) + 1;
        s.error = code;
        s.nextAttemptAt = Date.now() + Math.min(6*3600000, 60000 * Math.pow(2,s.failures));
        if (s.status === 'submitting' || s.status === 'slot_creating') s.status = 'reconciliation_required';
        else if (s.failures >= 5 || /SOURCE_CHANGED|UPLOAD_HTTP_40|BAD_|OUTSIDE_/.test(code)) s.status = 'failed';
        save_(s);
        if (['failed','reconciliation_required'].includes(s.status)) notify_(s,code);
      }
      // One file per invocation bounds daily runtime and credit exposure.
      break;
    }
  } catch (e) {
    console.error('INTAKE_TICK_FAILED');
    throw new Error('INTAKE_TICK_FAILED');
  } finally {
    budget.ms += Date.now() - started; p.setProperty('runtime', JSON.stringify(budget)); lock.releaseLock();
  }
}
