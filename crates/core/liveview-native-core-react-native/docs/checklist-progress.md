# Checklist app delivery log

Each milestone is tested, reviewed, documented, committed and pushed before the next implementation milestone.

1. Telemetry and baseline — complete. Reviewed; 14 JS tests, 3 Phoenix counter tests, package/example typechecks, Hermes export, iOS full Debug build and Android full Debug build passed.
2. Durable domain/state ownership/document generations — pending.
3. Persisted authentication — pending.
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
