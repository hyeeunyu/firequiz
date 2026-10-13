/* 서비스 워커 — 앱 화면·문제은행·모범답안을 기기에 캐시해 오프라인 실행을 보장한다. */
importScripts('./precache.js');

const CACHE = 'firequiz-' + self.FQ_VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // HTTP 캐시를 거치지 않고 최신 파일을 받는다. 하나라도 실패하면 설치 실패 → 기존 버전 유지.
    await cache.addAll(self.FQ_PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // 이전 버전의 "앱 파일 캐시"만 삭제한다. 풀이 기록(IndexedDB)은 건드리지 않는다.
    await Promise.all(keys.filter((k) => k.startsWith('firequiz-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // Apps Script POST 등은 그대로 네트워크로
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // 외부 도메인은 관여하지 않음

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match('./index.html')) || fetch(req);
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});
