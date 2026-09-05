# tools/

Operational tooling for the WanderSync Firebase backend. Nothing here is
loaded by the deployed app (`index.html`) — this is a separate Node.js
project (its own `package.json`) meant to be run by a human, from a
terminal, when they need to do something to the actual Firestore database.

## backup-firestore.mjs

Full, recursive, ad-hoc export of the entire Firestore database to local
JSON files. It exists because Firebase's managed export
(`gcloud firestore export` / the console's Import/Export screen) requires
the **Blaze** (pay-as-you-go) billing plan, and this project runs on the
free **Spark** plan, where that feature is unavailable.

### Prerequisites

- Node.js (any reasonably current LTS; developed/tested with Node 22)
- A Firebase service-account key with Firestore read access for the project

### Get a service-account key

1. Open the [Firebase console](https://console.firebase.google.com/) and
   select the WanderSync project.
2. Click the gear icon → **Project settings** (项目设置).
3. Switch to the **Service accounts** (服务账号) tab.
4. Click **Generate new private key** (生成新的私钥). This downloads a
   `.json` file.

**This file is a full admin credential for the project — treat it like a
root password.** Do not save it inside this repository (this repo is
public). Save it somewhere outside the working tree, e.g. `~/secrets/`.

### Run it

```bash
cd tools
npm install

export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/your-key.json"
node backup-firestore.mjs
```

(or `npm run backup`, which does the same thing via the `package.json`
script — you still need `GOOGLE_APPLICATION_CREDENTIALS` set first).

If the env var is unset, missing, unreadable, not valid JSON, or missing
the fields a service-account key must have, the script prints a plain,
actionable explanation (in Chinese, matching the app's language) and
exits with a non-zero status — it does not crash with a raw stack trace.
Set `DEBUG=1` to also print the underlying stack trace for an unexpected
error during the export itself.

### What it does

- Calls `db.listCollections()` to enumerate **every root collection** —
  it does not hardcode `travel_plans` or the `artifacts/...` path, so it
  will also surface legacy/forgotten top-level collections nobody
  remembers exist.
- For every document found, calls `docRef.listCollections()` to recurse
  into subcollections at any depth.
- Writes one pretty-printed `.json` file per **existing** document, into
  `backups/<ISO-8601 timestamp>/...`, mirroring the real Firestore path
  as a directory tree (a document with subcollections gets both
  `<id>.json`, for its own data, and a `<id>/` directory, for what's
  under it — those are different filesystem names, so this is not a
  collision).
- Writes `backups/<timestamp>/_manifest.json` with: the export
  timestamp, the project id, the total collection and document counts,
  and a flat array of every document path actually exported.
- Prints progress (one line per collection/document visited) to
  **stderr**, and a final summary (collection count, document count,
  output directory) to **stdout**.

### "Missing" (ghost) parent documents

Firestore allows a document path to host a subcollection even if the
document at that path was never written — e.g. someone writes
`travel_plans/ABC/notes/note1` without ever calling `.set()` on
`travel_plans/ABC` itself. `collectionRef.listDocuments()` still returns
a `DocumentReference` for `travel_plans/ABC`; calling `.get()` on it
resolves with `exists === false` and no data.

The script does **not** write a `.json` file for such a document (there
is no real data — writing an empty file would misrepresent it as a real,
empty document), but it **does** still recurse into its subcollections,
so their contents are never silently dropped from the backup. These
paths are listed separately in the manifest under
`missingParentDocuments`, and logged to stderr with a `[ghost]` prefix
during the run (as opposed to `[doc]` for a real, exported document).

### Lossless encoding of Firestore-native types

JSON has no native representation for Firestore's `Timestamp`,
`GeoPoint`, `DocumentReference`, or byte-array (`Buffer`) field types.
Naively calling `JSON.stringify()` on raw document data mangles all of
these — and, notably, it is not possible to intercept this cleanly with
a `JSON.stringify` *replacer* function, because Node's `Buffer` defines
its own `.toJSON()` method, and `JSON.stringify` calls `value.toJSON()`
**before** ever handing that value to a replacer. By the time a replacer
would see it, a `Buffer` has already become
`{"type":"Buffer","data":[...]}`, and `Buffer.isBuffer()` on it no
longer returns `true`. (`Timestamp`/`GeoPoint` don't define `toJSON`, so
they *would* reach a replacer intact — but relying on that inconsistency
would be fragile and confusing.) This was verified empirically while
writing this script — see "Verification" below.

To sidestep this, `deepConvertValue()` in `backup-firestore.mjs` walks a
document's data **recursively, itself, before `JSON.stringify` ever
runs**, and converts special types into a small tagged-object
convention:

| Firestore type      | JSON encoding                                                          |
|----------------------|-------------------------------------------------------------------------|
| `Timestamp`          | `{ "__type__": "timestamp", "value": "<ISO-8601 string>" }`             |
| `GeoPoint`            | `{ "__type__": "geopoint", "latitude": <number>, "longitude": <number> }` |
| `DocumentReference`   | `{ "__type__": "reference", "path": "<collection/doc/...>" }`           |
| Bytes (`Buffer`)     | `{ "__type__": "bytes", "base64": "<base64 string>" }`                  |

This is lossless and mechanically re-importable — a future import script
just needs to check for an `__type__` tag on any object it encounters
and reconstruct the corresponding Firestore value (`Timestamp.fromDate`,
`new GeoPoint(...)`, `db.doc(path)`, `Buffer.from(base64, 'base64')`).
No import script exists yet; this is documentation for writing one.

### Verification

This script's logic was verified against a real **Firestore emulator**
(`firebase-tools emulators:start --only firestore`), not just a code
read-through, because "verify what you can" was explicitly worth doing
here — an emulator doesn't require production credentials.

Seeded test data covered: nested subcollections at multiple depths, a
"ghost" parent document (a subcollection written under a path whose own
document was never `.set()`), and every special field type (`Timestamp`,
`GeoPoint`, `DocumentReference`, `Buffer`, a `null` field, a nested
array containing a nested `Timestamp`, and non-ASCII text). Running the
script against that data caught a real bug: `walkCollection()` was not
appending its own collection-id segment onto the output directory path,
so every subcollection's own path component silently disappeared from
the on-disk path one level down (e.g. `travel_plans/SEOUL2026/expenses/EXP1`
was written to `travel_plans/SEOUL2026/EXP1.json`, dropping `expenses/`).
This was fixed and re-verified — the emulator run's on-disk output was
diffed against the actual seeded Firestore paths and matched exactly,
including the ghost-document paths (correctly skipped, with their
subcollections still recursed into) and every special type round-tripping
correctly (Base64-decoding the `bytes` field back to the original string,
etc).

This confirms the recursion, ghost-document handling, and type encoding
are correct against arbitrary/nested data shapes. It does **not** confirm
behavior against the actual production project's real data, real service
account, real Firestore API quotas/latency, or any data shape not covered
by the seeded test fixtures above — that can only be verified by actually
running it against the real project, which requires a real service-account
key that does not exist in the environment this script was written in.

### Re-running the export

Each run creates a new timestamped directory under `backups/`; nothing
is overwritten. `backups/` is excluded from git (see the repo root
`.gitignore`) because exported data is a full, unencrypted copy of every
user's trip data and this repository is public.
