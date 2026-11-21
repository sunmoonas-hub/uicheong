/* 의좋은 폰프리 청 챌린지 — Apps Script 서버
 * 화면(GitHub Pages)이 fetch POST(text/plain, JSON 본문)로 호출한다. 비밀번호가 주소창·로그에 남지 않도록 GET/JSONP는 쓰지 않는다.
 * 처음 한 번 편집기에서 setup()을 실행하면 '참가자'·'기록'·'설정' 탭과 서명용 비밀값이 만들어진다. */

var SHEET_P = '참가자', SHEET_R = '기록', SHEET_S = '설정';
var HEAD = ['ID','가입시각','성명','팀','직위','내선','닉네임','비밀번호해시','솔트','다짐1','다짐2','동의시각','상태'];
var RHEAD = ['기록ID','사용자ID','성명','닉네임','팀','기록일','사용시간(분)','실천','채움활동','한줄기록','사진ID','공유','저장시각','수정시각','썸네일'];
var C = {}; HEAD.forEach(function (h, i) { C[h] = i; });
var R = {}; RHEAD.forEach(function (h, i) { R[h] = i; });
// 화면(index.html)의 같은 목록과 글자까지 똑같아야 한다. 시트에서 사람이 바로 읽도록 한글 그대로 저장한다
var PRACTICES = ['회의 중 폰 내려놓기', '동료와 폰 없이 점심 산책·먼저 인사', '잠들 땐 폰은 침대 밖 정해진 자리에', '나의 다짐 1', '나의 다짐 2'];
var FILLS = ['R 독서', 'A 예술·문화', 'S 스포츠', '함께', '못 했어요'];
var HASH_ROUNDS = 300; // computeDigest 1회 약 1ms 미만 → 300회면 저장·로그인 지연이 체감되지 않으면서 무차별 대입을 늦춘다
var TZ = 'Asia/Seoul';

function doGet() { return out({ ok: true, app: 'phonefree-cheong' }); }

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return out({ ok: false, error: '요청 형식이 올바르지 않습니다.' }); }
  var fn = ACTIONS[req && req.action];
  if (!fn) return out({ ok: false, error: '알 수 없는 요청입니다.' });
  try { return out(fn(req)); } catch (err) { console.error(err); return out({ ok: false, error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }); }
}

