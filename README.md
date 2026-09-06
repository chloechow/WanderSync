# WanderSync

一个单页面的旅行行程规划应用：`index.html`（HTML + 一段内联的 `type="module"` 脚本）
配合 `tailwind.min.css`，数据存放在 Firebase Firestore，部署在 GitHub Pages 上。

> ⚠️ **本仓库是公开（Public）仓库。** 任何提交到这里的内容都是全世界可见的，
> 这一点在下面涉及密钥的部分尤其重要，请务必读完再操作。

## 目录

- [Service Worker / PWA 离线壳缓存](#service-worker--pwa-离线壳缓存)
- [Firestore 数据备份](#firestore-数据备份)
- [部署 Firestore 安全规则 (firestore.rules)](#部署-firestore-安全规则-firestorerules)
- [切换新规则前必须确认的前置条件](#切换新规则前必须确认的前置条件)

---

## Service Worker / PWA 离线壳缓存

`sw.js` + `manifest.json` 是专门为「iPhone 主屏 App」这个场景做的：iOS
上「添加到主屏幕」生成的独立 Web App，跟 Safari 标签页完全是两回事——
存储容器互相隔离（Safari 里的 localStorage 缓存对它毫无意义），系统
还会激进地杀掉它的进程，导致**每一次点桌面图标都是真正的冷启动**。
没有 Service Worker 的话，这意味着每次打开都要重新联网下载
`index.html` + 3 个 CSS 文件 + 字体 + Firebase 模块，这就是那个「每次
都转圈圈半天」的白屏的根源。

### 缓存了什么，没缓存什么

`sw.js` 只做「App 壳」的离线缓存，缓存范围是显式列出的一份白名单
（`sw.js` 里的 `PRECACHE_URLS`）：

- `index.html`、`tailwind.min.css`、`fontawesome-subset.css`、
  `poppins-subset.css`
- 三个字体子集（`fonts/*.woff2`）
- `manifest.json`

**明确不缓存、永远直连网络的东西**（`sw.js` 里 `url.origin !==
self.location.origin` 这一行拦下的）：

- Firebase SDK（`www.gstatic.com`）
- Firestore 实时同步通道（`firestore.googleapis.com`）
- 匿名鉴权（`identitytoolkit.googleapis.com`）
- Gemini API 调用

这些是**跨域**请求，`sw.js` 一律不拦截、直接放行给浏览器原生网络栈。
这是有意为之：把这些也缓存起来，会制造出"看起来能用，但数据是过期
的"这种极难排查的状态，得不偿失——缓存只用来保证壳能秒开，行程数据
永远只信任 Firestore 的实时快照。

导航请求（打开/刷新页面本身）用的是 stale-while-revalidate：先用
缓存里的 `index.html` 立刻画出界面，同时在后台悄悄发一次网络请求去
刷新缓存，供下一次启动使用——不会让用户在当前这次打开里等网络。

### 版本更新怎么生效

`sw.js` 顶部的 `SW_VERSION` 常量决定 Cache Storage 的名字
（`wandersync-shell-v1` 这种）。改了壳资源（CSS/字体/index.html 的
静态结构）之后，把这个版本号往上加一位，浏览器就会：

1. 装上新版本的 `sw.js`（`install` 事件里重新抓取一遍
   `PRECACHE_URLS`，写进新版本号的缓存）；
2. **不会**立刻抢占当前页面（`sw.js` 故意不调用
   `self.skipWaiting()`）——新版本进入 `waiting` 状态，等用户关掉所有
   打开的标签页/主屏 App、下一次重新启动时才会 `activate`。iOS 主屏
   App 反正每次都是冷启动，晚一次启动生效完全不影响体验，换来的是
   不会在用户还在用的时候把资源从脚下抽走；
3. `activate` 时会清掉所有旧版本号的缓存（`wandersync-shell-v0` 之类），
   不会无限堆积。

### `?sw=off`：强制卸载逃生舱

访问地址后面加上 `?sw=off`（比如
`https://xxx.github.io/WanderSync/?sw=off`），页面会：

1. 注销当前源上所有已注册的 Service Worker；
2. 删除它建的所有 Cache Storage 缓存；
3. 去掉 `?sw=off` 参数，原地刷新一次干净页面。

**这个分支跑完之后什么缓存都不剩，接下来的每一次打开都会重新走一遍
"是否要重新注册 SW" 的正常逻辑**（不是永久关闭），用来处理这几种场景：

- 预览分支（比如某个 `claude/*` 分支）被提升为生产环境部署之后，想
  确保线上用户看到的不是预览阶段残留的缓存；
- 怀疑某个问题是 Service Worker 缓存导致的（页面表现跟预期的源码
  对不上），想验证"排除缓存变量之后问题还在不在"；
- 本地开发时想每次都拿到最新资源，不想等版本号轮换。

### 怎么在 iPhone 主屏 App 上测试

Service Worker **只在 HTTPS 或 localhost 下工作**，GitHub Pages 天然
是 HTTPS，可以直接用真机测：

1. 用 Safari 打开线上地址，「分享」→「添加到主屏幕」；
2. 打开一次主屏图标，确认能正常登录/看到行程（这一步是让 SW 把壳
   资源缓存进去）；
3. **完全退出这个主屏 App**（从 App 切换器里上滑关掉，不是按 Home 键
   切到后台——iOS 对纯粹切到后台的 Web App 不一定会真的杀进程，
   验证冷启动必须彻底关掉）；
4. 打开手机的飞行模式（或者关 Wi-Fi + 蜂窝数据），**断网**；
5. 再点一次主屏图标——如果登录页 / 缓存的行程界面能正常画出来（哪怕
   云端数据这时候连不上、显示"离线模式"角标），说明 SW 生效了；
   如果还是长时间白屏，大概率是第 2 步没有先联网打开过一次，或者
   Service Worker 没注册成功（可以用 Mac Safari 的「开发」菜单远程
   调试这台 iPhone，看 Application 面板里 Service Worker 的状态）。

---

## Firestore 数据备份

Firebase 的官方托管导出功能（`gcloud firestore export`，或控制台里的
「导入/导出」）**需要 Blaze（按量计费）方案，Spark（免费）方案不提供这个入口**。
本仓库现状是 Spark 方案，所以 `tools/backup-firestore.mjs` 这个脚本的存在
就是为了替代官方导出功能：它用 `firebase-admin` 递归遍历数据库里的所有
collection / document（不管嵌套多深），把每份文档导出成一个 JSON 文件。

### 快速开始

```bash
# 1. 获取服务账号私钥
#    Firebase 控制台 → 齿轮图标「项目设置」→「服务账号」标签页
#    → 「生成新的私钥」，会下载一个 .json 文件

# 2. 设置环境变量指向这个文件（不要移动/复制到仓库目录里！）
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your-project-firebase-adminsdk-xxxxx.json"

# 3. 安装依赖
cd tools
npm install

# 4. 运行备份
node backup-firestore.mjs
```

备份结果会写到仓库根目录的 `backups/<导出时间戳>/` 下，按 Firestore 的
collection/document 路径生成对应的目录结构，每个文档一个 `.json` 文件，
另外还有一份 `_manifest.json` 记录本次导出的统计信息和完整文档路径清单。

完整的参数说明、导出数据的编码约定（Timestamp/GeoPoint/引用/二进制字段
如何被转换成可回填的 JSON 格式）、以及这个脚本是怎么被验证过的，见
[`tools/README.md`](./tools/README.md)。

### ⚠️ 服务账号私钥：绝对不能提交到这个仓库

上面第 1 步下载的 `.json` 文件，等同于你 Firebase 项目的**完整管理员密码**
——拿到它的人可以读写删除数据库里的一切数据，不受任何安全规则限制。

- **本仓库是公开的**，一旦这个文件被 `git add` / `git commit` / `git push`，
  它就永久出现在 git 历史里，被任何人看到、下载、克隆走，**删除后续提交
  并不能撤销这件事**（历史记录里依然能翻出来），届时唯一的补救办法是去
  Firebase 控制台把这个服务账号密钥吊销掉，并生成一个新的。
- 本仓库的 `.gitignore` 已经配置了 `serviceAccount*.json`、
  `*-firebase-adminsdk-*.json`、`backups/` 等规则来防止误提交，但这只是
  兜底的安全网，不代表可以随意把密钥文件放在仓库目录里——**建议把下载的
  密钥文件保存在仓库目录之外的地方**（比如 `~/secrets/`），只通过
  `GOOGLE_APPLICATION_CREDENTIALS` 环境变量引用它的绝对路径。
- 导出出来的 `backups/` 目录里是**完整的、未脱敏的用户行程数据**，同样
  不能提交进这个公开仓库（`.gitignore` 里也已经排除）。

---

## 部署 Firestore 安全规则 (firestore.rules)

仓库根目录的 [`firestore.rules`](./firestore.rules) 文件替换了 Firebase
控制台里当前生效的「测试模式」默认规则——那条规则允许**互联网上任何人、
不需要登录，读写删除数据库里的任何数据**，并且会在 2026-10-30 之后让
所有请求被拒绝、App 直接打不开。新规则的具体逻辑、以及它「没有」解决
哪些问题（同步码可被猜测等），都写在文件内的中文注释里，请直接打开
`firestore.rules` 阅读。

**关键点：把这个文件提交到 git 仓库，并不会让它生效。**
Firestore 规则只有通过下面的操作手动部署到 Firebase 项目后才会真正生效：

1. 打开 [Firebase 控制台](https://console.firebase.google.com/)，选择本项目
2. 左侧菜单 → **Firestore Database** → 顶部标签页切到 **规则 (Rules)**
3. 把 `firestore.rules` 文件的全部内容复制粘贴进编辑框（覆盖原有内容）
4. 点击右上角 **发布 (Publish)**

如果项目里配置了 Firebase CLI（`firebase.json` 指向了这份规则文件），
也可以用命令行部署：

```bash
firebase deploy --only firestore:rules
```

但只要没有做以上任何一步，控制台里跑的仍然是旧的「测试模式」规则，
`git` 仓库里这份文件的存在与否对线上行为没有任何影响。

## 切换新规则前必须确认的前置条件

**在把新的 `firestore.rules` 发布到生产环境之前，请务必先确认：**

> Firebase 控制台 → **Authentication** → **Sign-in method** → 确认
> **匿名 (Anonymous)** 登录方式已经启用。

原因：现在线上生效的旧规则完全不检查 `request.auth`（这也是它这么危险
的原因之一），所以就算匿名登录因为某种原因失败了，App 今天也能正常用
——`index.html:1873` 附近甚至专门写了一段「鉴权失败，强制放行」的兜底
逻辑（`console.warn("鉴权失败，将尝试强制放行 (依赖 Firestore Rules 兜底)")`），
这段兜底代码之所以能让 App 继续可用，**只是因为现在的规则本来就放行一切**，
一旦这个前提改变，这段兜底代码本身并不能让用户绕过新规则的鉴权检查。

新的 `firestore.rules` 要求 `request.auth != null` 才能读写任何数据。
如果这时候「匿名登录」在 Firebase 项目里没有启用，`signInAnonymously()`
会持续失败，`request.auth` 永远是 `null`，新规则会拒绝所有请求——**结果
是每一个用户都会被直接锁在门外，包括你自己**。所以正确的操作顺序是：

1. 先去 Authentication → Sign-in method 确认/启用匿名登录
2. 用一个测试行程验证 App 能正常登录、读写云端数据
3. 确认无误后，再按上面的步骤发布新的 `firestore.rules`
