defmodule TestServerWeb.ChecklistLiveTest do
  use TestServerWeb.ConnCase, async: false
  import Phoenix.LiveViewTest
  alias TestServer.Checklists

  setup %{conn: conn} do
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")

    if task.completed,
      do: Checklists.update_task("workshop", task.id, %{completed: false}, task.version)

    {:ok, sid} = Checklists.issue_session("workshop")
    {:ok, conn: init_test_session(conn, %{"account_id" => "workshop", "auth_session_id" => sid})}
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

  test "owned checklist and task deep links resolve with canonical route metadata", %{conn: conn} do
    detail_path = "/checklists/workshop-launch"
    task_path = detail_path <> "/tasks/workshop-1"
    {:ok, detail, _} = live(conn, detail_path)

    assert has_element?(
             detail,
             "#checklists-screen[data-route='#{detail_path}'][data-parent-route='/checklists']"
           )

    assert has_element?(detail, "#open-workshop-1[href='#{task_path}']")
    {:ok, task, _} = live(conn, task_path)

    assert has_element?(
             task,
             "#checklists-screen[data-route='#{task_path}'][data-parent-route='#{detail_path}']"
           )

    assert has_element?(task, "#task-notes", "No notes yet")
    refute has_element?(task, "#workshop-2")
    task |> element("#toggle-workshop-1") |> render_click()
    assert has_element?(task, "#workshop-1 .task-status", "Complete")
    assert has_element?(task, "#checklists-screen[data-route='#{task_path}']")
  end

  test "foreign and unknown checklist/task deep links cannot reveal records", %{conn: conn} do
    for path <- [
          "/checklists/studio-launch",
          "/checklists/missing",
          "/checklists/workshop-launch/tasks/studio-1",
          "/checklists/workshop-launch/tasks/missing"
        ] do
      assert {:error, {:redirect, %{to: "/checklists?error=not_found"}}} = live(conn, path)
    end
  end

  test "all deep links require a durable authenticated session" do
    for path <- [
          "/checklists",
          "/checklists/workshop-launch",
          "/checklists/workshop-launch/tasks/workshop-1"
        ] do
      assert {:error, {:redirect, %{to: "/sign-in"}}} = live(build_conn(), path)
    end
  end

  test "server navigation validates ownership and accepts only push/replace options", %{
    conn: conn
  } do
    {:ok, invalid, _} = live(conn, "/checklists")
    render_click(invalid, "server_navigation", %{"id" => "studio-launch", "replace" => "true"})
    assert has_element?(invalid, "[role=alert]", "not available")

    render_click(invalid, "server_navigation", %{
      "id" => "workshop-launch",
      "replace" => "javascript:bad"
    })

    assert has_element?(invalid, "[role=alert]", "not available")

    for {value, kind} <- [{"false", :push}, {"true", :replace}] do
      {:ok, view, _} = live(conn, "/checklists")

      assert {:error, {:live_redirect, opts}} =
               render_click(view, "server_navigation", %{
                 "id" => "workshop-launch",
                 "replace" => value
               })

      assert opts.to == "/checklists/workshop-launch"
      assert opts.kind == kind
    end
  end

  test "native navigation metadata and reserved future edit path are emitted", %{conn: conn} do
    list = conn |> get("/checklists?_format=react_native") |> response(200)
    assert list =~ ~s(data-route="/checklists")
    assert list =~ ~s(data-navigate="/checklists/workshop-launch")
    assert list =~ ~s(data-nav-action="push")
    assert list =~ ~s(phx-click="server_navigation")

    task =
      conn
      |> get("/checklists/workshop-launch/tasks/workshop-1?_format=react_native")
      |> response(200)

    assert task =~ ~s(data-route="/checklists/workshop-launch/tasks/workshop-1")
    assert task =~ ~s(data-parent-route="/checklists/workshop-launch")
    assert task =~ ~s(data-edit-route="/checklists/workshop-launch/tasks/workshop-1/edit")
    assert task =~ ~s(data-account="workshop")
    assert task =~ "data-records="
    assert task =~ "Prepare the workbench"
    refute task =~ ~s(id="workshop-2")
  end

  test "query parameters cannot change matched route identity", %{conn: conn} do
    {:ok, view, _} = live(conn, "/checklists?id=workshop-launch&task_id=workshop-1")
    assert has_element?(view, "#checklists-screen[data-route='/checklists']")
    assert has_element?(view, "#workshop-2")
  end
end
