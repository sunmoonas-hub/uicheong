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
    CacheService.getScriptCache().remove('teams'); // 새 기록이 순위에 바로 반영되도록
    return { ok: true, edited: !!found, records: userRecords(uid) };
  },

  /* 게시판: '공유'로 저장한 기록만, 최근 저장 순. 정지된 사람 글과 운영자가 '숨김'으로 바꾼 글은 뺀다.
   * 썸네일(약 20KB)을 함께 보내므로 한 번에 12개씩 나눠 준다. */
  board: function (r) {
    var a = active(r.token); if (a.error) return a.error;
    var me = a.f.row[C.ID], bad = suspendedIds(), v = sheet(SHEET_R).getDataRange().getValues(), list = [];
    for (var i = 1; i < v.length; i++) {
      var w = v[i];
      if (w[R['공유']] !== '공유' || bad[w[R['사용자ID']]]) continue;
      list.push({ i: i, t: +new Date(w[R['수정시각']] || w[R['저장시각']]) || 0 });
    }
    list.sort(function (x, y) { return y.t - x.t; });
    var off = Math.max(0, parseInt(r.offset, 10) || 0), PAGE = 12;
    var items = list.slice(off, off + PAGE).map(function (o) {
      var w = v[o.i];
      return { id: w[R['기록ID']], nickname: w[R['닉네임']], team: w[R['팀']], date: String(w[R['기록일']]).replace(/^'/, ''),
        fills: w[R['채움활동']] ? String(w[R['채움활동']]).split(' | ') : [], practices: w[R['실천']] ? String(w[R['실천']]).split(' | ').length : 0,
        note: w[R['한줄기록']], thumb: w[R['썸네일']] || '', photo: !!w[R['사진ID']], mine: w[R['사용자ID']] === me, at: o.t };
    });
    return { ok: true, items: items, more: off + PAGE < list.length, total: list.length };
  },

  /* 사진 크게 보기: Drive 비공개 파일을 이 앱을 통해서만 보여 준다(공개 링크를 만들지 않는다). */
  photo: function (r) {
    var a = active(r.token); if (a.error) return a.error;
    var f = findRecord(String(r.id || ''));
    if (!f || !f.row[R['사진ID']]) return { ok: false, error: '사진을 찾을 수 없습니다.' };
    if (f.row[R['공유']] !== '공유' && f.row[R['사용자ID']] !== a.f.row[C.ID]) return { ok: false, error: '볼 수 없는 사진입니다.' };
    try {
      var b = DriveApp.getFileById(f.row[R['사진ID']]).getBlob();
      return { ok: true, src: 'data:image/jpeg;base64,' + Utilities.base64Encode(b.getBytes()) };
    } catch (e) { return { ok: false, error: '사진을 불러오지 못했습니다.' }; }
  },

  /* 팀 참여율 = 팀 기록 수 ÷ (팀 가입자 수 × 지금까지 기록할 수 있었던 날 수).
   * 팀별 정원을 알 수 없어 '가입한 사람이 얼마나 꾸준히 기록했나'로 잰다. 2분 캐시. */
  teams: function (r) {
    var a = active(r.token); if (a.error) return a.error;
    var c = CacheService.getScriptCache(), hit = c.get('teams');
    var res = hit ? JSON.parse(hit) : teamStats();
    if (!hit) c.put('teams', JSON.stringify(res), 120);
    res.ok = true; res.myTeam = a.f.row[C['팀']];
    return res;
  }
};

