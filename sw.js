/* 의좋은 폰프리 청 챌린지 — 서비스 워커
 * 크롬(안드로이드)이 '앱 설치'를 허락하려면 fetch를 처리하는 서비스 워커가 있어야 한다.
 * 화면이 옛 버전으로 굳지 않도록 캐시는 쓰지 않고, 모든 요청을 그대로 네트워크로 보낸다.
 * 인터넷이 끊겼을 때 첫 화면만은 보여 주려고 index.html 하나만 예비로 둔다. */
var OFFLINE = 'pf-offline-v1';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(OFFLINE).then(function (c) { return c.addAll(['./']); }).catch(function () {}));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== OFFLINE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // 서버(Apps Script) 요청은 건드리지 않는다
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone(); caches.open(OFFLINE).then(function (c) { c.put('./', copy); });
      return res;
    }).catch(function () { return caches.match('./'); }));
  }
});
