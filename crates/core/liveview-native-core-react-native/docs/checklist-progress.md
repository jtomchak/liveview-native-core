# Checklist app delivery log

Each milestone is tested, reviewed, documented, committed and pushed before the next implementation milestone.

1. Telemetry and baseline — complete. Reviewed; 14 JS tests, 3 Phoenix counter tests, package/example typechecks, Hermes export, iOS full Debug build and Android full Debug build passed.
2. Durable domain/state ownership/document generations — complete. 15 JS tests, 3 Rust unit tests, 5 domain + 3 checklist + 2 collector + 3 counter Phoenix tests; native builds and native task toggle/reconnect checks passed on both platforms. Reviewed before commit.
3. Persisted authentication — complete. 19 JS tests; 19 targeted Phoenix tests; Rust form transport/redirect regression tests; both native builds and process-restart/account-switch/logout checks passed. Reviewed before commit.
4. Navigation — pending.
5. Forms — pending.
6. Uploads — pending.
7. Offline reads and persisted drafts — pending.
8. Durable commands and conflict handling — pending.
9. Incremental bridge evaluation/patches — pending.
10. End-to-end app builds, screenshots and final validation — pending.

## Telemetry

The package exposes an optional `setTelemetrySink`; exporter failures cannot break sessions. The example enables Expo Observe, labels debug measurements as development, and marks interactive only after a connected document exists. Native snapshot bytes/timing and callback counts accompany updates. JS parse/validation, first-document latency and event acknowledgement timings are distinct from React commit timing. React Profiler emits in profiling builds; normal production React does not provide these callbacks. Native frame jank still needs a system profiler. Event acknowledgement is not a measured visible business update.

Run `npx tsx scripts/benchmark.ts` for deterministic document validation fixtures. This Node microbenchmark is not a physical-device performance claim. Release physical-device startup/action/frame baselines remain required for performance release gates. External EAS ingestion requires linking an EAS project; local instrumentation does not prove backend delivery. No document bodies, form values, URLs, cookies or credentials are exported by package telemetry.

Sources: [Observe SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/observe/), [LiveView telemetry](https://phoenix-live-view.hexdocs.pm/telemetry.html).

The SDK 58 example uses `legacy-peer-deps=true` because npm otherwise installs incompatible optional peers (Router 57, or Worklets 0.13 against the pinned Expo Modules Core range). Required packages remain explicitly pinned to SDK 58 versions. Observe currently needs no Router integration until the navigation milestone. Package tests: 13 passed; package/example typechecks and iOS Hermes export passed. Native snapshot instrumentation compiled on both platforms.

The example retains a bounded 120-event diagnostic buffer. Profiler events do not change diagnostic snapshots or notify React subscribers, preventing a render/measurement feedback loop. Physical-device release performance and external telemetry ingestion remain unverified.

iOS runtime screenshot: [telemetry](screenshots/telemetry-ios.png). Connected counter/heartbeat and measured payload/parsing values verified after fresh native install. A runtime diagnostic render loop was fixed by excluding Profiler commits from the React external-store snapshot; the regression test verifies identity remains stable.

### Telemetry runtime correction

Android Observe initializes only when `extra.eas.projectId` is present. The sample now uses the explicit **local namespace** `lvn-checklist-local` and a custom OTLP HTTP endpoint at `/observe` on Phoenix; this is not a registered EAS project. Android emulator development requires `adb reverse tcp:4001 tcp:4001` for the loopback collector. Configure `extra.eas.observe.endpointUrl` to a reachable LAN collector for physical devices, or replace both values with real EAS project settings. The dev/test-only collector retains 20 sanitized summaries per signal in memory (fixed event labels and numeric timing/count attributes; no raw bodies, exception text, identifiers or device metadata); production ingestion/storage is outside this sample. Native config must be rebuilt after changes. Both native apps now start with this config. Native task toggles and reconnect persistence passed on iOS and Android. Collector delivery validation is recorded below.

## State milestone

`Document.identity()` is an opaque per-document identity preserved by clones; both bridges deduplicate connected notifications and capture generation in per-document callbacks. JS rejects old generations and requires a snapshot for replacement. Root component keys include session and generation. Phoenix owns durable task records and versions; reconnect reads those records. One DETS account object is serialized/synced before acknowledging a mutation. This is single-node sample storage.

[Native runtime evidence](checklist-state-verification.json) records both platform event calls and reconnect persistence. One task toggle currently produces four document callbacks/snapshots, establishing concrete amplification to address during bridge optimization. iOS and Android `ExpoObserve.dispatchEvents()` succeeded; local collector received four log batches and two metric batches. The local collector stores sanitized summaries only, with a post-decode 256KB batch acceptance limit and 20 summaries per signal. Privacy regression tests verify raw record bodies/attributes are dropped.

Native inspection (running debug app + Metro): `DEVICE=iPhone node scripts/inspect-native.mjs --file scripts/checklist-state-smoke.js`; Android selector is `DEVICE=sdk_gphone`. It uses the native transport, verifies a versioned mutation and then opens a fresh connection to verify persistence. It intentionally changes the first task's completion in the sample account.

## Authentication milestone

Demo credentials are configured only in development/tests: `workshop` / `workshop-demo`, `studio` / `studio-demo`. Production has no demo credential configuration. Native cookies are origin-scoped in iOS Keychain and Android Keystore-encrypted preferences. JavaScript submits passwords once and retains no cookie/token. The server stores expiring, revocable sessions in the same durable account object; every task mutation validates authorization atomically. Cookies are signed, HttpOnly and expire after 24 hours; production marks them Secure. Signed session fields are client-readable, not encrypted.

`postForm` uses Rust's CSRF token, validates the origin, and waits for a new connected document. Rust now carries HTTP method/body through reconnect; POST redirects cannot leave the original origin. The current core follows redirects as GET (Phoenix POST-redirect-GET); general 307/308 method-preserving redirects are not supported. Cookie/session payload debug logging was removed. Successful form submission is distinct from confirmed sign-in in telemetry.

Logout clears every client/document/cookie jar at the origin and blocks late persistence writes. **Online logout confirms server revocation. If the request fails, local credentials are still deleted; remote revocation is unconfirmed and the old server session expires after 24 hours.** The sample does not retain credentials for durable offline revocation retries. Telemetry distinguishes `auth.local_logout` from confirmed `auth.logout`. Use one active client per origin: separate Rust jars share durable storage but do not merge concurrent cookie changes.

[Runtime evidence](checklist-auth-verification.json) verifies invalid credentials, restored studio session after process termination/relaunch, account switching and protected document clearing on both platforms. Screenshots: [iOS](screenshots/checklist-auth-ios.png), [Android](screenshots/checklist-auth-android.png). `scripts/checklist-auth-smoke.js` leaves studio signed in; terminate/relaunch the app, then run `scripts/checklist-auth-restore-smoke.js`. Debug-only `__lvnSession` enables these transport checks and never contains cookies.

Unsigned iOS simulator executables cannot access Keychain. Run `bash scripts/build-simulator.sh <simulator-UDID>` for a reproducible ad-hoc simulator build with temporary app-scoped entitlements. Physical devices require normal provisioning/signing; this helper never changes device configuration.