var ACTIONS = {
  /* 닉네임 중복 확인: 가입 전 버튼용. 실제 가입 때 잠금 안에서 한 번 더 검사한다. */
  checkNickname: function (r) {
    var nick = cleanNick(r.nickname), bad = nickError(nick);
    if (bad) return { ok: false, error: bad };
    return findByNick(nick) ? { ok: false, error: '이미 사용 중인 닉네임입니다.' } : { ok: true };
  },

  register: function (r) {
    if (!codeOk(r.code)) return { ok: false, field: 'code', error: '참여 코드가 맞지 않습니다. 메신저로 받은 코드를 확인해 주세요.' };
    var s = settings();
    if (String(s['가입허용'] || '예').trim() === '아니오') return { ok: false, error: '지금은 가입을 받지 않습니다.' };
    var name = str(r.name, 20), team = str(r.team, 30), pos = str(r.position, 20), ext = String(r.ext || '').replace(/\D/g, '');
    var nick = cleanNick(r.nickname), pw = String(r.password || ''), p1 = str(r.pledge1, 60), p2 = str(r.pledge2, 60);
    if (name.length < 2) return { ok: false, field: 'name', error: '성명을 입력해 주세요.' };
    if (!team) return { ok: false, field: 'team', error: '팀을 선택해 주세요.' };
    if (!pos) return { ok: false, field: 'position', error: '직위·직종을 선택해 주세요.' };
    if (ext.length < 3 || ext.length > 5) return { ok: false, field: 'ext', error: '사무실 내선번호를 숫자 3~5자리로 입력해 주세요.' };
    var bad = nickError(nick); if (bad) return { ok: false, field: 'nickname', error: bad };
    if (pw.length < 6 || pw.length > 64) return { ok: false, field: 'password', error: '비밀번호는 6자 이상으로 정해 주세요.' };
    if (!p1) return { ok: false, field: 'pledge1', error: '나의 폰프리 다짐을 1개 이상 적어 주세요.' };
    if (r.agree !== true) return { ok: false, field: 'agree', error: '개인정보 수집·이용에 동의해야 참여할 수 있습니다.' };

    var lock = LockService.getScriptLock(); lock.waitLock(20000); // 동시에 같은 닉네임으로 가입하는 경우를 막는다
    try {
      if (findByNick(nick)) return { ok: false, field: 'nickname', error: '방금 다른 분이 이 닉네임으로 가입했습니다. 다른 닉네임을 정해 주세요.' };
      var id = 'U' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), salt = Utilities.getUuid(), now = new Date();
      var row = []; row[C.ID] = id; row[C['가입시각']] = now; row[C['성명']] = name; row[C['팀']] = team; row[C['직위']] = pos;
      row[C['내선']] = "'" + ext; row[C['닉네임']] = nick; row[C['비밀번호해시']] = hashPw(pw, salt); row[C['솔트']] = salt;
      row[C['다짐1']] = p1; row[C['다짐2']] = p2; row[C['동의시각']] = now; row[C['상태']] = '정상';
      sheet(SHEET_P).appendRow(row);
      return { ok: true, token: token(id, salt), user: pub(row), records: [], period: period() };
    } finally { lock.releaseLock(); }
  },

  login: function (r) {
    var nick = cleanNick(r.nickname), pw = String(r.password || '');
    if (tooMany('login:' + nick.toLowerCase())) return { ok: false, error: '로그인 시도가 많습니다. 5분 뒤에 다시 시도해 주세요.' };
    var f = findByNick(nick);
    if (!f || hashPw(pw, f.row[C['솔트']]) !== f.row[C['비밀번호해시']]) { fail('login:' + nick.toLowerCase()); return { ok: false, error: '닉네임 또는 비밀번호가 맞지 않습니다.' }; }
    if (f.row[C['상태']] === '정지') return { ok: false, code: 'SUSPENDED', error: suspendedMsg() };
    return { ok: true, token: token(f.row[C.ID], f.row[C['솔트']]), user: pub(f.row), records: userRecords(f.row[C.ID]), period: period() };
  },

  /* 저장된 로그인 확인: 앱을 열 때마다 호출해 정지 여부를 서버 기준으로 다시 보고, 내 기록도 함께 돌려준다. */
  me: function (r) {
    var a = active(r.token); if (a.error) return a.error;
    return { ok: true, user: pub(a.f.row), records: userRecords(a.f.row[C.ID]), period: period() };
  },

  /* 매일 기록: '어제' 하루 기록만 저장한다. 같은 날을 다시 보내면 수정이 된다(하루 1행). */
  saveRecord: function (r) {
    var a = active(r.token); if (a.error) return a.error;
    var u = a.f.row, uid = u[C.ID], p = period();
    var date = String(r.date || ''), yest = ymd(new Date(Date.now() - 864e5));
    if (date !== yest) return { ok: false, error: '어제(' + yest.slice(5).replace('-', '/') + ') 기록만 저장할 수 있습니다. 화면을 새로고침해 주세요.' };
    if (date < p.start || date > p.end) return { ok: false, error: '챌린지 기간(' + p.start + ' ~ ' + p.end + ')의 기록만 저장할 수 있습니다.' };
    var min = Math.round(Number(r.minutes));
    if (!isFinite(min) || min < 0 || min > 1440) return { ok: false, field: 'minutes', error: '사용시간을 0분~24시간 사이로 입력해 주세요.' };
    var prac = pick(r.practices, PRACTICES), fills = pick(r.fills, FILLS);
    if (fills.indexOf('못 했어요') >= 0) fills = ['못 했어요'];
    if (!fills.length) return { ok: false, field: 'fills', error: '줄인 시간을 채운 활동을 골라 주세요. 없으면 \'못 했어요\'를 고릅니다.' };
    var note = str(r.note, 100), share = r.share === true;
    var thumb = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(r.thumb || '') && r.thumb.length < 45000 ? r.thumb : ''; // 시트 칸 한도(5만 자) 안쪽

    // 사진 파일 저장은 몇 초 걸릴 수 있어 잠금 밖에서 먼저 한다
    var newPhoto = '';
    if (r.photo) {
      var m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(r.photo);
      if (!m || r.photo.length > 3000000) return { ok: false, error: '사진을 처리하지 못했습니다. 다른 사진으로 시도해 주세요.' };
      var blob = Utilities.newBlob(Utilities.base64Decode(m[1]), 'image/jpeg', date + '_' + u[C['닉네임']] + '.jpg');
      newPhoto = photoFolder().createFile(blob).getId();
    }

    var lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      var sh = sheet(SHEET_R), rid = uid + '|' + date, found = findRecord(rid), now = new Date();
      var row = found ? found.row.slice() : [];
      var oldPhoto = found ? String(row[R['사진ID']] || '') : '';
      if (oldPhoto && (newPhoto || r.removePhoto)) trashFile(oldPhoto); // 바꾸거나 지운 옛 사진은 휴지통으로
      row[R['기록ID']] = rid; row[R['사용자ID']] = uid; row[R['성명']] = u[C['성명']]; row[R['닉네임']] = u[C['닉네임']]; row[R['팀']] = u[C['팀']];
      row[R['기록일']] = "'" + date; row[R['사용시간(분)']] = min; row[R['실천']] = prac.join(' | '); row[R['채움활동']] = fills.join(' | ');
      row[R['한줄기록']] = note; row[R['공유']] = share ? '공유' : '비공개';
      if (newPhoto) { row[R['사진ID']] = newPhoto; row[R['썸네일']] = thumb; }
      else if (r.removePhoto) { row[R['사진ID']] = ''; row[R['썸네일']] = ''; }
      else if (!found) { row[R['사진ID']] = ''; row[R['썸네일']] = ''; }
      if (!found) row[R['저장시각']] = now; row[R['수정시각']] = found ? now : '';
      for (var i = 0; i < RHEAD.length; i++) if (row[i] === undefined) row[i] = '';
      if (found) sh.getRange(found.index, 1, 1, RHEAD.length).setValues([row]); else sh.appendRow(row);
    } finally { lock.releaseLock(); }
    return { ok: true, edited: !!found, records: userRecords(uid) };
  }
};

