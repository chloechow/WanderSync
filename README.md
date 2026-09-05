# WanderSync

一个单页面的旅行行程规划应用：`index.html`（HTML + 一段内联的 `type="module"` 脚本）
配合 `tailwind.min.css`，数据存放在 Firebase Firestore，部署在 GitHub Pages 上。

> ⚠️ **本仓库是公开（Public）仓库。** 任何提交到这里的内容都是全世界可见的，
> 这一点在下面涉及密钥的部分尤其重要，请务必读完再操作。

## 目录

- [Firestore 数据备份](#firestore-数据备份)
- [部署 Firestore 安全规则 (firestore.rules)](#部署-firestore-安全规则-firestorerules)
- [切换新规则前必须确认的前置条件](#切换新规则前必须确认的前置条件)

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
