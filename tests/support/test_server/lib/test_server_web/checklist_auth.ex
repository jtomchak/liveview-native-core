defmodule TestServerWeb.ChecklistAuth do
  @moduledoc "Durable authorization shared by checklist HTTP and LiveView boundaries."
  alias TestServer.Checklists

  def account(%{"account_id" => account, "auth_session_id" => sid}) do
    case Checklists.authenticate_session(account, sid) do
      :ok -> {:ok, account, sid}
      _ -> {:error, :unauthorized}
    end
  end

  def account(_), do: {:error, :unauthorized}

  def authorized?(socket) do
    Checklists.authenticate_session(socket.assigns.account_id, socket.assigns.auth_session_id) ==
      :ok
  end

  def valid_credentials?(account, password) when is_binary(account) and is_binary(password) do
    # An absent configuration disables sign-in, including in production.
    case Map.get(Application.get_env(:test_server, :demo_credentials, %{}), account) do
      expected when is_binary(expected) ->
        Plug.Crypto.secure_compare(
          :crypto.hash(:sha256, expected),
          :crypto.hash(:sha256, password)
        )

      _ ->
        false
    end
  end

  def valid_credentials?(_, _), do: false
end