/* ---------- 설치 ---------- */
function setup() {
  var p = sheet(SHEET_P);
  if (p.getLastRow() === 0) { p.appendRow(HEAD); p.setFrozenRows(1); p.getRange(1, 1, 1, HEAD.length).setFontWeight('bold'); }
  p.hideColumns(C['비밀번호해시'] + 1, 2); // 비밀번호해시·솔트는 운영자가 볼 필요가 없어 숨긴다
  p.getRange(2, C['상태'] + 1, 1000, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['정상', '정지'], true).build());
  var rs = sheet(SHEET_R);
  if (rs.getLastRow() === 0) { rs.appendRow(RHEAD); rs.setFrozenRows(1); rs.getRange(1, 1, 1, RHEAD.length).setFontWeight('bold'); }
  rs.hideColumns(R['썸네일'] + 1); rs.hideColumns(R['사용자ID'] + 1);
  var s = sheet(SHEET_S);
  if (s.getLastRow() === 0) { s.appendRow(['항목', '값', '설명']); s.setFrozenRows(1); }
  var have = s.getDataRange().getValues().map(function (v) { return String(v[0]); });
  [['참여코드', 'CHANGE-ME', '메신저로 직원에게만 알리는 코드. 바꾸면 그때부터 새 코드로만 가입됩니다.'],
   ['가입허용', '예', '아니오로 바꾸면 신규 가입을 막습니다.'],
   ['정지안내', '운영자 확인이 필요한 계정입니다. 담당자에게 문의해 주세요.', '정지된 계정이 로그인할 때 보이는 문구'],
   ['시작일', "'2026-11-23", '챌린지 첫날(이 날의 기록은 다음 날 입력)'],
   ['종료일', "'2026-12-06", '챌린지 마지막 날(이 날의 기록은 다음 날까지 입력)']
  ].forEach(function (row) { if (have.indexOf(row[0]) < 0) s.appendRow(row); }); // 이미 쓰던 시트에 다시 실행해도 빠진 항목만 더한다
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN_SECRET')) props.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  photoFolder();
}

