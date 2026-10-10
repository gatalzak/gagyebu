// 오프라인에서도 열리도록 화면 파일을 저장해 둔다.
// 온라인이면 항상 새 파일을 먼저 받아서(network-first) 업데이트가 바로 반영된다.
const CACHE = "gagyebu-v62";
const FILES = [
  "./", "index.html", "style.css", "app.js", "store.js", "sync.js", "fx.js", "config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))) // 새 버전 파일로 저장
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // 구글 API 등은 건드리지 않음
  // cache: "no-cache" → 브라우저 HTTP 캐시(GitHub Pages는 10분)를 건너뛰고 서버에 새 버전을 확인한다.
  // 화면 이동(navigate) 요청은 옵션을 붙여 다시 만들 수 없어서 주소로 요청한다.
  const fresh = e.request.mode === "navigate"
    ? fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" })
    : fetch(e.request, { cache: "no-cache" });
  e.respondWith(
    fresh
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
