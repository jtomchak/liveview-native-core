defmodule TestServerWeb.ChecklistFormTest do
  use TestServerWeb.ConnCase, async: false
  import Phoenix.LiveViewTest
  alias TestServer.Checklists

  @path "/checklists/workshop-launch/tasks/workshop-1/edit"
  @detail "/checklists/workshop-launch/tasks/workshop-1"

  setup %{conn: conn} do
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")

    {:ok, task} =
      Checklists.update_task(
        "workshop",
        task.id,
        %{title: "Prepare the workbench", notes: "", completed: false},
        task.version
      )

    {:ok, sid} = Checklists.issue_session("workshop")
    conn = init_test_session(conn, %{"account_id" => "workshop", "auth_session_id" => sid})
    {:ok, conn: conn, task: task}
  end

  defp payload(task, overrides, seq \\ "1") do
    %{
      "task" =>
        Map.merge(
          %{
            "id" => task.id,
            "version" => to_string(task.version),
            "title" => task.title,
            "notes" => task.notes,
            "completed" => to_string(task.completed)
          },
          overrides
        ),
      "client_seq" => seq
    }
  end

  test "checklist form parameter logging is disabled" do
    assert TestServerWeb.ChecklistLive.__live__().log == false
  end

  test "native edit bootstrap declares installed form capabilities and stable identity", %{
    conn: conn,
    task: task
  } do
    body = conn |> get(@path <> "?_format=react_native") |> response(200)

    for tag <- ["Form", "TextInput", "Switch", "HiddenInput", "FormButton"],
        do: assert(body =~ "<" <> tag)

    assert body =~ ~s(data-route="#{@path}")
    assert body =~ ~s(data-parent-route="#{@detail}")
    assert body =~ ~s(data-form-key="workshop:workshop-1")
    assert body =~ ~s(data-version="#{task.version}")
    assert body =~ ~s(data-validated-seq="0")
    assert body =~ ~s(data-form-status="editing")
    assert body =~ ~s(phx-change="validate_task")
    assert body =~ ~s(phx-submit="save_task")
    assert body =~ ~s(data-form-cancel="true")
    assert body =~ ~s(name="task[version]")
  end

  test "validation reports field errors without persisting and echoes client sequence", %{
    conn: conn,
    task: task
  } do
    {:ok, view, _} = live(conn, @path)

    render_change(
      view,
      "validate_task",
      payload(
        task,
        %{"title" => " ", "notes" => String.duplicate("a", 2_001), "completed" => "maybe"},
        "7"
      )
    )

    assert has_element?(view, "#title-error", "120 characters")
    assert has_element?(view, "#notes-error", "2000 characters")
    assert has_element?(view, "#completed-error", "valid completion")
    assert has_element?(view, "#task-form[data-form-status='invalid'][data-validated-seq='7']")
    assert {:ok, ^task} = Checklists.get_task("workshop", task.id)
  end

  test "successful save persists approved fields and exposes a confirmed destination", %{
    conn: conn,
    task: task
  } do
    {:ok, view, _} = live(conn, @path)

    submitted =
      payload(task, %{
        "title" => "Clean workbench",
        "notes" => "Bring spare gloves",
        "completed" => "true",
        "account_id" => "studio",
        "role" => "admin"
      })

    render_submit(view, "save_task", submitted)

    assert has_element?(
             view,
             "#task-form[data-form-status='saved'][data-saved-route='#{@detail}']"
           )

    assert has_element?(view, "#save-success", "Task saved")
    assert has_element?(view, "#saved-task-link[href='#{@detail}']")

    assert {:ok, saved} = Checklists.get_task("workshop", task.id)
    assert saved.title == "Clean workbench"
    assert saved.notes == "Bring spare gloves"
    assert saved.completed
    assert saved.version == task.version + 1
    refute Map.has_key?(saved, :role)
    {:ok, reopened, _} = live(conn, @detail)
    assert has_element?(reopened, "#task-notes", "Bring spare gloves")
  end

  test "conflicts preserve drafts and their original expected version", %{conn: conn, task: task} do
    {:ok, view, _} = live(conn, @path)
    render_change(view, "validate_task", payload(task, %{"title" => "My unsaved draft"}, "3"))

    {:ok, current} =
      Checklists.update_task("workshop", task.id, %{notes: "Changed elsewhere"}, task.version)

    render(view)
    assert has_element?(view, "input[name='task[title]'][value='My unsaved draft']")
    render_submit(view, "save_task", payload(task, %{"title" => "My unsaved draft"}, "4"))

    assert has_element?(
             view,
             "#task-form[data-form-status='conflict'][data-version='#{current.version}'][data-validated-seq='4']"
           )

    assert has_element?(view, "input[name='task[version]'][value='#{task.version}']")
    assert has_element?(view, "input[name='task[title]'][value='My unsaved draft']")
    assert has_element?(view, "#version-error", "Your draft is safe")
    assert {:ok, ^current} = Checklists.get_task("workshop", task.id)
  end

  test "stale validations cannot overwrite newer draft state", %{conn: conn, task: task} do
    {:ok, view, _} = live(conn, @path)
    render_change(view, "validate_task", payload(task, %{"title" => "Newer draft"}, "8"))
    render_change(view, "validate_task", payload(task, %{"title" => "Older draft"}, "7"))
    assert has_element?(view, "input[name='task[title]'][value='Newer draft']")
    assert has_element?(view, "#task-form[data-validated-seq='8']")
  end

  test "forged entity identifiers and invalid fields cannot save", %{conn: conn, task: task} do
    {:ok, view, _} = live(conn, @path)
    render_submit(view, "save_task", payload(task, %{"id" => "studio-1"}))
    assert has_element?(view, "#form-error", "not available")

    render_submit(
      view,
      "save_task",
      payload(task, %{"title" => String.duplicate("t", 121), "version" => "bad"}, "2")
    )

    assert has_element?(view, "#title-error", "120 characters")
    assert has_element?(view, "#version-error", "Refresh")
    assert {:ok, ^task} = Checklists.get_task("workshop", task.id)

    for path <- [
          "/checklists/studio-launch/tasks/studio-1/edit",
          "/checklists/workshop-launch/tasks/studio-1/edit"
        ] do
      assert {:error, {:redirect, %{to: "/checklists?error=not_found"}}} = live(conn, path)
    end

    assert {:error, {:redirect, %{to: "/sign-in"}}} = live(build_conn(), @path)
  end

  test "revoked form event returns a typed denial before client navigation", %{task: task} do
    {:ok, sid} = Checklists.issue_session("workshop")
    :ok = Checklists.revoke_session("workshop", sid)

    socket = %Phoenix.LiveView.Socket{
      assigns: %{__changed__: %{}, account_id: "workshop", auth_session_id: sid, screen: :edit}
    }

    assert {:reply, %{status: "unauthorized", client_seq: 13}, returned} =
             TestServerWeb.ChecklistLive.handle_event(
               "save_task",
               payload(task, %{"title" => "Must not save"}, "13"),
               socket
             )

    assert returned.redirected == nil
    assert returned.assigns.form_status == "unauthorized"
    assert {:ok, ^task} = Checklists.get_task("workshop", task.id)
  end
end