/* ---------- 도우미 ---------- */
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sheet(n) { var ss = SpreadsheetApp.getActive(); return ss.getSheetByName(n) || ss.insertSheet(n); }
function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function ymd(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function pick(arr, allowed) { return (Array.isArray(arr) ? arr : []).filter(function (v, i, a) { return allowed.indexOf(v) >= 0 && a.indexOf(v) === i; }); }
function cleanNick(v) { return String(v == null ? '' : v).normalize('NFC').trim(); }
function nickError(n) {
  if (n.length < 2 || n.length > 10) return '닉네임은 2~10자로 정해 주세요.';
  if (!/^[가-힣a-zA-Z0-9_]+$/.test(n)) return '닉네임은 한글·영문·숫자·밑줄(_)만 쓸 수 있습니다.';
  if (/^(관리자|운영자|admin|의청이)$/i.test(n)) return '사용할 수 없는 닉네임입니다.';
  return '';
}
function settings() {
  var c = CacheService.getScriptCache(), hit = c.get('settings'); if (hit) return JSON.parse(hit);
  var v = sheet(SHEET_S).getDataRange().getDisplayValues(), o = {};
  for (var i = 1; i < v.length; i++) o[String(v[i][0]).trim()] = String(v[i][1]).trim();
  c.put('settings', JSON.stringify(o), 60); // 설정을 바꾸면 최대 1분 뒤 반영
  return o;
}
function period() { var s = settings(); return { start: s['시작일'] || '2026-11-23', end: s['종료일'] || '2026-12-06' }; }
function codeOk(code) {
  if (tooMany('code')) { Utilities.sleep(1500); return false; }
  var want = String(settings()['참여코드'] || '').trim(), got = String(code || '').trim();
  if (!want || want === 'CHANGE-ME' || got.toLowerCase() !== want.toLowerCase()) { fail('code'); Utilities.sleep(800); return false; }
  return true;
}
/* 틀린 시도 횟수: 참여 코드는 전체 기준 10분에 60회, 로그인은 닉네임별 5분에 8회 */
function tooMany(k) { var n = +CacheService.getScriptCache().get('fail:' + k) || 0; return k === 'code' ? n >= 60 : n >= 8; }
function fail(k) { var c = CacheService.getScriptCache(), n = (+c.get('fail:' + k) || 0) + 1; c.put('fail:' + k, String(n), k === 'code' ? 600 : 300); }
function findByNick(nick) {
  var v = sheet(SHEET_P).getDataRange().getValues(), key = nick.toLowerCase();
  for (var i = 1; i < v.length; i++) if (String(v[i][C['닉네임']]).toLowerCase() === key) return { row: v[i], index: i + 1 };
  return null;
}
function findById(id) {
  var v = sheet(SHEET_P).getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (v[i][C.ID] === id) return { row: v[i], index: i + 1 };
  return null;
}
function findRecord(rid) {
  var v = sheet(SHEET_R).getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (v[i][R['기록ID']] === rid) return { row: v[i], index: i + 1 };
  return null;
}
/* 내 기록 목록(최대 14행). 썸네일은 무거워 빼고 사진 유무만 보낸다. */
function userRecords(uid) {
  var v = sheet(SHEET_R).getDataRange().getDisplayValues(), outv = [];
  for (var i = 1; i < v.length; i++) if (v[i][R['사용자ID']] === uid) outv.push({
    date: v[i][R['기록일']], minutes: +v[i][R['사용시간(분)']] || 0,
    practices: v[i][R['실천']] ? v[i][R['실천']].split(' | ') : [], fills: v[i][R['채움활동']] ? v[i][R['채움활동']].split(' | ') : [],
    note: v[i][R['한줄기록']], share: v[i][R['공유']] === '공유', photo: !!v[i][R['사진ID']]
  });
  return outv.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}
function active(t) {
  var f = auth(t);
  if (!f) return { error: { ok: false, code: 'LOGOUT', error: '다시 로그인해 주세요.' } };
  if (f.row[C['상태']] === '정지') return { error: { ok: false, code: 'SUSPENDED', error: suspendedMsg() } };
  return { f: f };
}
/* 사진 폴더: 스크립트 속성 PHOTO_FOLDER_ID가 없으면 내 드라이브에 비공개 폴더를 만들어 기억한다. */
function photoFolder() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) try { return DriveApp.getFolderById(id); } catch (e) {}
  var f = DriveApp.createFolder('폰프리청챌린지_사진'); props.setProperty('PHOTO_FOLDER_ID', f.getId()); return f;
}
function trashFile(id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {} }
function hex(bytes) { return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function hashPw(pw, salt) {
  var h = salt + '|' + pw;
  for (var i = 0; i < HASH_ROUNDS; i++) h = hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + '|' + salt, Utilities.Charset.UTF_8));
  return h;
}
/* 로그인 토큰: 서버 비밀값으로 서명한 'ID.서명'. 솔트가 바뀌면(비밀번호 재설정) 이전 토큰은 자동으로 무효가 된다. */
function token(id, salt) {
  var secret = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  return id + '.' + hex(Utilities.computeHmacSha256Signature(id + '|' + salt, secret)).slice(0, 40);
}
function auth(t) {
  var id = String(t || '').split('.')[0]; if (!id) return null;
  var f = findById(id); return f && token(id, f.row[C['솔트']]) === t ? f : null;
}
function pub(row) { return { nickname: row[C['닉네임']], name: row[C['성명']], team: row[C['팀']], position: row[C['직위']], pledges: [row[C['다짐1']], row[C['다짐2']]].filter(String) }; }
function suspendedMsg() { return settings()['정지안내'] || '운영자 확인이 필요한 계정입니다.'; }
