defmodule TestServer.ChecklistsTest do
  use ExUnit.Case, async: false
  alias TestServer.Checklists

  setup do
    path =
      Path.join(System.tmp_dir!(), "checklist-domain-#{System.unique_integer([:positive])}.dets")

    opts = [name: :checklist_domain_test, table: :checklist_domain_test_dets, path: path]
    start_supervised!({Checklists, opts})
    on_exit(fn -> File.rm(path) end)
    %{server: :checklist_domain_test, opts: opts}
  end

  test "seeded records belong to their account", %{server: server} do
    assert {:ok, [%{id: "workshop-launch", tasks: tasks}]} = Checklists.list("workshop", server)
    assert length(tasks) == 3
    assert {:error, :not_found} = Checklists.get("studio", "workshop-launch", server)
    assert {:error, :not_found} = Checklists.get_task("studio", "workshop-1", server)

    assert {:error, :not_found} =
             Checklists.update_task("studio", "workshop-1", %{completed: true}, 1, server)

    assert {:error, :not_found} = Checklists.list("unknown", server)
  end

  test "updates are durable across closing and reopening storage", %{server: server, opts: opts} do
    assert {:ok, %{completed: true, version: 2}} =
             Checklists.update_task("workshop", "workshop-1", %{completed: true}, 1, server)

    :ok = stop_supervised(Checklists)
    start_supervised!({Checklists, opts})

    assert {:ok, %{completed: true, version: 2}} =
             Checklists.get_task("workshop", "workshop-1", server)

    assert {:ok, %{completed: false, version: 1}} =
             Checklists.get_task("studio", "studio-1", server)
  end

  test "stale writes return current state and do not overwrite", %{server: server} do
    assert {:ok, updated} =
             Checklists.update_task("workshop", "workshop-2", %{completed: true}, 1, server)

    assert {:error, {:conflict, ^updated}} =
             Checklists.update_task("workshop", "workshop-2", %{completed: false}, 1, server)

    assert {:ok, ^updated} = Checklists.get_task("workshop", "workshop-2", server)
  end

  test "validation rejects unknown fields and malformed values", %{server: server} do
    for attrs <- [
          %{version: 99},
          %{completed: "yes"},
          %{title: " "},
          %{},
          %{notes: String.duplicate("a", 10_001)}
        ] do
      assert {:error, :invalid} =
               Checklists.update_task("workshop", "workshop-3", attrs, 1, server)
    end

    assert {:ok, %{version: 1, completed: false}} =
             Checklists.get_task("workshop", "workshop-3", server)
  end

  test "subscribers receive account-scoped update notifications after persistence", %{
    server: server
  } do
    Checklists.subscribe("workshop")

    assert {:ok, %{version: 2}} =
             Checklists.update_task("studio", "studio-1", %{completed: true}, 1, server)

    refute_receive {:checklists_changed, _}, 20

    assert {:ok, %{version: 2}} =
             Checklists.update_task("workshop", "workshop-1", %{completed: true}, 1, server)

    assert_receive {:checklists_changed, "workshop"}

    assert {:ok, %{version: 2, completed: true}} =
             Checklists.get_task("workshop", "workshop-1", server)
  end

  test "session issue and revocation survive storage reopening", %{server: server, opts: opts} do
    assert {:ok, sid} = Checklists.issue_session("workshop", 86_400, server)
    assert :ok = Checklists.authenticate_session("workshop", sid, server)
    assert {:error, :unauthorized} = Checklists.authenticate_session("studio", sid, server)
    :ok = stop_supervised(Checklists)
    start_supervised!({Checklists, opts})
    assert :ok = Checklists.authenticate_session("workshop", sid, server)
    assert :ok = Checklists.revoke_session("workshop", sid, server)
    :ok = stop_supervised(Checklists)
    start_supervised!({Checklists, opts})
    assert {:error, :unauthorized} = Checklists.authenticate_session("workshop", sid, server)

    assert {:error, :unauthorized} =
             Checklists.authorized_update_task(
               "workshop",
               sid,
               "workshop-1",
               %{completed: true},
               1,
               server
             )

    assert {:ok, %{completed: false, version: 1}} =
             Checklists.get_task("workshop", "workshop-1", server)
  end

  test "expired and unknown sessions fail and account active sessions are bounded", %{
    server: server
  } do
    assert {:ok, expired} = Checklists.issue_session("workshop", 0, server)
    assert {:error, :unauthorized} = Checklists.authenticate_session("workshop", expired, server)
    assert {:error, :unauthorized} = Checklists.authenticate_session("workshop", nil, server)
    assert {:error, :not_found} = Checklists.issue_session("unknown", 86_400, server)
    assert {:error, :invalid} = Checklists.issue_session("workshop", -1, server)

    tokens =
      for _ <- 1..35 do
        {:ok, sid} = Checklists.issue_session("workshop", 86_400, server)
        sid
      end

    assert Enum.count(tokens, &(Checklists.authenticate_session("workshop", &1, server) == :ok)) ==
             32
  end

  test "attachment metadata is account-scoped, validated and durable", %{
    server: server,
    opts: opts
  } do
    {:ok, sid} = Checklists.issue_session("workshop", 86_400, server)

    metadata = %{
      name: "notes.txt",
      type: "text/plain",
      size: 20,
      storage_key: "workshop/0123456789abcdef0123456789abcdef.txt"
    }

    assert {:error, :invalid} =
             Checklists.authorized_attach_task(
               "workshop",
               sid,
               "workshop-1",
               %{metadata | storage_key: "../notes.txt"},
               1,
               server
             )

    assert {:error, :not_found} =
             Checklists.authorized_attach_task("workshop", sid, "studio-1", metadata, 1, server)

    assert {:ok, %{version: 2, attachments: [^metadata]}} =
             Checklists.authorized_attach_task("workshop", sid, "workshop-1", metadata, 1, server)

    :ok = stop_supervised(Checklists)
    start_supervised!({Checklists, opts})

    assert {:ok, %{version: 2, attachments: [^metadata]}} =
             Checklists.get_task("workshop", "workshop-1", server)

    assert {:error, {:conflict, _}} =
             Checklists.authorized_attach_task("workshop", sid, "workshop-1", metadata, 1, server)
  end
end
