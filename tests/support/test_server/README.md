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
coordinator. Task screens expose an Edit task button and `data-edit-route` to the authenticated
edit screen.

The `server_navigation` event accepts an owned checklist `id` and a `replace`
value of exactly `"true"` or `"false"`, then uses `push_navigate`. Unknown/foreign
checklists and tasks redirect to a generic `/checklists?error=not_found` screen;
unauthenticated or revoked sessions redirect to `/sign-in`. URLs and navigation
actions are validated against installed routes rather than accepting arbitrary
destinations. Existing task completion actions work on all three screens and
retain account ownership/version checks.


### Task forms

`/checklists/:id/tasks/:task_id/edit` exposes native `Form`, `TextInput`, `Switch`,
`HiddenInput`, and `FormButton` capabilities. The stable form key is
`account_id:task_id`. The native renderer owns keyboard/focus and local drafts;
Phoenix validates form events and persists approved submissions.

`validate_task` and `save_task` consume decoded nested `task` fields (`id`,
`version`, `title`, `notes`, `completed`) plus a flat monotonic `client_seq`.
Only selected, account-owned task IDs are accepted. Editable fields are
whitelisted; extra submitted attributes do not enter the record. Titles must
contain non-whitespace content and have at most 120 characters; notes have at
most 2000 characters. Completion accepts only the strings `true`/`false` and
versions must be positive integers.

Validation does not write. Responses carry `data-form-errors`,
`data-form-status`, and `data-validated-seq`; earlier sequence responses cannot
replace newer server draft state, and the renderer suppresses responses older
than its local typing. Native errors render from metadata so stale server Text
nodes cannot surface misleading messages. Checklist LiveView parameter logging
is disabled to avoid logging form contents.

Business replies contain only `status` and `client_seq`, with the new `version`
when saved. Status values include `valid`, `invalid`, `conflict`, `saved`,
`stale`, and `unauthorized`. The renderer clears a draft only for a matching
`saved` reply. A successful save syncs storage and remains on the edit document
long enough to deliver that business acknowledgement. The native controller then
uses `data-saved-route` to replace navigation with task detail; HTML shows a saved
confirmation and an explicit task-detail link. Combining a server redirect with
the reply suppresses the reply in Phoenix, so navigation must follow the confirmed
business response. Unauthorized form events likewise return a typed denial for
client handling without bundling a redirect into that reply. Concurrent writes return a conflict and preserve submitted values
and the original hidden expected version; refreshed `data-version` exposes the
current record version without silently upgrading the draft's concurrency
baseline. Cancel/reopen reviews that saved version before another submission.
Cancel uses `data-form-cancel` so the client can discard its draft explicitly.


### Foreground attachments

Task detail allows one PNG or UTF-8 text upload at a time, at most 2 MiB and
nonempty. Phoenix LiveView owns upload preflight/chunks/progress/cancellation.
The native `UploadInput` carries the standard `data-phx-upload-ref`, active/done/
preflighted entry refs plus `data-upload-progress`, `data-upload-status`,
`data-upload-ref`, and a JSON array of safe `data-upload-errors`. Transfer at 100%
is `ready`; it is not a saved attachment until the separate Save attachment
action succeeds. Save is disabled until a completed entry exists. Cancel upload
removes the current entry and allows a retry.

`attach_upload` checks authenticated account, selected task identity, expected
record version, and completed-upload state before consuming. File names are
sanitized display labels; actual storage keys use server-generated random names
under private ignored `data/uploads/<account>`. PNG signatures and UTF-8 text are
checked before storage. File contents are synced, then authorized attachment
metadata is synced with the versioned task. Metadata includes display name,
validated MIME type, byte size, and a logical storage key; absolute paths and
authentication tokens are not sent to the document.

Authorization/version failure after copying deletes the new private file.
Task attachment metadata survives DETS close/reopen, and old records without an
attachments field read as an empty list. Test uploads use a separate temporary
storage root. This is foreground transfer; navigating away destroys the current
LiveView upload session. Background transfer and automatic crash-orphan
reconciliation are outside this sample's current attachment scope.
