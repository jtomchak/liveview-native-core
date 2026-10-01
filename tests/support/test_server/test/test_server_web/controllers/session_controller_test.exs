defmodule TestServerWeb.SessionControllerTest do
  use TestServerWeb.ConnCase, async: false
  import Phoenix.LiveViewTest
  alias TestServer.Checklists

  test "unauthenticated and forged account mounts redirect to sign-in" do
    assert {:error, {:redirect, %{to: "/sign-in"}}} = live(build_conn(), "/checklists")

    forged =
      init_test_session(build_conn(), %{
        "account_id" => "workshop",
        "auth_session_id" => "made-up"
      })

    assert {:error, {:redirect, %{to: "/sign-in"}}} = live(forged, "/checklists")
    {:ok, expired} = Checklists.issue_session("workshop", 0)

    expired_conn =
      init_test_session(build_conn(), %{"account_id" => "workshop", "auth_session_id" => expired})

    assert {:error, {:redirect, %{to: "/sign-in"}}} = live(expired_conn, "/checklists")
  end

  test "valid login restores through its signed cookie on a new request", %{conn: conn} do
    conn = post(conn, "/session", %{account: "studio", password: "studio-demo"})
    assert redirected_to(conn) == "/checklists"
    assert get_session(conn, :account_id) == "studio"
    sid = get_session(conn, :auth_session_id)
    assert :ok = Checklists.authenticate_session("studio", sid)
    cookie = conn.resp_cookies["_test_server_key"]
    assert cookie.http_only
    assert cookie.max_age == 86_400
    restored = recycle(conn) |> get("/checklists?_format=react_native")
    body = response(restored, 200)
    assert body =~ ~s(data-account="studio")
    assert body =~ "Studio opening"
    refute body =~ sid
    refute body =~ "Workshop opening"
  end

  test "wrong credentials and disabled demo configuration do not issue sessions", %{conn: conn} do
    rejected = post(conn, "/session", %{account: "workshop", password: "wrong"})
    assert redirected_to(rejected) == "/sign-in?error=invalid_credentials"
    assert get_session(rejected, :auth_session_id) == nil
    existing = Application.get_env(:test_server, :demo_credentials)
    Application.delete_env(:test_server, :demo_credentials)
    on_exit(fn -> Application.put_env(:test_server, :demo_credentials, existing) end)
    disabled = post(build_conn(), "/session", %{account: "workshop", password: "workshop-demo"})
    assert redirected_to(disabled) == "/sign-in?error=invalid_credentials"
  end

  test "POST login rejects a missing CSRF token", %{conn: conn} do
    assert_raise Plug.CSRFProtection.InvalidCSRFTokenError, fn ->
      conn
      |> put_private(:plug_skip_csrf_protection, false)
      |> post("/session", %{account: "workshop", password: "workshop-demo"})
    end
  end

  test "sign-in accepts a bootstrap CSRF token and account switching revokes the old token", %{
    conn: conn
  } do
    bootstrap = conn |> put_private(:plug_skip_csrf_protection, false) |> get("/sign-in")

    csrf =
      bootstrap
      |> response(200)
      |> Floki.parse_document!()
      |> Floki.find("input[name=_csrf_token]")
      |> Floki.attribute("value")
      |> hd()

    signed_in =
      bootstrap
      |> recycle()
      |> put_private(:plug_skip_csrf_protection, false)
      |> post("/session", %{account: "workshop", password: "workshop-demo", _csrf_token: csrf})

    assert redirected_to(signed_in) == "/checklists"
    old_sid = get_session(signed_in, :auth_session_id)

    switched =
      signed_in |> recycle() |> post("/session", %{account: "studio", password: "studio-demo"})

    assert get_session(switched, :account_id) == "studio"
    assert {:error, :unauthorized} = Checklists.authenticate_session("workshop", old_sid)

    assert :ok =
             Checklists.authenticate_session("studio", get_session(switched, :auth_session_id))
  end

  test "logout revokes stale live connections and restored old cookies", %{conn: conn} do
    logged_in = post(conn, "/session", %{account: "workshop", password: "workshop-demo"})
    sid = get_session(logged_in, :auth_session_id)
    old_cookie = logged_in.resp_cookies["_test_server_key"].value
    {:ok, view, _} = live(recycle(logged_in), "/checklists")
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")
    logged_out = logged_in |> recycle() |> post("/session/delete", %{})
    assert redirected_to(logged_out) == "/sign-in"
    assert_redirect(view, "/sign-in")

    assert {:error, :unauthorized} =
             Checklists.authorized_update_task(
               "workshop",
               sid,
               task.id,
               %{completed: !task.completed},
               task.version
             )

    assert {:ok, ^task} = Checklists.get_task("workshop", task.id)
    stale_conn = build_conn() |> put_req_cookie("_test_server_key", old_cookie)
    assert {:error, {:redirect, %{to: "/sign-in"}}} = live(stale_conn, "/checklists")
  end

  test "signed-out native screen contains auth metadata and no task records", %{conn: conn} do
    body = conn |> get("/sign-in?_format=react_native") |> response(200)
    assert body =~ ~s(id="sign-in-screen")
    assert body =~ ~s(data-auth="signed-out")
    refute body =~ "data-records="
    refute body =~ "workshop-1"
  end
end
