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
At this milestone the screen selects the demo `workshop` account. Account
selection is not authentication; authentication is the next milestone.

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
