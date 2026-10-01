defmodule TestServerWeb.ChecklistLiveTest do
  use TestServerWeb.ConnCase, async: false
  import Phoenix.LiveViewTest
  alias TestServer.Checklists

  setup do
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")

    if task.completed,
      do: Checklists.update_task("workshop", task.id, %{completed: false}, task.version)

    :ok
  end

  test "completion survives a new LiveView and reaches another connection", %{conn: conn} do
    {:ok, first, _} = live(conn, "/checklists")
    {:ok, second, _} = live(conn, "/checklists")
    first |> element("#toggle-workshop-1") |> render_click()
    assert has_element?(first, "#workshop-1 .task-status", "Complete")
    assert has_element?(second, "#workshop-1 .task-status", "Complete")
    {:ok, reopened, _} = live(conn, "/checklists")
    assert has_element?(reopened, "#workshop-1 .task-status", "Complete")
  end

  test "foreign task identifiers and stale versions cannot mutate records", %{conn: conn} do
    {:ok, view, _} = live(conn, "/checklists")
    render_click(view, "toggle_task", %{"id" => "studio-1", "version" => "1"})
    assert {:ok, %{completed: false}} = Checklists.get_task("studio", "studio-1")
    assert has_element?(view, "[role=alert]", "could not be updated")
    render_click(view, "toggle_task", %{"id" => "workshop-1", "version" => 1})
    assert has_element?(view, "[role=alert]", "could not be updated")
    render_click(view, "toggle_task", %{"id" => "workshop-1", "version" => "999999999"})
    assert has_element?(view, "[role=alert]", "This task changed")
    assert {:ok, %{completed: false}} = Checklists.get_task("workshop", "workshop-1")
  end

  test "React Native bootstrap uses installed tags and versioned action values", %{conn: conn} do
    body = conn |> get("/checklists?_format=react_native") |> response(200)
    assert body =~ "<View"
    assert body =~ "<Text"
    assert body =~ "<Pressable"
    assert body =~ "Workshop opening"
    assert body =~ ~s(data-account="workshop")
    assert body =~ "data-records="
    assert body =~ ~s(phx-click="toggle_task")
    assert body =~ ~s(phx-value-id="workshop-1")
    assert body =~ "phx-value-version="
    refute body =~ "Studio opening"
  end
end
