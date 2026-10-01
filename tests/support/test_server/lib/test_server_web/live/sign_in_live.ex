defmodule TestServerWeb.SignInLive do
  use TestServerWeb, :live_view
  use TestServerNative, [:live_view, formats: [:react_native]]

  def mount(params, session, socket) do
    case TestServerWeb.ChecklistAuth.account(session) do
      {:ok, _, _} -> {:ok, redirect(socket, to: "/checklists")}
      _ -> {:ok, assign(socket, error: params["error"] == "invalid_credentials")}
    end
  end

  def render(assigns) do
    ~H"""
    <section id="sign-in-screen" data-auth="signed-out">
      <h1>Sign in to your checklists</h1>
      <p :if={@error} role="alert">The account or password was incorrect.</p>
      <form action="/session" method="post">
        <input type="hidden" name="_csrf_token" value={Plug.CSRFProtection.get_csrf_token()} />
        <label>Account <input name="account" autocomplete="username" required /></label>
        <label>
          Password <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </section>
    """
  end
end

defmodule TestServerWeb.SignInLive.ReactNative do
  use TestServerNative, [:render_component, format: :react_native]

  def render(assigns, _interface) do
    ~LVN"""
    <View id="sign-in-screen" data-auth="signed-out" data-style="screen">
      <Text data-style="eyebrow">SHARED CHECKLISTS</Text>
      <Text data-style="title">Your next good day.</Text>
      <Text data-style="subtitle">Sign in below to open your saved checklists.</Text>
      <Text :if={@error} data-style="caption">The account or password was incorrect.</Text>
    </View>
    """
  end
end
