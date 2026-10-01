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
    {:ok, %{table: table}}
  end

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
        :ok = :dets.insert(state.table, {account_id, record})
        :ok = :dets.sync(state.table)

        Phoenix.PubSub.broadcast(
          TestServer.PubSub,
          topic(account_id),
          {:checklists_changed, account_id}
        )

        {:ok, updated}
      end

    {:reply, result, state}
  end

  defp account(state, id) when is_binary(id) do
    case :dets.lookup(state.table, id) do
      [{^id, account}] -> {:ok, account}
      [] -> {:error, :not_found}
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
           is_binary(value) and String.trim(value) != "" and byte_size(value) <= 200

         {:notes, value} ->
           is_binary(value) and byte_size(value) <= 10_000

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
        %{id: "#{id}-#{index}", title: title, notes: "", completed: false, version: 1}
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
