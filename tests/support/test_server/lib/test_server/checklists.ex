defmodule TestServer.Checklists do
  @moduledoc """
  Small durable demo domain. One serialized write contains all account records and
  command receipts, so future replay cannot acknowledge a receipt separately
  from its mutation. DETS is suitable for this single-node sample, not clustering.
  """
  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  def list(account_id, server \\ __MODULE__), do: GenServer.call(server, {:list, account_id})

  def get(account_id, checklist_id, server \\ __MODULE__),
    do: GenServer.call(server, {:get, account_id, checklist_id})

  def get_task(account_id, task_id, server \\ __MODULE__),
    do: GenServer.call(server, {:get_task, account_id, task_id})

  def update_task(account_id, task_id, attrs, expected_version, server \\ __MODULE__),
    do: GenServer.call(server, {:update_task, account_id, task_id, attrs, expected_version})

  def issue_session(account_id, ttl \\ 86_400, server \\ __MODULE__),
    do: GenServer.call(server, {:issue_session, account_id, ttl})

  def authenticate_session(account_id, sid, server \\ __MODULE__),
    do: GenServer.call(server, {:authenticate_session, account_id, sid})

  def revoke_session(account_id, sid, server \\ __MODULE__),
    do: GenServer.call(server, {:revoke_session, account_id, sid})

  def authorized_update_task(
        account_id,
        sid,
        task_id,
        attrs,
        expected_version,
        server \\ __MODULE__
      ),
      do:
        GenServer.call(
          server,
          {:authorized_update_task, account_id, sid, task_id, attrs, expected_version}
        )

  def authorized_attach_task(
        account_id,
        sid,
        task_id,
        attachment,
        expected_version,
        server \\ __MODULE__
      ),
      do:
        GenServer.call(
          server,
          {:authorized_attach_task, account_id, sid, task_id, attachment, expected_version}
        )

  def execute_command(account_id, sid, command, server \\ __MODULE__) do
    try do
      GenServer.call(server, {:execute_command, account_id, sid, command})
    catch
      # Call exits embed the original request in the caller's failure reason.
      # Never propagate a session token or command payload into LiveView logs.
      :exit, _reason -> {:error, command_failure(command, :unavailable)}
    end
  end

  def subscribe(account_id), do: Phoenix.PubSub.subscribe(TestServer.PubSub, topic(account_id))
  defp topic(account_id), do: "checklists:" <> account_id

  @impl true
  def init(opts) do
    path = Keyword.get(opts, :path, Application.fetch_env!(:test_server, :checklist_store_path))
    table = Keyword.get(opts, :table, __MODULE__)
    File.mkdir_p!(Path.dirname(path))
    {:ok, ^table} = :dets.open_file(table, file: String.to_charlist(path), type: :set)

    for id <- ["workshop", "studio"] do
      if :dets.lookup(table, id) == [], do: :ok = :dets.insert(table, {id, seed(id)})
    end

    :ok = :dets.sync(table)

    {:ok,
     %{
       table: table,
       command_clock:
         Keyword.get(opts, :command_clock, fn -> System.system_time(:millisecond) end),
       receipt_limit: Keyword.get(opts, :receipt_limit, 1024)
     }}
  end

  @impl true
  def code_change(_old_version, state, _extra) do
    {:ok,
     state
     |> Map.put_new(:command_clock, fn -> System.system_time(:millisecond) end)
     |> Map.put_new(:receipt_limit, 1024)}
  end

  @impl true
  def format_status(status) do
    # OTP 25+/Elixir 1.17+ uses this map for crash reports and sys.get_status.
    # Keep fixed operation/error labels; never format session IDs or user data.
    Map.new(status, fn
      {:state, _} -> {:state, %{storage: :dets}}
      {:message, message} -> {:message, %{operation: status_operation(message)}}
      {:log, _} -> {:log, []}
      {:reason, reason} -> {:reason, status_reason(reason)}
      {key, _} -> {key, :redacted}
    end)
  end

  defp status_operation({:"$gen_call", _from, request}), do: status_operation(request)
  defp status_operation({:"$gen_cast", request}), do: status_operation(request)

  defp status_operation(request) when is_tuple(request) and tuple_size(request) > 0 do
    operation = elem(request, 0)

    if operation in [
         :list,
         :get,
         :get_task,
         :update_task,
         :issue_session,
         :authenticate_session,
         :revoke_session,
         :authorized_update_task,
         :authorized_attach_task,
         :execute_command
       ], do: operation, else: :redacted
  end

  defp status_operation(_), do: :redacted

  defp status_reason(%{__struct__: exception}) when is_atom(exception),
    do: {:exception, exception}

  defp status_reason(reason) when is_atom(reason), do: reason

  defp status_reason(reason) when is_tuple(reason) and tuple_size(reason) > 0 do
    if is_atom(elem(reason, 0)), do: elem(reason, 0), else: :redacted
  end

  defp status_reason(_), do: :redacted

  @impl true
  def terminate(_reason, %{table: table}), do: :dets.close(table)

  @impl true
  def handle_call({:list, account_id}, _from, state) do
    result =
      with {:ok, account} <- account(state, account_id),
           do: {:ok, account.checklists |> Map.values() |> Enum.sort_by(& &1.id)}

    {:reply, result, state}
  end

  def handle_call({:get, account_id, checklist_id}, _from, state) do
    result =
      with {:ok, account} <- account(state, account_id),
           {:ok, checklist} <- Map.fetch(account.checklists, checklist_id),
           do: {:ok, checklist}

    {:reply, normalize_not_found(result), state}
  end

  def handle_call({:get_task, account_id, task_id}, _from, state) do
    result =
      with {:ok, account} <- account(state, account_id),
           {:ok, _checklist, task} <- find_task(account, task_id),
           do: {:ok, task}

    {:reply, result, state}
  end

  def handle_call({:issue_session, account_id, ttl}, _from, state) do
    result =
      with {:ok, account} <- account(state, account_id),
           true <- is_integer(ttl) and ttl >= 0 and ttl <= 86_400 do
        now = System.system_time(:second)
        sid = :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)

        active =
          Map.get(account, :sessions, %{})
          |> Enum.filter(fn {_sid, session} -> session.expires_at > now end)

        # Keep at most 31 old active sessions before adding the new one.
        active =
          active
          |> Enum.sort_by(fn {key, session} -> {session.issued_at, key} end, :desc)
          |> Enum.take(31)
          |> Map.new()

        sessions = Map.put(active, sid, %{issued_at: now, expires_at: now + ttl})
        persist(state, account_id, Map.put(account, :sessions, sessions))
        {:ok, sid}
      else
        false -> {:error, :invalid}
        error -> error
      end

    {:reply, result, state}
  end

  def handle_call({:authenticate_session, account_id, sid}, _from, state) do
    {:reply, authorized(state, account_id, sid), state}
  end

  def handle_call({:revoke_session, account_id, sid}, _from, state) do
    with {:ok, account} <- account(state, account_id) do
      sessions = Map.get(account, :sessions, %{}) |> Map.delete(sid)
      persist(state, account_id, Map.put(account, :sessions, sessions))
      Phoenix.PubSub.broadcast(TestServer.PubSub, topic(account_id), {:session_revoked, sid})
    end

    {:reply, :ok, state}
  end

  def handle_call(
        {:authorized_update_task, account_id, sid, task_id, attrs, expected_version},
        from,
        state
      ) do
    case authorized(state, account_id, sid) do
      :ok ->
        handle_call({:update_task, account_id, task_id, attrs, expected_version}, from, state)

      error ->
        {:reply, error, state}
    end
  end

  def handle_call(
        {:authorized_attach_task, account_id, sid, task_id, attachment, expected_version},
        _from,
        state
      ) do
    result =
      with :ok <- authorized(state, account_id, sid),
           {:ok, account} <- account(state, account_id),
           {:ok, checklist, task} <- find_task(account, task_id),
           :ok <- check_version(task, expected_version),
           :ok <- validate_attachment(account_id, attachment) do
        updated =
          task
          |> Map.put(:attachments, Map.get(task, :attachments, []) ++ [attachment])
          |> Map.put(:version, task.version + 1)

        tasks =
          Enum.map(checklist.tasks, fn item -> if item.id == task_id, do: updated, else: item end)

        persist(state, account_id, put_in(account.checklists[checklist.id].tasks, tasks))

        Phoenix.PubSub.broadcast(
          TestServer.PubSub,
          topic(account_id),
          {:checklists_changed, account_id}
        )

        {:ok, updated}
      end

    {:reply, result, state}
  end

  def handle_call({:execute_command, account_id, sid, command}, _from, state) do
    result =
      with :ok <- authorized(state, account_id, sid),
           :ok <- command_account(command, account_id),
           {:ok, normalized, updates, created_at} <- validate_command(command, account_id),
           now = Map.get(state, :command_clock, fn -> System.system_time(:millisecond) end).(),
           :ok <- command_age(created_at, now),
           {:ok, account} <- account(state, account_id) do
        operation_id = normalized["operationId"]
        fingerprint = :crypto.hash(:sha256, :erlang.term_to_binary(normalized, [:deterministic]))
        receipts = Map.get(account, :receipts, %{})

        case Map.get(receipts, operation_id) do
          %{fingerprint: ^fingerprint, receipt: receipt} ->
            {:ok, receipt}

          %{} ->
            {:error, :id_reused}

          nil ->
            commit_command(
              state,
              account_id,
              account,
              normalized,
              updates,
              fingerprint,
              created_at,
              now
            )
        end
      end

    result =
      case result do
        {:error, %{status: _}} -> result
        {:error, status} -> {:error, command_failure(command, status)}
        success -> success
      end

    {:reply, result, state}
  end

  def handle_call({:update_task, account_id, task_id, attrs, expected_version}, _from, state) do
    result =
      with {:ok, account} <- account(state, account_id),
           {:ok, checklist, task} <- find_task(account, task_id),
           :ok <- check_version(task, expected_version),
           {:ok, updates} <- validate(attrs) do
        updated = task |> Map.merge(updates) |> Map.put(:version, task.version + 1)

        tasks =
          Enum.map(checklist.tasks, fn item -> if item.id == task_id, do: updated, else: item end)

        record = put_in(account.checklists[checklist.id].tasks, tasks)
        # Do not report success or broadcast until both the record and its receipt
        # container are durable. A storage failure terminates this process/call.
        persist(state, account_id, record)

        Phoenix.PubSub.broadcast(
          TestServer.PubSub,
          topic(account_id),
          {:checklists_changed, account_id}
        )

        {:ok, updated}
      end

    {:reply, result, state}
  end

  defp commit_command(state, account_id, account, command, updates, fingerprint, created_at, now) do
    receipts =
      Map.get(account, :receipts, %{})
      |> Enum.filter(fn {_id, stored} -> stored.receipt.retainedUntil > now end)
      |> Map.new()

    with {:ok, checklist, task} <- find_task(account, command["taskId"]),
         true <- task.version == command["expectedVersion"],
         true <- map_size(receipts) < Map.get(state, :receipt_limit, 1024) do
      updated = task |> Map.merge(updates) |> Map.put(:version, task.version + 1)

      tasks =
        Enum.map(checklist.tasks, fn item -> if item.id == task.id, do: updated, else: item end)

      receipt = %{
        operationId: command["operationId"],
        status: "committed",
        taskId: task.id,
        version: updated.version,
        committedAt: now,
        retainedUntil: created_at + 604_800_000
      }

      record = put_in(account.checklists[checklist.id].tasks, tasks)

      record =
        Map.put(
          record,
          :receipts,
          Map.put(receipts, command["operationId"], %{fingerprint: fingerprint, receipt: receipt})
        )

      # This single account object contains BOTH the domain mutation and receipt.
      persist(state, account_id, record)

      Phoenix.PubSub.broadcast(
        TestServer.PubSub,
        topic(account_id),
        {:checklists_changed, account_id}
      )

      {:ok, receipt}
    else
      false ->
        {:ok, _checklist, task} = find_task(account, command["taskId"])

        if task.version != command["expectedVersion"],
          do:
            {:error, Map.put(command_failure(command, :conflict), :currentVersion, task.version)},
          else: {:error, :quota}

      error ->
        error
    end
  end

  defp command_account(%{"accountId" => supplied}, account_id) when is_binary(supplied),
    do: if(supplied == account_id, do: :ok, else: {:error, :unauthorized})

  defp command_account(_, _), do: {:error, :invalid}

  defp validate_command(command, account_id) when is_map(command) do
    expected_keys = ~w(operationId accountId taskId expectedVersion type payload)
    id = command["operationId"]

    with true <- Enum.sort(Map.keys(command)) == Enum.sort(expected_keys),
         true <- is_binary(id) and Regex.match?(~r/^[0-9]{13}-[0-9a-f]{32}$/, id),
         true <- command["accountId"] == account_id,
         true <- is_binary(command["taskId"]) and byte_size(command["taskId"]) in 1..100,
         true <- is_integer(command["expectedVersion"]) and command["expectedVersion"] > 0,
         {:ok, attrs} <- command_updates(command["type"], command["payload"]),
         :ok <- normalize_validation(validate(attrs)) do
      {timestamp, ""} = id |> String.slice(0, 13) |> Integer.parse()
      {:ok, command, attrs, timestamp}
    else
      _ -> {:error, :invalid}
    end
  end

  defp validate_command(_, _), do: {:error, :invalid}

  defp command_updates("set_completed", %{"completed" => completed} = payload)
       when map_size(payload) == 1 and is_boolean(completed),
       do: {:ok, %{completed: completed}}

  defp command_updates(
         "update_task",
         %{"title" => title, "notes" => notes, "completed" => completed} = payload
       )
       when map_size(payload) == 3,
       do: {:ok, %{title: title, notes: notes, completed: completed}}

  defp command_updates(_, _), do: {:error, :invalid}
  defp normalize_validation({:ok, _}), do: :ok
  defp normalize_validation(_), do: {:error, :invalid}

  defp command_age(timestamp, now) do
    cond do
      timestamp + 604_800_000 <= now -> {:error, :expired}
      timestamp > now + 300_000 -> {:error, :invalid}
      true -> :ok
    end
  end

  defp command_failure(command, status) do
    failure = %{status: to_string(status)}

    if is_map(command) do
      failure =
        case command["operationId"] do
          value when is_binary(value) and byte_size(value) == 46 ->
            Map.put(failure, :operationId, value)

          _ ->
            failure
        end

      case command["taskId"] do
        value when is_binary(value) and byte_size(value) in 1..100 ->
          Map.put(failure, :taskId, value)

        _ ->
          failure
      end
    else
      failure
    end
  end

  defp validate_attachment(
         account_id,
         %{name: name, type: type, size: size, storage_key: key} = attachment
       ) do
    extension =
      case type do
        "image/png" -> ".png"
        "text/plain" -> ".txt"
        _ -> nil
      end

    valid_key = is_binary(key) and Regex.match?(~r/^[a-z]+\/[0-9a-f]{32}\.(png|txt)$/, key)

    if map_size(attachment) == 4 and is_binary(name) and String.length(name) in 1..120 and
         is_integer(size) and size in 1..2_097_152 and extension != nil and valid_key and
         String.starts_with?(key, account_id <> "/") and String.ends_with?(key, extension),
       do: :ok,
       else: {:error, :invalid}
  end

  defp validate_attachment(_, _), do: {:error, :invalid}

  defp persist(state, account_id, record) do
    :ok = :dets.insert(state.table, {account_id, record})
    :ok = :dets.sync(state.table)
  end

  defp authorized(state, account_id, sid) when is_binary(sid) do
    with {:ok, account} <- account(state, account_id),
         %{expires_at: expires_at} <- Map.get(Map.get(account, :sessions, %{}), sid),
         true <- expires_at > System.system_time(:second) do
      :ok
    else
      _ -> {:error, :unauthorized}
    end
  end

  defp authorized(_, _, _), do: {:error, :unauthorized}

  defp account(state, id) when is_binary(id) do
    case :dets.lookup(state.table, id) do
      [{^id, account}] ->
        checklists =
          Map.new(account.checklists, fn {id, checklist} ->
            {id,
             %{checklist | tasks: Enum.map(checklist.tasks, &Map.put_new(&1, :attachments, []))}}
          end)

        {:ok, account |> Map.put(:checklists, checklists) |> Map.put_new(:receipts, %{})}

      [] ->
        {:error, :not_found}
    end
  end

  defp account(_, _), do: {:error, :not_found}

  defp find_task(account, task_id) do
    Enum.find_value(account.checklists, {:error, :not_found}, fn {_id, checklist} ->
      case Enum.find(checklist.tasks, &(&1.id == task_id)) do
        nil -> nil
        task -> {:ok, checklist, task}
      end
    end)
  end

  defp normalize_not_found(:error), do: {:error, :not_found}
  defp normalize_not_found(result), do: result
  defp check_version(%{version: version}, version), do: :ok
  defp check_version(task, _), do: {:error, {:conflict, task}}

  defp validate(attrs) when is_map(attrs) and map_size(attrs) > 0 do
    if Enum.all?(attrs, fn
         {:completed, value} ->
           is_boolean(value)

         {:title, value} ->
           is_binary(value) and String.trim(value) != "" and String.length(value) <= 120

         {:notes, value} ->
           is_binary(value) and String.length(value) <= 2_000

         _ ->
           false
       end), do: {:ok, attrs}, else: {:error, :invalid}
  end

  defp validate(_), do: {:error, :invalid}

  defp seed(id) do
    titles =
      if id == "workshop",
        do: ["Prepare the workbench", "Check the tools", "Photograph the finished setup"],
        else: ["Set up the lights", "Check the camera", "Record the first take"]

    tasks =
      titles
      |> Enum.with_index(1)
      |> Enum.map(fn {title, index} ->
        %{
          id: "#{id}-#{index}",
          title: title,
          notes: "",
          completed: false,
          version: 1,
          attachments: []
        }
      end)

    checklist = %{
      id: "#{id}-launch",
      title: if(id == "workshop", do: "Workshop opening", else: "Studio opening"),
      tasks: tasks
    }

    %{
      id: id,
      name: String.capitalize(id),
      checklists: %{checklist.id => checklist},
      receipts: %{}
    }
  end
end
