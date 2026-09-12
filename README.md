# WanderSync

A single-page collaborative trip planner: itinerary, shopping list, and
expense tracking for a group trip, synced in real time across everyone's
devices via a shared "sync code."

The UI is Chinese-language (built for Chinese-speaking users); this
document is the public-facing English README for the codebase itself.

## Stack

- **Frontend**: a single `index.html` — static markup plus one inlined
  `type="module"` script, styled with a purged, self-hosted Tailwind build
  (`tailwind.min.css`) and subset Google Fonts/Font Awesome files. No
  bundler, no build step, no framework.
- **Data**: Firebase Firestore, accessed straight from the browser via the
  modular Firebase JS SDK (loaded on demand, not bundled).
- **Auth**: anonymous Firebase Authentication — good enough to gate access
  behind `request.auth != null` in Firestore rules, without asking users to
  create an account.
- **Hosting**: static files on GitHub Pages.
- **Offline shell**: a service worker (`sw.js`) caches the static app shell
  so it survives being launched as an iOS home-screen app, which is always
  a cold start.

## Repo layout

```
index.html              The entire app (markup + logic)
sw.js                    Service worker: caches the static shell only
manifest.json            PWA manifest (home-screen icon, standalone display)
firestore.rules          Firestore security rules (see below)
tailwind.min.css         Pre-built, purged Tailwind CSS
fontawesome-subset.css   Subset Font Awesome (icons actually used)
poppins-subset.css       Subset Poppins font
fonts/                   The .woff2 files those two CSS files reference
icons/                   PWA/favicon icons
tools/                   Operational scripts (not part of the deployed app)
  backup-firestore.mjs   Ad-hoc full Firestore export (see tools/README.md)
  verify-rules.html      Standalone page to sanity-check deployed rules
  README.md              Documentation for tools/
```

## Running locally

There's no build step — it's static files. Serve the directory root with
any static file server and open it in a browser, e.g.:

```bash
npx serve .
# or: python3 -m http.server 8080
```

Firebase config is supplied at runtime (either injected by the hosting
environment or pasted into the app's own config screen on first run), so
no `.env` or build-time secrets are needed just to load the page.

## Deploying

Push to the branch GitHub Pages is configured to serve (this repo publishes
straight from the branch, no build/CI step) — the static files are the
deployment artifact. After deploying a change to any static asset (CSS,
fonts, `index.html`'s shell structure), bump `SW_VERSION` at the top of
`sw.js`, or previously-installed clients will keep serving the old cached
version indefinitely (see "Architecture notes" below).

Firestore security rules are **not** deployed automatically — pushing
`firestore.rules` to this repo has no effect on the live project by itself.
It must be pasted into the Firebase console (Firestore Database → Rules →
Publish) or deployed with `firebase deploy --only firestore:rules`.

## Architecture notes worth knowing

- **Single-document trip model.** Each trip is one Firestore document
  (`travel_plans/{tripId}`, or a BYOD-configured equivalent path), holding
  the itinerary, expenses, and shopping list together. Every save is a
  whole-document overwrite (`setDoc`), not a field-level update — there is
  no fine-grained conflict resolution between devices, just last-write-wins
  on the full document.
- **Images live in a subcollection, not inline.** Shopping-list photos are
  stored as separate documents in `travel_plans/{tripId}/images/{imageId}`
  rather than inlined as base64 in the trip document, because Firestore
  caps a single document at 1 MiB and the trip document was already
  approaching that limit. The image document's ID is deterministically
  derived from the shopping item's ID (not random), which makes retries,
  migrations, and offline replays land on the same document instead of
  creating orphans. Firestore rules do not inherit into subcollections, so
  `images` has its own explicit rule block.
- **The service worker only caches the static shell** (HTML/CSS/fonts/
  manifest) — never Firestore, auth, or API traffic — and does so
  cache-first with no revalidation. Any change to a cached static asset
  requires bumping `SW_VERSION` in `sw.js`, or it silently won't reach
  users who already have the app installed.
- **Firestore access control is ID-based, not identity-based.** Anyone
  anonymously authenticated can read/write a trip if they have (or guess)
  its sync code — see `firestore.rules` for what this does and does not
  protect against.
