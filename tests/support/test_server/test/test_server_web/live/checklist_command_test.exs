defmodule TestServerWeb.ChecklistCommandTest do
  use TestServerWeb.ConnCase, async: false
  import Phoenix.LiveViewTest
  alias TestServer.Checklists

  defp command(task) do
    %{
      "operationId" =>
        "#{System.system_time(:millisecond)}-#{Base.encode16(:crypto.strong_rand_bytes(16), case: :lower)}",
      "accountId" => "workshop",
      "taskId" => task.id,
      "expectedVersion" => task.version,
      "type" => "set_completed",
      "payload" => %{"completed" => !task.completed}
    }
  end

  test "typed command on list updates its account document and replay does not mutate", %{
    conn: conn
  } do
    {:ok, sid} = Checklists.issue_session("workshop")
    conn = init_test_session(conn, %{"account_id" => "workshop", "auth_session_id" => sid})
    {:ok, view, _} = live(conn, "/checklists")
    {:ok, before} = Checklists.get_task("workshop", "workshop-1")
    cmd = command(before)
    render_click(view, "execute_command", %{"command" => cmd})
    assert has_element?(view, "#checklists-screen[data-route='/checklists']")

    assert {:ok, %{version: version, completed: completed}} =
             Checklists.get_task("workshop", before.id)

    assert version == before.version + 1
    assert completed != before.completed
    render_click(view, "execute_command", %{"command" => cmd})
    assert {:ok, %{version: ^version}} = Checklists.get_task("workshop", before.id)
  end

  test "business receipt and revoked denial are returned without bundled navigation" do
    {:ok, sid} = Checklists.issue_session("workshop")
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")
    cmd = command(task)

    socket = %Phoenix.LiveView.Socket{
      assigns: %{
        __changed__: %{},
        account_id: "workshop",
        auth_session_id: sid,
        route_params: %{},
        error: nil,
        live_action: :index
      }
    }

    assert {:reply, %{status: "committed", operationId: id, version: version}, updated} =
             TestServerWeb.ChecklistLive.handle_event(
               "execute_command",
               %{"command" => cmd},
               socket
             )

    assert id == cmd["operationId"]
    assert version == task.version + 1
    assert updated.redirected == nil
    :ok = Checklists.revoke_session("workshop", sid)

    assert {:reply, %{status: "unauthorized", operationId: ^id}, denied} =
             TestServerWeb.ChecklistLive.handle_event(
               "execute_command",
               %{"command" => cmd},
               updated
             )

    assert denied.redirected == nil
    assert {:ok, %{version: ^version}} = Checklists.get_task("workshop", task.id)
  end

  test "missing store returns a safe command reply without a separate authentication exit" do
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")
    cmd = command(task)
    :ok = Supervisor.terminate_child(TestServer.Supervisor, Checklists)
    on_exit(fn -> {:ok, _} = Supervisor.restart_child(TestServer.Supervisor, Checklists) end)

    socket = %Phoenix.LiveView.Socket{
      assigns: %{
        __changed__: %{},
        account_id: "workshop",
        auth_session_id: "synthetic-private-token"
      }
    }

    assert {:reply, %{status: "unavailable", operationId: id}, returned} =
             TestServerWeb.ChecklistLive.handle_event(
               "execute_command",
               %{"command" => cmd},
               socket
             )

    assert id == cmd["operationId"]
    assert returned.redirected == nil
  end

  test "unknown and nil session IDs receive domain unauthorized replies" do
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")
    cmd = command(task)

    for sid <- [nil, "unknown-session"] do
      socket = %Phoenix.LiveView.Socket{
        assigns: %{__changed__: %{}, account_id: "workshop", auth_session_id: sid}
      }

      assert {:reply, %{status: "unauthorized"}, returned} =
               TestServerWeb.ChecklistLive.handle_event(
                 "execute_command",
                 %{"command" => cmd},
                 socket
               )

      assert returned.redirected == nil
    end

    assert {:ok, ^task} = Checklists.get_task("workshop", task.id)
  end
end
