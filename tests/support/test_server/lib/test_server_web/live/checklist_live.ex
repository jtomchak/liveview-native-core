defmodule TestServerWeb.ChecklistLive do
  use TestServerWeb, :live_view
  use TestServerNative, [:live_view, formats: [:react_native]]
  alias TestServer.Checklists

  def mount(_params, session, socket) do
    case TestServerWeb.ChecklistAuth.account(session) do
      {:ok, account_id, sid} ->
        if connected?(socket), do: Checklists.subscribe(account_id)

        {:ok,
         socket |> assign(account_id: account_id, auth_session_id: sid, error: nil) |> refresh()}

      _ ->
        {:ok, redirect(socket, to: "/sign-in")}
    end
  end

  def handle_event(event, params, socket) do
    if TestServerWeb.ChecklistAuth.authorized?(socket) do
      handle_authorized_event(event, params, socket)
    else
      {:noreply, redirect(socket, to: "/sign-in")}
    end
  end

  defp handle_authorized_event("toggle_task", %{"id" => id, "version" => version}, socket) do
    result =
      with {:ok, expected} <- parse_version(version),
           {:ok, task} <- Checklists.get_task(socket.assigns.account_id, id) do
        Checklists.authorized_update_task(
          socket.assigns.account_id,
          socket.assigns.auth_session_id,
          id,
          %{completed: !task.completed},
          expected
        )
      else
        _ -> {:error, :invalid}
      end

    error =
      case result do
        {:ok, _} -> nil
        {:error, {:conflict, _}} -> "This task changed. Review its current state and try again."
        _ -> "The task could not be updated."
      end

    case result do
      {:error, :unauthorized} -> {:noreply, redirect(socket, to: "/sign-in")}
      _ -> {:noreply, socket |> assign(error: error) |> refresh()}
    end
  end

  defp handle_authorized_event("toggle_task", _params, socket) do
    {:noreply, assign(socket, error: "The task could not be updated.")}
  end

  defp handle_authorized_event(_event, _params, socket),
    do: {:noreply, assign(socket, error: "This action is not available.")}

  defp parse_version(value) when is_binary(value) do
    case Integer.parse(value) do
      {version, ""} when version > 0 -> {:ok, version}
      _ -> {:error, :invalid}
    end
  end

  defp parse_version(_), do: {:error, :invalid}

  def handle_info(
        {:checklists_changed, account_id},
        %{assigns: %{account_id: account_id}} = socket
      ),
      do:
        if(TestServerWeb.ChecklistAuth.authorized?(socket),
          do: {:noreply, refresh(socket)},
          else: {:noreply, redirect(socket, to: "/sign-in")}
        )

  def handle_info({:session_revoked, sid}, socket) do
    if sid == socket.assigns.auth_session_id,
      do: {:noreply, redirect(socket, to: "/sign-in")},
      else: {:noreply, socket}
  end

  defp refresh(socket) do
    {:ok, checklists} = Checklists.list(socket.assigns.account_id)
    assign(socket, checklists: checklists)
  end

  def render(assigns) do
    ~H"""
    <section id="checklists-screen">
      <h1>Shared checklists</h1>
      <p>Saved on Phoenix. Available after reconnect.</p>
      <p :if={@error} role="alert">{@error}</p>
      <article :for={checklist <- @checklists} id={checklist.id}>
        <h2>{checklist.title}</h2>
        <div :for={task <- checklist.tasks} id={task.id}>
          <span>{task.title}</span>
          <span class="task-status">{if task.completed, do: "Complete", else: "To do"}</span>
          <button
            id={"toggle-" <> task.id}
            phx-click="toggle_task"
            phx-value-id={task.id}
            phx-value-version={task.version}
          >
            {if task.completed, do: "Mark incomplete", else: "Complete task"}
          </button>
        </div>
      </article>
    </section>
    """
  end
end

defmodule TestServerWeb.ChecklistLive.ReactNative do
  use TestServerNative, [:render_component, format: :react_native]

  def render(assigns, _interface) do
    ~LVN"""
    <View id="checklists-screen" data-style="screen" data-account={@account_id} data-auth="signed-in" data-records={Jason.encode!(@checklists)}>
      <Text data-style="eyebrow"><%= String.upcase(@account_id) %> / SHARED CHECKLISTS</Text>
      <Text data-style="title">Ready for the day.</Text>
      <Text data-style="subtitle">Saved on Phoenix. Available after reconnect.</Text>
      <Text :if={@error} data-style="caption"><%= @error %></Text>
      <View :for={checklist <- @checklists} id={checklist.id} data-style="card">
        <Text data-style="caption"><%= checklist.title %></Text>
        <View :for={task <- checklist.tasks} id={task.id} data-style="task">
          <Text data-style="taskTitle"><%= task.title %></Text>
          <Text data-style="caption"><%= if task.completed, do: "Complete", else: "To do" %> · version <%= task.version %></Text>
          <Pressable id={"toggle-" <> task.id} data-style="button" phx-click="toggle_task" phx-value-id={task.id} phx-value-version={task.version}>
            <Text data-style="buttonLabel"><%= if task.completed, do: "Mark incomplete", else: "Complete task" %></Text>
          </Pressable>
        </View>
      </View>
    </View>
    """
  end
end