function suspendedIds() {
  var v = sheet(SHEET_P).getDataRange().getValues(), o = {};
  for (var i = 1; i < v.length; i++) if (v[i][C['상태']] === '정지') o[v[i][C.ID]] = 1;
  return o;
}
function teamStats() {
  var p = period(), yest = ymd(new Date(Date.now() - 864e5)), last = yest < p.end ? yest : p.end;
  var days = last < p.start ? 0 : Math.round((new Date(last) - new Date(p.start)) / 864e5) + 1;
  var users = sheet(SHEET_P).getDataRange().getValues(), t = {}, uTeam = {};
  for (var i = 1; i < users.length; i++) {
    var u = users[i]; if (u[C['상태']] === '정지' || !u[C.ID]) continue;
    var name = u[C['팀']]; uTeam[u[C.ID]] = name;
    (t[name] = t[name] || { team: name, members: 0, records: 0, yesterday: 0 }).members++;
  }
  var rec = sheet(SHEET_R).getDataRange().getValues();
  for (var j = 1; j < rec.length; j++) {
    var w = rec[j], tm = uTeam[w[R['사용자ID']]], d = String(w[R['기록일']]).replace(/^'/, '');
    if (!tm || d < p.start || d > last) continue;
    t[tm].records++; if (d === yest) t[tm].yesterday++;
  }
  var list = Object.keys(t).map(function (k) { var x = t[k]; x.rate = days && x.members ? Math.round(x.records / (x.members * days) * 1000) / 10 : 0; return x; });
  list.sort(function (x, y) { return y.rate - x.rate || y.members - x.members; });
  return { days: days, teams: list, updated: +new Date() };
}

/* ---------- 설치 ---------- */
function setup() {
  var p = sheet(SHEET_P);
  if (p.getLastRow() === 0) { p.appendRow(HEAD); p.setFrozenRows(1); p.getRange(1, 1, 1, HEAD.length).setFontWeight('bold'); }
  p.hideColumns(C['비밀번호해시'] + 1, 2); // 비밀번호해시·솔트는 운영자가 볼 필요가 없어 숨긴다
  p.getRange(2, C['상태'] + 1, 1000, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['정상', '정지'], true).build());
  var rs = sheet(SHEET_R);
  if (rs.getLastRow() === 0) { rs.appendRow(RHEAD); rs.setFrozenRows(1); rs.getRange(1, 1, 1, RHEAD.length).setFontWeight('bold'); }
  rs.hideColumns(R['썸네일'] + 1); rs.hideColumns(R['사용자ID'] + 1);
  // 운영자가 부적절한 글을 '숨김'으로 바꾸면 게시판에서 빠진다(기록·참여율에는 그대로 남음)
  rs.getRange(2, R['공유'] + 1, 3000, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['공유', '비공개', '숨김'], true).build());
  var s = sheet(SHEET_S);
  if (s.getLastRow() === 0) { s.appendRow(['항목', '값', '설명']); s.setFrozenRows(1); }
  var have = s.getDataRange().getValues().map(function (v) { return String(v[0]); });
  [['참여코드', 'CHANGE-ME', '메신저로 직원에게만 알리는 코드. 바꾸면 그때부터 새 코드로만 가입됩니다.'],
   ['가입허용', '예', '아니오로 바꾸면 신규 가입을 막습니다.'],
   ['정지안내', '운영자 확인이 필요한 계정입니다. 담당자에게 문의해 주세요.', '정지된 계정이 로그인할 때 보이는 문구'],
   ['시작일', "'2026-11-23", '챌린지 첫날(이 날의 기록은 다음 날 입력)'],
   ['종료일', "'2026-12-06", '챌린지 마지막 날(이 날의 기록은 다음 날까지 입력)'],
   ['관리자비밀번호', 'CHANGE-ME', '관리자 페이지 비밀번호. 바꾸면 기존 관리자 로그인이 모두 풀립니다.']
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
// normalize('NFC')는 쓰지 않는다: Apps Script V8에서 한글이 정규화 후 정규식([가-힣])에 맞지 않아 모든 한글 닉네임이 거절됐다(2026-11-21 실측). 화면에서 이미 NFC로 보낸다
function cleanNick(v) { return String(v == null ? '' : v).trim(); }
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

/* ===================== 관리자 =====================
 * 관리자 비밀번호는 '설정' 탭의 '관리자비밀번호' 행에 둔다(없으면 첫 로그인 시도 때 CHANGE-ME로 행을 만든다).
 * 로그인하면 비밀번호로 서명한 토큰을 주므로, 비밀번호를 바꾸면 그전 관리자 로그인은 모두 풀린다. */
function adminPw() {
  var s = settings();
  if (!('관리자비밀번호' in s)) {
    sheet(SHEET_S).appendRow(['관리자비밀번호', 'CHANGE-ME', '관리자 페이지 비밀번호. 바꾸면 기존 관리자 로그인이 모두 풀립니다.']);
    CacheService.getScriptCache().remove('settings');
    return 'CHANGE-ME';
  }
  return String(s['관리자비밀번호'] || '').trim();
}
function adminToken(pw) {
  var secret = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  return 'A.' + hex(Utilities.computeHmacSha256Signature('admin|' + pw, secret)).slice(0, 40);
}
function adminOk(t) { var pw = adminPw(); return pw && pw !== 'CHANGE-ME' && t === adminToken(pw); }
var DENY = { ok: false, code: 'ADMIN', error: '관리자 로그인이 필요합니다.' };

ACTIONS.adminLogin = function (r) {
  if (tooMany('admin')) return { ok: false, error: '시도가 많습니다. 5분 뒤에 다시 시도해 주세요.' };
  var pw = adminPw();
  if (pw === 'CHANGE-ME' || !pw) return { ok: false, error: '시트 설정 탭의 관리자비밀번호를 먼저 정해 주세요.' };
  if (String(r.password || '') !== pw) { fail('admin'); Utilities.sleep(600); return { ok: false, error: '관리자 비밀번호가 맞지 않습니다.' }; }
  return { ok: true, atoken: adminToken(pw) };
};

/* 한 번에 필요한 것을 모두: 참가자(기록 일수 포함), 요약, 팀 참여율 */
ACTIONS.adminData = function (r) {
  if (!adminOk(r.atoken)) return DENY;
  var p = period(), yest = ymd(new Date(Date.now() - 864e5));
  var users = sheet(SHEET_P).getDataRange().getValues(), rec = sheet(SHEET_R).getDataRange().getValues(), cnt = {}, last = {}, yCount = 0, shared = 0, hidden = 0;
  for (var j = 1; j < rec.length; j++) {
    var w = rec[j], uid = w[R['사용자ID']], d = String(w[R['기록일']]).replace(/^'/, '');
    if (d >= p.start && d <= p.end) { cnt[uid] = (cnt[uid] || 0) + 1; if (!last[uid] || d > last[uid]) last[uid] = d; if (d === yest) yCount++; }
    if (w[R['공유']] === '공유') shared++; else if (w[R['공유']] === '숨김') hidden++;
  }
  var list = [];
  for (var i = 1; i < users.length; i++) {
    var u = users[i]; if (!u[C.ID]) continue;
    list.push({ id: u[C.ID], name: u[C['성명']], team: u[C['팀']], position: u[C['직위']], ext: String(u[C['내선']]).replace(/^'/, ''),
      nickname: u[C['닉네임']], joined: u[C['가입시각']] ? ymd(new Date(u[C['가입시각']])) : '', status: u[C['상태']] || '정상',
      days: cnt[u[C.ID]] || 0, last: last[u[C.ID]] || '', pledges: [u[C['다짐1']], u[C['다짐2']]].filter(String) });
  }
  var ts = teamStats();
  return { ok: true, period: p, yesterday: yest, users: list, summary: { members: list.length, active: list.filter(function (x) { return x.status !== '정지'; }).length,
    yesterday: yCount, records: rec.length - 1, completed: list.filter(function (x) { return x.days >= 10 && x.status !== '정지'; }).length, shared: shared, hidden: hidden }, teams: ts };
};

ACTIONS.adminSetStatus = function (r) {
  if (!adminOk(r.atoken)) return DENY;
  if (['정상', '정지'].indexOf(r.status) < 0) return { ok: false, error: '상태 값이 올바르지 않습니다.' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var f = findById(String(r.id || '')); if (!f) return { ok: false, error: '참가자를 찾을 수 없습니다.' };
    sheet(SHEET_P).getRange(f.index, C['상태'] + 1).setValue(r.status);
  } finally { lock.releaseLock(); }
  CacheService.getScriptCache().remove('teams');
  return { ok: true };
};

/* 비밀번호 초기화: 임시 비밀번호를 만들어 관리자에게만 보여 준다. 솔트가 바뀌어 그 사람의 기존 로그인은 풀린다. */
ACTIONS.adminResetPw = function (r) {
  if (!adminOk(r.atoken)) return DENY;
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789', temp = '';
  for (var k = 0; k < 8; k++) temp += chars.charAt(Math.floor(Math.random() * chars.length));
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var f = findById(String(r.id || '')); if (!f) return { ok: false, error: '참가자를 찾을 수 없습니다.' };
    var salt = Utilities.getUuid(), sh = sheet(SHEET_P);
    sh.getRange(f.index, C['비밀번호해시'] + 1, 1, 2).setValues([[hashPw(temp, salt), salt]]);
  } finally { lock.releaseLock(); }
  return { ok: true, temp: temp };
};

/* 게시글 관리: 공유·숨김 글을 최근 순으로 20개씩 */
ACTIONS.adminPosts = function (r) {
  if (!adminOk(r.atoken)) return DENY;
  var v = sheet(SHEET_R).getDataRange().getValues(), list = [];
  for (var i = 1; i < v.length; i++) if (v[i][R['공유']] === '공유' || v[i][R['공유']] === '숨김') list.push({ i: i, t: +new Date(v[i][R['수정시각']] || v[i][R['저장시각']]) || 0 });
  list.sort(function (x, y) { return y.t - x.t; });
  var off = Math.max(0, parseInt(r.offset, 10) || 0), PAGE = 20;
  return { ok: true, more: off + PAGE < list.length, items: list.slice(off, off + PAGE).map(function (o) {
    var w = v[o.i];
    return { id: w[R['기록ID']], name: w[R['성명']], nickname: w[R['닉네임']], team: w[R['팀']], date: String(w[R['기록일']]).replace(/^'/, ''),
      note: w[R['한줄기록']], thumb: w[R['썸네일']] || '', share: w[R['공유']], at: o.t };
  }) };
};

ACTIONS.adminSetShare = function (r) {
  if (!adminOk(r.atoken)) return DENY;
  if (['공유', '숨김'].indexOf(r.share) < 0) return { ok: false, error: '값이 올바르지 않습니다.' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var f = findRecord(String(r.id || '')); if (!f) return { ok: false, error: '글을 찾을 수 없습니다.' };
    sheet(SHEET_R).getRange(f.index, R['공유'] + 1).setValue(r.share);
  } finally { lock.releaseLock(); }
  return { ok: true };
};
