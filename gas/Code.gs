/* 의좋은 폰프리 청 챌린지 — Apps Script 서버
 * 화면(GitHub Pages)이 fetch POST(text/plain, JSON 본문)로 호출한다. 비밀번호가 주소창·로그에 남지 않도록 GET/JSONP는 쓰지 않는다.
 * 처음 한 번 편집기에서 setup()을 실행하면 '참가자'·'설정' 탭과 서명용 비밀값이 만들어진다. */

var SHEET_P = '참가자', SHEET_S = '설정';
var HEAD = ['ID','가입시각','성명','팀','직위','내선','닉네임','비밀번호해시','솔트','다짐1','다짐2','동의시각','상태'];
var C = {}; HEAD.forEach(function (h, i) { C[h] = i; });
var HASH_ROUNDS = 300; // computeDigest 1회 약 1ms 미만 → 300회면 저장·로그인 지연이 체감되지 않으면서 무차별 대입을 늦춘다

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
      return { ok: true, token: token(id, salt), user: pub(row) };
    } finally { lock.releaseLock(); }
  },

  login: function (r) {
    var nick = cleanNick(r.nickname), pw = String(r.password || '');
    if (tooMany('login:' + nick.toLowerCase())) return { ok: false, error: '로그인 시도가 많습니다. 5분 뒤에 다시 시도해 주세요.' };
    var f = findByNick(nick);
    if (!f || hashPw(pw, f.row[C['솔트']]) !== f.row[C['비밀번호해시']]) { fail('login:' + nick.toLowerCase()); return { ok: false, error: '닉네임 또는 비밀번호가 맞지 않습니다.' }; }
    if (f.row[C['상태']] === '정지') return { ok: false, code: 'SUSPENDED', error: suspendedMsg() };
    return { ok: true, token: token(f.row[C.ID], f.row[C['솔트']]), user: pub(f.row) };
  },

  /* 저장된 로그인 확인: 앱을 열 때마다 호출해 정지 여부를 서버 기준으로 다시 본다. */
  me: function (r) {
    var f = auth(r.token);
    if (!f) return { ok: false, code: 'LOGOUT', error: '다시 로그인해 주세요.' };
    if (f.row[C['상태']] === '정지') return { ok: false, code: 'SUSPENDED', error: suspendedMsg() };
    return { ok: true, user: pub(f.row) };
  }
};

/* ---------- 설치 ---------- */
function setup() {
  var p = sheet(SHEET_P);
  if (p.getLastRow() === 0) { p.appendRow(HEAD); p.setFrozenRows(1); p.getRange(1, 1, 1, HEAD.length).setFontWeight('bold'); }
  // 비밀번호해시·솔트는 운영자가 볼 필요가 없어 숨긴다
  p.hideColumns(C['비밀번호해시'] + 1, 2);
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(['정상', '정지'], true).build();
  p.getRange(2, C['상태'] + 1, 1000, 1).setDataValidation(rule);
  var s = sheet(SHEET_S);
  if (s.getLastRow() === 0) {
    s.appendRow(['항목', '값', '설명']);
    s.appendRow(['참여코드', 'CHANGE-ME', '메신저로 직원에게만 알리는 코드. 바꾸면 그때부터 새 코드로만 가입됩니다.']);
    s.appendRow(['가입허용', '예', '아니오로 바꾸면 신규 가입을 막습니다.']);
    s.appendRow(['정지안내', '운영자 확인이 필요한 계정입니다. 담당자에게 문의해 주세요.', '정지된 계정이 로그인할 때 보이는 문구']);
    s.setFrozenRows(1);
  }
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN_SECRET')) props.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
}

/* ---------- 도우미 ---------- */
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sheet(n) { var ss = SpreadsheetApp.getActive(); return ss.getSheetByName(n) || ss.insertSheet(n); }
function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function cleanNick(v) { return String(v == null ? '' : v).normalize('NFC').trim(); }
function nickError(n) {
  if (n.length < 2 || n.length > 10) return '닉네임은 2~10자로 정해 주세요.';
  if (!/^[가-힣a-zA-Z0-9_]+$/.test(n)) return '닉네임은 한글·영문·숫자·밑줄(_)만 쓸 수 있습니다.';
  if (/^(관리자|운영자|admin|의청이)$/i.test(n)) return '사용할 수 없는 닉네임입니다.';
  return '';
}
function settings() {
  var c = CacheService.getScriptCache(), hit = c.get('settings'); if (hit) return JSON.parse(hit);
  var v = sheet(SHEET_S).getDataRange().getValues(), o = {};
  for (var i = 1; i < v.length; i++) o[String(v[i][0]).trim()] = String(v[i][1]);
  c.put('settings', JSON.stringify(o), 60); // 코드를 바꾸면 최대 1분 뒤 반영
  return o;
}
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
