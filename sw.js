/*
 * WanderSync App Shell Service Worker
 * ------------------------------------------------------------------
 * 目的：iPhone「添加到主屏幕」的独立 Web App 每次启动都是真·冷启动
 * （iOS 会杀掉进程、没有 bfcache，且它的存储容器和 Safari 完全隔离，
 * 之前做的 localStorage 缓存优先渲染在这里完全用不上）。没有 Service
 * Worker 就意味着每次点桌面图标都要重新联网下载 index.html + 3 个 CSS
 * + 字体文件，这就是白屏的根源。这个文件只做一件事：把这些"壳"资源
 * 缓存到 Cache Storage 里，离线/弱网时也能立刻画出界面。
 *
 * 明确不做的事情（写在这里防止以后不小心改坏）：
 *   - 不缓存任何跨域请求（gstatic 的 Firebase SDK、Firestore 的实时
 *     通道、identitytoolkit 鉴权、Gemini API）。这些如果被 SW 缓存，
 *     会产生"离线一段时间后的数据是旧的"这种极难排查的状态，所以一律
 *     直接放行给网络，SW 完全不拦截。
 *   - 不做 skipWaiting()。新版本要等下一次启动才会激活，因为 iOS 的
 *     主屏 App 反正每次都是冷启动，没有"同一次会话里资源被偷换"的
 *     风险，用不着抢着立刻接管。
 */

const SW_VERSION = 'v1';
const CACHE_NAME = `wandersync-shell-${SW_VERSION}`;

// 所有路径都用相对路径：GitHub Pages 项目页跑在
// <user>.github.io/WanderSync/ 这种子路径下，写成 /index.html 这种
// 绝对路径会直接 404。
const PRECACHE_URLS = [
  './',
  './index.html',
  './tailwind.min.css',
  './fontawesome-subset.css',
  './poppins-subset.css',
  './fonts/fa-solid-900-subset.woff2',
  './fonts/poppins-latin-700-normal.woff2',
  './fonts/poppins-latin-900-normal.woff2',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 逐个 add，单个资源 404/网络失败不应该让整个 install 失败——
    // 哪怕只缓存上了 index.html，也比什么都没有强。
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if (res && res.ok) {
          await cache.put(url, res);
        }
      } catch (e) {
        // 安装阶段联网失败很正常（比如离线状态下第一次注册），
        // 不阻塞其余资源的缓存。
      }
    }));
  })());
  // 不调用 self.skipWaiting()：新 SW 保持 waiting，直到旧 SW 的所有
  // 客户端都关闭后才会在下一次启动时自然 activate。
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清理旧版本缓存：壳资源要能更新，永远无法升级的缓存是真正的隐患。
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('wandersync-shell-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

function isCacheableResponse(res) {
  // 不缓存非 200（包括 404/500）和 opaque 响应（跨域 no-cors 请求返回
  // 的那种状态码/内容都读不到的响应，缓存了也没法判断好坏）。
  return !!res && res.status === 200 && res.type === 'basic';
}

// PRECACHE_URLS 转成绝对 URL 集合，fetch 时按绝对地址比对，不依赖
// pathname 字符串拼接（GitHub Pages 子路径 + 相对路径拼起来很容易错）。
const PRECACHE_ABSOLUTE_URLS = new Set(
  PRECACHE_URLS.map((u) => new URL(u, self.registration.scope).href)
);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 只拦截同源的静态壳资源。Firebase SDK (gstatic)、Firestore 实时
  // 通道、identitytoolkit 鉴权、Gemini API 一律直接走网络，SW 完全
  // 不插手——缓存这些会导致极难排查的"数据是旧的"问题。
  if (url.origin !== self.location.origin) return;

  // 导航请求（用户打开/刷新页面）：stale-while-revalidate，先用缓存
  // 秒开壳，同时后台悄悄去更新缓存，供下一次启动用。
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      // 先精确匹配这次导航的 URL（比如 "/WanderSync/" 目录本身），
      // 匹配不到（比如清缓存后第一次跑）再退到 index.html 的缓存副本，
      // 两者内容一致（GitHub Pages 对目录请求返回的就是 index.html）。
      const cached = (await cache.match(request)) || (await cache.match('./index.html'));

      const networkFetch = fetch(request).then((res) => {
        if (isCacheableResponse(res)) {
          cache.put(request, res.clone());
        }
        return res;
      }).catch(() => null);

      if (cached) {
        // 后台刷新，不等待、不阻塞当前这次渲染。
        networkFetch.catch(() => {});
        return cached;
      }

      const networkRes = await networkFetch;
      if (networkRes) return networkRes;

      // 网络也不通、缓存也没有：没有更好的兜底了，只能把错误抛回去，
      // 交给浏览器显示默认的离线页面。
      return new Response('WanderSync 离线且本地暂无缓存，请在联网状态下先打开一次应用。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })());
    return;
  }

  // 其余同源静态资源（CSS / 字体 / manifest / 图标）：缓存优先，命中
  // 直接用，未命中则回源网络并写入缓存，供下次使用。
  const isShellAsset = PRECACHE_ABSOLUTE_URLS.has(url.href) ||
    request.destination === 'style' || request.destination === 'font' ||
    request.destination === 'image';
  if (isShellAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const res = await fetch(request);
        if (isCacheableResponse(res)) {
          cache.put(request, res.clone());
        }
        return res;
      } catch (e) {
        // 离线且未缓存过的静态资源：没有更好的选择，只能让请求失败。
        return new Response('', { status: 504, statusText: 'Offline and not cached' });
      }
    })());
  }
  // 其他同源请求（未列出的类型）：不拦截，直接走默认网络行为。
});
