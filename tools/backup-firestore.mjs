#!/usr/bin/env node
/**
 * backup-firestore.mjs
 * -----------------------------------------------------------------------
 * Full, recursive, ad-hoc export of the WanderSync Firestore database.
 *
 * WHY THIS SCRIPT EXISTS
 *   Firestore's managed export (gcloud firestore export / the console's
 *   Import & Export screen) requires the Blaze (pay-as-you-go) billing
 *   plan. WanderSync runs on the free Spark plan, so that path is not
 *   available — this script is the substitute.
 *
 * WHAT IT DOES
 *   1. Enumerates ALL root collections via db.listCollections() — it does
 *      NOT hardcode 'travel_plans' or the 'artifacts/...' path, so it will
 *      also pick up data at paths nobody remembers exist (legacy paths,
 *      stray top-level collections, etc).
 *   2. For every document found, recurses into docRef.listCollections()
 *      to catch subcollections at any depth.
 *   3. Writes one pretty-printed .json file per existing document, in a
 *      directory tree that mirrors the Firestore path, under
 *      backups/<ISO-8601 timestamp>/...
 *   4. Writes a _manifest.json summarizing the run.
 *
 * "MISSING" (GHOST) DOCUMENTS
 *   Firestore lets a document path host a subcollection even if the
 *   document itself was never written (e.g. someone created
 *   travel_plans/ABC/notes/note1 without ever writing travel_plans/ABC).
 *   collectionRef.listDocuments() returns a DocumentReference for that
 *   path anyway. docRef.get() on it resolves with exists === false and
 *   empty data. We must NOT write a .json file for such a document (it
 *   would look like a real-but-empty document in the backup, which is a
 *   lie), but we MUST still descend into its subcollections, or their
 *   contents would silently vanish from the backup. See walkDocument()
 *   below and the `missingParentDocuments` list in the manifest.
 *
 * LOSSLESS ENCODING OF NON-JSON-NATIVE FIRESTORE TYPES
 *   JSON has no representation for Firestore's Timestamp, GeoPoint,
 *   DocumentReference or byte-array (Buffer) field types. Naively calling
 *   JSON.stringify() on a document's data:
 *     - silently mangles Timestamp/GeoPoint into their private internal
 *       shape ({_seconds,_nanoseconds} / {_latitude,_longitude}), which
 *       happens to "work" only by accident and is not something you can
 *       feed back into a `new Timestamp(...)` call without knowing that.
 *     - for Buffer fields, calls Buffer's own built-in .toJSON() *before*
 *       any custom replacer even runs, turning it into
 *       {"type":"Buffer","data":[...]} — you cannot intercept this with a
 *       JSON.stringify replacer at all (verified while building this
 *       script — see the walkthrough in tools/README.md).
 *   To make the export both human-inspectable AND mechanically
 *   re-importable, every value is walked recursively (deepConvertValue,
 *   below) BEFORE JSON.stringify ever sees it, and special types are
 *   turned into a small tagged-object convention:
 *     Timestamp         -> { "__type__": "timestamp",  "value": "<ISO-8601 string>" }
 *     GeoPoint          -> { "__type__": "geopoint",   "latitude": <num>, "longitude": <num> }
 *     DocumentReference -> { "__type__": "reference",  "path": "<collection/doc/...>" }
 *     Buffer (bytes)    -> { "__type__": "bytes",      "base64": "<base64 string>" }
 *   This is documented in tools/README.md so a future import script knows
 *   the convention.
 *
 * CREDENTIALS
 *   Reads a service-account key from the path in GOOGLE_APPLICATION_CREDENTIALS.
 *   If it is unset, prints a friendly, actionable explanation (no stack
 *   trace) and exits non-zero. See printCredentialsHelp() below.
 *
 * USAGE
 *   cd tools && npm install
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json
 *   node backup-firestore.mjs
 *
 * This script is operational tooling only. It is never loaded by the web
 * app (index.html) and does not run in CI or GitHub Pages.
 * -----------------------------------------------------------------------
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp, GeoPoint, DocumentReference } from 'firebase-admin/firestore';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const BACKUPS_ROOT = path.join(REPO_ROOT, 'backups');

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function printCredentialsHelp() {
  console.error(`
❌ 未找到 Firebase 服务账号密钥（GOOGLE_APPLICATION_CREDENTIALS 环境变量未设置）。

本脚本需要一个具备 Firestore 读取权限的服务账号私钥文件才能连接到你的
Firebase 项目并导出数据。获取步骤：

  1. 打开 Firebase 控制台: https://console.firebase.google.com/
  2. 选择你的 WanderSync 项目
  3. 点击左上角齿轮图标 → "项目设置" (Project settings)
  4. 切换到 "服务账号" (Service accounts) 标签页
  5. 点击 "生成新的私钥" (Generate new private key)，会下载一个 .json 文件
     ⚠️ 这个文件等同于数据库的完整管理员密码，切勿提交到 git / 分享给任何人
        （本仓库是公开仓库！.gitignore 已配置为自动忽略常见命名，但请仍务必小心）
  6. 设置环境变量指向刚下载的文件，然后重新运行本脚本，例如：

       export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your-project-firebase-adminsdk-xxxxx.json"
       node tools/backup-firestore.mjs

详见 tools/README.md。
`);
}

async function loadServiceAccount() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    printCredentialsHelp();
    process.exit(1);
  }

  let raw;
  try {
    raw = await fsp.readFile(keyPath, 'utf8');
  } catch (err) {
    console.error(`\n❌ 无法读取 GOOGLE_APPLICATION_CREDENTIALS 指向的文件: ${keyPath}`);
    console.error(`   ${err.message}\n`);
    printCredentialsHelp();
    process.exit(1);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    console.error(`\n❌ 密钥文件不是合法的 JSON: ${keyPath}`);
    console.error(`   ${err.message}\n`);
    process.exit(1);
  }

  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    console.error(`\n❌ 密钥文件缺少必要字段 (project_id / private_key / client_email)，`);
    console.error(`   看起来不是一个有效的 Firebase 服务账号密钥: ${keyPath}\n`);
    process.exit(1);
  }

  return serviceAccount;
}

// ---------------------------------------------------------------------------
// Value conversion (lossless, JSON-safe encoding of Firestore-native types)
// ---------------------------------------------------------------------------

function bufferToBase64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
}

/**
 * Recursively walks a value that came out of DocumentSnapshot.data() and
 * returns a plain-JSON-safe equivalent, tagging Firestore-native types so
 * the export is lossless and mechanically re-importable.
 *
 * IMPORTANT: this must run as a manual recursive pre-pass, NOT as a
 * JSON.stringify `replacer`. Node's Buffer defines its own .toJSON(), and
 * JSON.stringify calls value.toJSON() *before* invoking the replacer on
 * that value — so by the time a replacer would see it, a Buffer has
 * already been silently turned into {"type":"Buffer","data":[...]} and
 * `Buffer.isBuffer()` no longer returns true. Timestamp/GeoPoint do not
 * define toJSON, so they reach a replacer intact, but Buffer does not —
 * doing the walk ourselves, first, sidesteps the inconsistency entirely.
 */
