defmodule TestServer.ChecklistCommandsTest do
  use ExUnit.Case, async: false
  alias TestServer.Checklists

  setup do
    now = System.system_time(:millisecond)
    clock = start_supervised!({Agent, fn -> now end})

    path =
      Path.join(
        System.tmp_dir!(),
        "checklist-commands-#{System.pid()}-#{System.unique_integer([:positive])}.dets"
      )

    opts = [
      name: :checklist_commands_test,
      table: :checklist_commands_test_dets,
      path: path,
      command_clock: fn -> Agent.get(clock, & &1) end,
      receipt_limit: 2
    ]

    start_supervised!({Checklists, opts})
    {:ok, sid} = Checklists.issue_session("workshop", 86_400, :checklist_commands_test)
    on_exit(fn -> File.rm(path) end)
    %{server: :checklist_commands_test, sid: sid, now: now, clock: clock, opts: opts}
  end

  defp command(now, id, version \\ 1, payload \\ %{"completed" => true}) do
    %{
      "operationId" => "#{now}-#{String.pad_leading(Integer.to_string(id, 16), 32, "0")}",
      "accountId" => "workshop",
      "taskId" => "workshop-1",
      "expectedVersion" => version,
      "type" => "set_completed",
      "payload" => payload
    }
  end

  test "lost acknowledgement replay returns exact receipt before and after storage reopen", ctx do
    cmd = command(ctx.now, 1)
    Checklists.subscribe("workshop")
    assert {:ok, receipt} = Checklists.execute_command("workshop", ctx.sid, cmd, ctx.server)
    assert receipt.status == "committed"
    assert receipt.version == 2
    assert receipt.retainedUntil == ctx.now + 604_800_000
    assert_receive {:checklists_changed, "workshop"}
    assert {:ok, ^receipt} = Checklists.execute_command("workshop", ctx.sid, cmd, ctx.server)
    refute_receive {:checklists_changed, _}, 20

    {:ok, _task} =
      Checklists.update_task("workshop", "workshop-1", %{notes: "Changed later"}, 2, ctx.server)

    :ok = stop_supervised(Checklists)
    start_supervised!({Checklists, ctx.opts})
    assert {:ok, ^receipt} = Checklists.execute_command("workshop", ctx.sid, cmd, ctx.server)

    assert {:ok, %{version: 3, notes: "Changed later"}} =
             Checklists.get_task("workshop", "workshop-1", ctx.server)

    refute Map.has_key?(receipt, :payload)
    refute Map.has_key?(receipt, :title)
  end

  test "reusing an operation ID for different intent is rejected", ctx do
    cmd = command(ctx.now, 1)
    assert {:ok, _} = Checklists.execute_command("workshop", ctx.sid, cmd, ctx.server)
    changed = put_in(cmd["payload"]["completed"], false)

    assert {:error, %{status: "id_reused"}} =
             Checklists.execute_command("workshop", ctx.sid, changed, ctx.server)

    assert {:ok, %{version: 2, completed: true}} =
             Checklists.get_task("workshop", "workshop-1", ctx.server)
  end

  test "authentication precedes replay and commands cannot cross accounts", ctx do
    cmd = command(ctx.now, 1)
    assert {:ok, _} = Checklists.execute_command("workshop", ctx.sid, cmd, ctx.server)

    assert {:error, %{status: "unauthorized"}} =
             Checklists.execute_command(
               "workshop",
               ctx.sid,
               %{cmd | "accountId" => "studio"},
               ctx.server
             )

    assert {:error, %{status: "not_found"}} =
             Checklists.execute_command(
               "workshop",
               ctx.sid,
               %{command(ctx.now, 2) | "taskId" => "studio-1"},
               ctx.server
             )

    :ok = Checklists.revoke_session("workshop", ctx.sid, ctx.server)

    assert {:error, %{status: "unauthorized", operationId: id}} =
             Checklists.execute_command("workshop", ctx.sid, cmd, ctx.server)

    assert id == cmd["operationId"]
  end

  test "version conflicts do not write records or spend receipt quota", ctx do
    stale = command(ctx.now, 1, 99)

    assert {:error, %{status: "conflict", currentVersion: 1}} =
             Checklists.execute_command("workshop", ctx.sid, stale, ctx.server)

    assert {:ok, %{version: 1, completed: false}} =
             Checklists.get_task("workshop", "workshop-1", ctx.server)

    # Same ID can be corrected because conflicts produce no committed receipt.
    assert {:ok, _} =
             Checklists.execute_command("workshop", ctx.sid, command(ctx.now, 1), ctx.server)

    assert {:ok, _} =
             Checklists.execute_command("workshop", ctx.sid, command(ctx.now, 2, 2), ctx.server)
  end

  test "quota rejects new commands while allowing existing receipt replay", ctx do
    first = command(ctx.now, 1)
    assert {:ok, receipt} = Checklists.execute_command("workshop", ctx.sid, first, ctx.server)

    assert {:ok, _} =
             Checklists.execute_command("workshop", ctx.sid, command(ctx.now, 2, 2), ctx.server)

    assert {:error, %{status: "quota"}} =
             Checklists.execute_command("workshop", ctx.sid, command(ctx.now, 3, 3), ctx.server)

    assert {:ok, ^receipt} = Checklists.execute_command("workshop", ctx.sid, first, ctx.server)
    assert {:ok, %{version: 3}} = Checklists.get_task("workshop", "workshop-1", ctx.server)
  end

  test "expired IDs cannot execute again after receipt pruning frees quota", ctx do
    old = command(ctx.now, 1)
    assert {:ok, _} = Checklists.execute_command("workshop", ctx.sid, old, ctx.server)

    assert {:ok, _} =
             Checklists.execute_command("workshop", ctx.sid, command(ctx.now, 2, 2), ctx.server)

    later = ctx.now + 604_800_001
    Agent.update(ctx.clock, fn _ -> later end)

    assert {:error, %{status: "expired"}} =
             Checklists.execute_command("workshop", ctx.sid, old, ctx.server)

    assert {:ok, _} =
             Checklists.execute_command("workshop", ctx.sid, command(later, 3, 3), ctx.server)

    assert {:error, %{status: "expired"}} =
             Checklists.execute_command("workshop", ctx.sid, old, ctx.server)

    assert {:ok, %{version: 4}} = Checklists.get_task("workshop", "workshop-1", ctx.server)
  end

  test "concurrent retries serialize to one mutation", ctx do
    cmd = command(ctx.now, 1)

    tasks =
      for _ <- 1..6,
          do:
            Task.async(fn -> Checklists.execute_command("workshop", ctx.sid, cmd, ctx.server) end)

    replies = Enum.map(tasks, &Task.await/1)
    assert length(Enum.uniq(replies)) == 1
    assert [{:ok, %{version: 2}}] = Enum.uniq(replies)
    assert {:ok, %{version: 2}} = Checklists.get_task("workshop", "workshop-1", ctx.server)
  end

  test "typed update payload and strict schemas reject malformed input without effects", ctx do
    valid = %{
      command(ctx.now, 1)
      | "type" => "update_task",
        "payload" => %{"title" => "New title", "notes" => "New notes", "completed" => true}
    }

    invalids = [
      Map.put(valid, "admin", true),
      put_in(valid["payload"]["role"], "admin"),
      %{valid | "expectedVersion" => "1"},
      %{valid | "operationId" => "invalid"},
      command(ctx.now + 300_001, 2),
      %{valid | "payload" => %{"title" => "missing fields"}},
      put_in(valid["payload"]["title"], String.duplicate("a", 121))
    ]

    for invalid <- invalids do
      assert {:error, %{status: "invalid"}} =
               Checklists.execute_command("workshop", ctx.sid, invalid, ctx.server)
    end

    assert {:ok, %{version: 1}} = Checklists.get_task("workshop", "workshop-1", ctx.server)

    assert {:ok, %{version: 2}} =
             Checklists.execute_command("workshop", ctx.sid, valid, ctx.server)

    assert {:ok, %{title: "New title", notes: "New notes", completed: true}} =
             Checklists.get_task("workshop", "workshop-1", ctx.server)
  end

  test "hot-loaded legacy GenServer state uses production defaults", ctx do
    :sys.replace_state(ctx.server, &Map.take(&1, [:table]))
    actual_now = System.system_time(:millisecond)

    assert {:ok, %{status: "committed", version: 2}} =
             Checklists.execute_command("workshop", ctx.sid, command(actual_now, 9), ctx.server)

    assert {:ok, upgraded} = Checklists.code_change(:legacy, :sys.get_state(ctx.server), nil)
    assert is_function(upgraded.command_clock, 0)
    assert upgraded.receipt_limit == 1024
  end

  test "status callback redacts session maps, command body, debug log and error terms" do
    sensitive = "synthetic-private-session"

    status = %{
      state: %{sessions: %{sensitive => %{account: "private"}}},
      message:
        {:"$gen_call", {self(), make_ref()},
         {:execute_command, "workshop", sensitive,
          %{"payload" => %{"notes" => "synthetic-private-notes"}}}},
      log: [{:out, %{notes: "synthetic-private-notes"}, self(), %{sessions: sensitive}}],
      reason: %KeyError{key: :command_clock, term: %{sessions: sensitive}}
    }

    formatted = Checklists.format_status(status)
    assert Map.keys(formatted) |> Enum.sort() == Map.keys(status) |> Enum.sort()
    assert formatted.message == %{operation: :execute_command}
    assert formatted.reason == {:exception, KeyError}
    assert formatted.state == %{storage: :dets}
    assert formatted.log == []
    refute inspect(formatted) =~ sensitive
    refute inspect(formatted) =~ "synthetic-private-notes"
  end

  test "an unavailable command store returns a safe retryable failure instead of a call exit",
       ctx do
    cmd = command(ctx.now, 12)

    result =
      Checklists.execute_command(
        "workshop",
        "synthetic-private-token",
        cmd,
        :checklist_command_missing_server
      )

    assert {:error, %{status: "unavailable", operationId: id, taskId: "workshop-1"}} = result
    assert id == cmd["operationId"]
    refute inspect(result) =~ "synthetic-private-token"
    refute inspect(result) =~ "payload"
    refute inspect(result) =~ "noproc"
  end
end
