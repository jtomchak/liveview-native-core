defmodule TestServerWeb.CounterLive do
  use TestServerWeb, :live_view
  use TestServerNative, [:live_view, formats: [:react_native]]

  def mount(_params, _session, socket) do
    if connected?(socket), do: schedule_tick()
    {:ok, assign(socket, count: 0, ticks: 0)}
  end

  def handle_event("increment", _params, socket) do
    {:noreply, update(socket, :count, &(&1 + 1))}
  end

  def handle_event("decrement", _params, socket) do
    {:noreply, update(socket, :count, &(&1 - 1))}
  end

  def handle_event("reset", _params, socket) do
    {:noreply, assign(socket, :count, 0)}
  end

  def handle_info(:tick, socket) do
    schedule_tick()
    {:noreply, update(socket, :ticks, &(&1 + 1))}
  end

  defp schedule_tick, do: Process.send_after(self(), :tick, 1_000)

  def render(assigns) do
    ~H"""
    <section>
      <h1>LiveView × React Native</h1>
      <p>Phoenix owns the count. Your React Native bundle renders this screen.</p>
      <p id="count">{@count}</p>
      <button id="decrement" phx-click="decrement">−</button>
      <button id="increment" phx-click="increment">+</button>
      <button id="reset" phx-click="reset">Reset</button>
      <p id="heartbeat">Server heartbeat: {@ticks}</p>
    </section>
    """
  end
end

defmodule TestServerWeb.CounterLive.ReactNative do
  use TestServerNative, [:render_component, format: :react_native]

  def render(assigns, _interface) do
    ~LVN"""
    <View id="counter-screen" data-style="screen">
      <Text data-style="eyebrow">LIVEVIEW NATIVE / REACT NATIVE</Text>
      <Text data-style="title">One server. Native screens.</Text>
      <Text data-style="subtitle">Phoenix owns the state. Your React Native bundle renders the components.</Text>
      <View data-style="card">
        <Text data-style="caption">SERVER COUNTER</Text>
        <Text id="count" data-style="counter"><%= @count %></Text>
        <View data-style="actions">
          <Pressable id="decrement" data-style="button" phx-click="decrement">
            <Text data-style="buttonLabel">−</Text>
          </Pressable>
          <Pressable id="increment" data-style="button" phx-click="increment">
            <Text data-style="buttonLabel">+</Text>
          </Pressable>
          <Pressable id="reset" data-style="button" phx-click="reset">
            <Text data-style="buttonLabel">Reset</Text>
          </Pressable>
        </View>
        <Text data-style="caption">Tap a button to send a LiveView event.</Text>
      </View>
      <Text id="heartbeat" data-style="heartbeat">Server heartbeat: <%= @ticks %></Text>
      <Text data-style="caption">This heartbeat is pushed by Phoenix every second.</Text>
    </View>
    """
  end
end
