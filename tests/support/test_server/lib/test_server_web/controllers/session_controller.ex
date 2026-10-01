defmodule TestServerWeb.SessionController do
  use TestServerWeb, :controller
  alias TestServer.Checklists
  alias TestServerWeb.ChecklistAuth

  def create(conn, %{"account" => account, "password" => password}) do
    if ChecklistAuth.valid_credentials?(account, password) do
      revoke_existing(conn)
      {:ok, sid} = Checklists.issue_session(account)

      conn
      |> clear_session()
      |> configure_session(renew: true)
      |> put_session(:account_id, account)
      |> put_session(:auth_session_id, sid)
      |> redirect(to: "/checklists")
    else
      redirect(conn, to: "/sign-in?error=invalid_credentials")
    end
  end

  def create(conn, _), do: redirect(conn, to: "/sign-in?error=invalid_credentials")

  def delete(conn, _params) do
    revoke_existing(conn)
    conn |> clear_session() |> configure_session(drop: true) |> redirect(to: "/sign-in")
  end

  defp revoke_existing(conn) do
    case ChecklistAuth.account(get_session(conn)) do
      {:ok, account, sid} -> Checklists.revoke_session(account, sid)
      _ -> :ok
    end
  end
end
