# TestServer

To start your Phoenix server:

  * Run `mix setup` to install and setup dependencies
  * Start Phoenix endpoint with `mix phx.server` or inside IEx with `iex -S mix phx.server`

Now you can visit [`localhost:4001`](http://localhost:4001) from your browser.

## React Native counter example

This test server registers a local `LiveViewNative.ReactNative` format plugin.
`/react_native` provides an HTML preview; `/react_native?_format=react_native`
bootstraps the same LiveView with `View`, `Text`, and `Pressable` elements for
the React Native client. The Rust client should request the `react_native`
format and connect to `http://localhost:4001/react_native`.

The counter starts at zero and handles `increment`, `decrement`, and `reset`
events. Phoenix sends a heartbeat update every second, so the demo exercises
both client events and unsolicited server diffs. Each connection owns its own
counter; this example does not persist counts across reconnects.

Run its focused checks with:

```sh
mix deps.get
mix test test/test_server_web/live/counter_live_test.exs
mix phx.server
```

On Homebrew systems where Erlang is missing from `PATH`, prefix the Mix
commands with `PATH=/opt/homebrew/opt/erlang/bin:$PATH`.

The development server binds to loopback. The iOS simulator can use localhost;
Android emulators use `10.0.2.2` to access the development machine.

Ready to run in production? Please [check our deployment guides](https://hexdocs.pm/phoenix/deployment.html).

## Learn more

  * Official website: https://www.phoenixframework.org/
  * Guides: https://hexdocs.pm/phoenix/overview.html
  * Docs: https://hexdocs.pm/phoenix
  * Forum: https://elixirforum.com/c/phoenix-forum
  * Source: https://github.com/phoenixframework/phoenix


## Durable checklist example

`/checklists` serves the checklist example in HTML. Add
`?_format=react_native` for the native document consumed by the Expo app.
The screen requires an authenticated account; unauthenticated requests redirect
to `/sign-in`. Development and test configuration explicitly enable demo
credentials `workshop` / `workshop-demo` and `studio` / `studio-demo`. Production
has no default demo credential configuration.

`TestServer.Checklists` is a serialized GenServer backed by OTP DETS with no
additional production dependencies. Seeded accounts `workshop` and `studio`
have separate checklist/task IDs. Context reads and mutations require account
identity; unknown or foreign record IDs return `{:error, :not_found}`.

Tasks contain `id`, `title`, `notes`, `completed`, and integer `version`.
`update_task(account, task_id, attrs, expected_version)` rejects stale versions
with `{:error, {:conflict, current_task}}`. Only validated editable fields may be
updated. Every account is one DETS object, including a command-receipt container
for future durable offline operations. The current mutation inserts and syncs
that object before returning success or broadcasting an account-scoped PubSub
notification. Task completion survives a new LiveView connection and storage
close/reopen.

Development records live in ignored `data/checklists.dets`. Test configuration
uses a separate unique temporary file; domain durability tests additionally open
isolated named stores. DETS is a single-node sample storage choice, not a
multi-node database or a backup strategy.

Run the domain, native bootstrap, connection propagation, and existing counter
checks with:

```sh
PATH=/opt/homebrew/opt/erlang/bin:$PATH mix test \
  test/test_server/checklists_test.exs \
  test/test_server_web/live/checklist_live_test.exs \
  test/test_server_web/live/counter_live_test.exs
```


### Persisted sample authentication

`POST /session` accepts CSRF-protected `account` and `password` form fields.
Success renews the signed Plug session and redirects to `/checklists`; rejected
credentials redirect to `/sign-in?error=invalid_credentials`. `POST
/session/delete` durably revokes the active session, drops its cookie, and
redirects to `/sign-in`. A successful account change revokes the previous token.

Cookies are HTTP-only with a 24-hour lifetime, SameSite=Lax, and Secure in
production configuration. Account identity and a cryptographically random
opaque session ID are checked against DETS on every checklist mount and event.
Session issue/revocation is synced before acknowledgement; expired and revoked
tokens cannot mutate records, including through previously connected views.
The store caps each account at 32 active tokens. Revocation also notifies live
connections to return to sign-in. Authentication tokens are never emitted in
native document metadata. The native bridge owns persistence of this cookie jar.

`authorized_update_task` verifies the session and performs the versioned update
inside one serialized store call, preventing a logout from racing between a
separate authorization check and write. Raw context functions are internal
domain APIs and must not be exposed as unauthenticated endpoints.

The two fixed credentials demonstrate session mechanics; they are not a general
user-registration, password-reset, or production identity-provider system.
Authentication checks:

```sh
PATH=/opt/homebrew/opt/erlang/bin:$PATH mix test \
  test/test_server/checklists_test.exs \
  test/test_server_web/controllers/session_controller_test.exs \
  test/test_server_web/live/checklist_live_test.exs \
  test/test_server_web/live/counter_live_test.exs
```


### Checklist navigation

Authenticated list, checklist, and task screens share one LiveView with
account-owned route resolution:

- `/checklists`
- `/checklists/:id`
- `/checklists/:id/tasks/:task_id`

Every native root carries canonical `data-route`, `data-parent-route`,
`data-account`, and account-scoped JSON `data-records`. Signed-out documents carry
`data-route="/sign-in"`. Installed React Native navigation Pressables provide
`data-navigate` and `data-nav-action` (`push`/`replace`) for the native navigation
coordinator. Task screens reserve `data-edit-route` for the next forms milestone;
that route is not yet exposed as an enabled navigation button.

The `server_navigation` event accepts an owned checklist `id` and a `replace`
value of exactly `"true"` or `"false"`, then uses `push_navigate`. Unknown/foreign
checklists and tasks redirect to a generic `/checklists?error=not_found` screen;
unauthenticated or revoked sessions redirect to `/sign-in`. URLs and navigation
actions are validated against installed routes rather than accepting arbitrary
destinations. Existing task completion actions work on all three screens and
retain account ownership/version checks.
