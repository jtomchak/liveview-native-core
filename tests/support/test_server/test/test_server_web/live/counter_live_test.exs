defmodule TestServerWeb.CounterLiveTest do
  use TestServerWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  test "counter events update server state", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/react_native")
    assert has_element?(view, "#count", "0")

    view |> element("#increment") |> render_click()
    assert has_element?(view, "#count", "1")

    view |> element("#decrement") |> render_click()
    view |> element("#decrement") |> render_click()
    assert has_element?(view, "#count", "-1")

    view |> element("#reset") |> render_click()
    assert has_element?(view, "#count", "0")
  end

  test "server tick changes the live document without a client event", %{conn: conn} do
    {:ok, view, _html} = live(conn, "/react_native")
    send(view.pid, :tick)
    assert has_element?(view, "#heartbeat", "Server heartbeat: 1")
  end

  test "React Native bootstrap negotiates installed native tags", %{conn: conn} do
    conn = get(conn, "/react_native?_format=react_native")
    body = response(conn, 200)

    assert get_resp_header(conn, "content-type") == ["text/react_native; charset=utf-8"]
    assert body =~ "<csrf-token"
    assert body =~ "data-phx-session="
    assert body =~ "<View"
    assert body =~ "<Pressable"
    assert body =~ ~s(phx-click="increment")
    assert body =~ ~s(id="count")
    assert body =~ "Server heartbeat: 0"
    refute body =~ "<html"
  end
end