function deepConvertValue(value) {
  if (value === null || value === undefined) return value;

  if (value instanceof Timestamp) {
    return { __type__: 'timestamp', value: value.toDate().toISOString() };
  }
  if (value instanceof Date) {
    // Defensive: shouldn't normally occur (admin SDK returns Timestamp),
    // but handle it in case a future SDK version or setting changes that.
    return { __type__: 'timestamp', value: value.toISOString() };
  }
  if (value instanceof GeoPoint) {
    return { __type__: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof DocumentReference) {
    return { __type__: 'reference', path: value.path };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __type__: 'bytes', base64: bufferToBase64(value) };
  }
  if (Array.isArray(value)) {
    return value.map(deepConvertValue);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepConvertValue(v);
    }
    return out;
  }
  // string, number, boolean
  return value;
}

// ---------------------------------------------------------------------------
// Filesystem-safe path segments
// ---------------------------------------------------------------------------

// Firestore document/collection IDs cannot contain '/' and cannot be
// exactly '.' or '..', but they *can* legally contain characters that are
// awkward or illegal in filenames on some filesystems (Windows in
// particular: < > : " | ? * and control characters). Sanitize defensively
// for the on-disk directory/file name while always recording the true,
// un-sanitized Firestore path in the manifest and inside each document's
// data is untouched either way (only the *name on disk* is affected).
function sanitizeSegment(rawId) {
  const cleaned = rawId.replace(/[<>:"|?*\x00-\x1F]/g, '_');
  return cleaned.length > 0 ? cleaned : '_empty_';
}

// Guards against two different Firestore IDs colliding onto the same
// sanitized on-disk name within the same parent directory (rare, but if
// it happened silently overwriting one document's export with another's
// would be a data-loss bug in the backup itself).
function makeSegmentAllocator() {
  const usedByParent = new Map(); // parentDir -> Set(segment)
  return (parentDir, rawId) => {
    let segment = sanitizeSegment(rawId);
    let used = usedByParent.get(parentDir);
    if (!used) { used = new Set(); usedByParent.set(parentDir, used); }
    if (used.has(segment)) {
      const suffix = crypto.createHash('sha1').update(rawId).digest('hex').slice(0, 8);
      segment = `${segment}__${suffix}`;
    }
    used.add(segment);
    return segment;
  };
}

const allocateSegment = makeSegmentAllocator();

// ---------------------------------------------------------------------------
// Recursive walk
// ---------------------------------------------------------------------------

async function walkDocument(docRef, parentDir, stats, manifest) {
  const snap = await docRef.get();
  const segment = allocateSegment(parentDir, docRef.id);
  const docDirForSubcollections = path.join(parentDir, segment);

  if (snap.exists) {
    stats.documentCount++;
    const converted = deepConvertValue(snap.data());
    const filePath = path.join(parentDir, `${segment}.json`);
    await fsp.mkdir(parentDir, { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(converted, null, 2) + '\n', 'utf8');
    manifest.documents.push(docRef.path);
    process.stderr.write(`  [doc]  ${docRef.path}\n`);
  } else {
    // "Missing"/ghost document: exists only as a parent of a subcollection.
    // Do not write a .json file for it (there is no real data), but still
    // recurse below so its subcollections are not silently dropped.
    stats.missingParentDocumentCount++;
    manifest.missingParentDocuments.push(docRef.path);
    process.stderr.write(`  [ghost] ${docRef.path} (no data, exists only as a subcollection parent)\n`);
  }

  const subCollections = await docRef.listCollections();
  for (const subColl of subCollections) {
    await walkCollection(subColl, docDirForSubcollections, stats, manifest);
  }
}

// `parentDir` is the directory of whatever contains this collection (the
// repo-relative backups root for a root collection, or a document's own
// subcollection directory for a nested one). This function is responsible
// for appending the collection's own on-disk segment — callers must NOT
// do it themselves, or the collection's own path component silently goes
// missing from every path beneath it (caught via emulator testing: see
// tools/README.md's "Verification" section for how this was found).
async function walkCollection(collRef, parentDir, stats, manifest) {
  stats.collectionCount++;
  manifest.collections.push(collRef.path);
  process.stderr.write(`[collection] ${collRef.path}\n`);

  const segment = allocateSegment(parentDir, collRef.id);
  const dirPath = path.join(parentDir, segment);

  const docRefs = await collRef.listDocuments();
  for (const docRef of docRefs) {
    await walkDocument(docRef, dirPath, stats, manifest);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const serviceAccount = await loadServiceAccount();

  initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
  const db = getFirestore();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); // filesystem-safe ISO-8601
  const outDir = path.join(BACKUPS_ROOT, timestamp);

  const stats = { collectionCount: 0, documentCount: 0, missingParentDocumentCount: 0 };
  const manifest = {
    exportedAt: new Date().toISOString(),
    projectId: serviceAccount.project_id,
    collectionCount: 0,
    documentCount: 0,
    missingParentDocumentCount: 0,
    collections: [],
    documents: [],
    missingParentDocuments: [],
    encoding: {
      note: 'Firestore-native types are tagged so the export is lossless. See tools/README.md.',
      timestamp: '{ "__type__": "timestamp", "value": "<ISO-8601 string>" }',
      geopoint: '{ "__type__": "geopoint", "latitude": <number>, "longitude": <number> }',
      reference: '{ "__type__": "reference", "path": "<collection/doc/...>" }',
      bytes: '{ "__type__": "bytes", "base64": "<base64 string>" }',
    },
  };

  process.stderr.write(`\n开始导出 Firestore 项目: ${serviceAccount.project_id}\n`);
  process.stderr.write(`输出目录: ${outDir}\n\n`);

  await fsp.mkdir(outDir, { recursive: true });

  const rootCollections = await db.listCollections();
  if (rootCollections.length === 0) {
    process.stderr.write('警告: 未发现任何根集合 (listCollections() 返回空)。\n');
  }
  for (const collRef of rootCollections) {
    await walkCollection(collRef, outDir, stats, manifest);
  }

  manifest.collectionCount = stats.collectionCount;
  manifest.documentCount = stats.documentCount;
  manifest.missingParentDocumentCount = stats.missingParentDocumentCount;

  const manifestPath = path.join(outDir, '_manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`\n✅ 备份完成 (backup complete)`);
  console.log(`   集合数 (collections, all depths): ${stats.collectionCount}`);
  console.log(`   文档数 (documents exported):      ${stats.documentCount}`);
  if (stats.missingParentDocumentCount > 0) {
    console.log(`   跳过的空父文档 (ghost docs, subcollection-only): ${stats.missingParentDocumentCount}`);
  }
  console.log(`   输出目录 (output dir): ${outDir}`);
  console.log(`   清单文件 (manifest): ${manifestPath}`);
}

main().catch((err) => {
  console.error('\n❌ 备份过程中发生错误 (backup failed):');
  console.error(`   ${err && err.message ? err.message : err}`);
  if (process.env.DEBUG) {
    console.error(err && err.stack ? err.stack : '');
  } else {
    console.error('   (设置环境变量 DEBUG=1 重新运行可查看完整堆栈信息)');
  }
  process.exit(1);
});
