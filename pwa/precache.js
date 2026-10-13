// 서비스 워커와 앱이 함께 사용하는 오프라인 파일 목록.
// 앱을 수정해 다시 올릴 때는 FQ_VERSION 숫자를 올린다. (풀이 기록은 IndexedDB에 있어 지워지지 않는다)
self.FQ_VERSION = '1.2.0';
self.FQ_PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './precache.js',
  './config.js',
  './js/app.js',
  './js/db.js',
  './data/questions.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];
