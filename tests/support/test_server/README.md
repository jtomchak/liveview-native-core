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
