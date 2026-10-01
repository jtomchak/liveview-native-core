defmodule TestServerWeb.ChecklistLive do
  use TestServerWeb, :live_view
  use TestServerNative, [:live_view, formats: [:react_native]]
  alias TestServer.Checklists

  def mount(_params, session, socket) do
    case TestServerWeb.ChecklistAuth.account(session) do
      {:ok, account_id, sid} ->
        if connected?(socket), do: Checklists.subscribe(account_id)

        {:ok,
         socket
         |> assign(account_id: account_id, auth_session_id: sid, error: nil, route_params: %{})
         |> refresh()}

      _ ->
        {:ok, redirect(socket, to: "/sign-in")}
    end
  end

  def handle_params(params, _uri, socket) do
    if TestServerWeb.ChecklistAuth.authorized?(socket) do
      # Route identity comes from the matched route, never query keys such as id.
      params =
        case socket.assigns.live_action do
          :show -> Map.take(params, ["id"])
          :task -> Map.take(params, ["id", "task_id"])
          _ -> Map.take(params, ["error"])
        end

      case select_route(assign(socket, route_params: params), params) do
        {:ok, socket} -> {:noreply, socket}
        {:error, :not_found} -> {:noreply, redirect(socket, to: "/checklists?error=not_found")}
      end
    else
      {:noreply, redirect(socket, to: "/sign-in")}
    end
  end

  def handle_event(event, params, socket) do
    if TestServerWeb.ChecklistAuth.authorized?(socket) do
      handle_authorized_event(event, params, socket)
    else
      {:noreply, redirect(socket, to: "/sign-in")}
    end
  end

  defp handle_authorized_event("server_navigation", %{"id" => id} = params, socket) do
    replace = Map.get(params, "replace", "false")

    with true <- replace in ["true", "false"],
         {:ok, checklist} <- Checklists.get(socket.assigns.account_id, id) do
      {:noreply,
       push_navigate(socket, to: checklist_path(checklist.id), replace: replace == "true")}
    else
      _ -> {:noreply, assign(socket, error: "The requested checklist is not available.")}
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
    socket = assign(socket, checklists: checklists)
    {:ok, socket} = select_route(socket, socket.assigns.route_params)
    socket
  end

  defp select_route(socket, %{"id" => id, "task_id" => task_id}) do
    with {:ok, checklist} <- Checklists.get(socket.assigns.account_id, id),
         task when not is_nil(task) <- Enum.find(checklist.tasks, &(&1.id == task_id)) do
      {:ok,
       assign(socket,
         screen: :task,
         screen_title: task.title,
         visible_checklists: [%{checklist | tasks: [task]}],
         selected_task: task,
         route: task_path(id, task_id),
         parent_route: checklist_path(id)
       )}
    else
      _ -> {:error, :not_found}
    end
  end

  defp select_route(socket, %{"id" => id}) do
    with {:ok, checklist} <- Checklists.get(socket.assigns.account_id, id) do
      {:ok,
       assign(socket,
         screen: :checklist,
         screen_title: checklist.title,
         visible_checklists: [checklist],
         selected_task: nil,
         route: checklist_path(id),
         parent_route: "/checklists"
       )}
    end
  end

  defp select_route(socket, params) do
    error =
      if params["error"] == "not_found",
        do: "The requested checklist or task is not available.",
        else: socket.assigns.error

    {:ok,
     assign(socket,
       screen: :list,
       screen_title: "Ready for the day.",
       error: error,
       visible_checklists: socket.assigns.checklists,
       selected_task: nil,
       route: "/checklists",
       parent_route: ""
     )}
  end

  def checklist_path(id), do: "/checklists/" <> URI.encode(id, &URI.char_unreserved?/1)

  def task_path(id, task_id),
    do: checklist_path(id) <> "/tasks/" <> URI.encode(task_id, &URI.char_unreserved?/1)

  def render(assigns) do
    ~H"""
    <section id="checklists-screen" data-route={@route} data-parent-route={@parent_route}>
      <h1>{@screen_title}</h1>
      <p>Saved on Phoenix. Available after reconnect.</p>
      <.link :if={@parent_route != ""} id="parent-link" navigate={@parent_route}>
        Back to checklists
      </.link>
      <p :if={@error} role="alert">{@error}</p>
      <article :for={checklist <- @visible_checklists} id={checklist.id}>
        <h2>{checklist.title}</h2>
        <.link
          :if={@screen == :list}
          id={"open-" <> checklist.id}
          navigate={checklist_path(checklist.id)}
        >
          Open checklist
        </.link>
        <button
          :if={@screen == :list}
          id={"server-open-" <> checklist.id}
          phx-click="server_navigation"
          phx-value-id={checklist.id}
          phx-value-replace="false"
        >
          Continue
        </button>
        <div :for={task <- checklist.tasks} id={task.id}>
          <span>{task.title}</span>
          <span class="task-status">{if task.completed, do: "Complete", else: "To do"}</span>
          <span class="task-version">Version {task.version}</span>
          <.link
            :if={@screen != :task}
            id={"open-" <> task.id}
            navigate={task_path(checklist.id, task.id)}
          >
            View task
          </.link>
          <p :if={@screen == :task} id="task-notes">
            {if task.notes == "", do: "No notes yet.", else: task.notes}
          </p>

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
    <View id="checklists-screen" data-style="screen" data-account={@account_id} data-auth="signed-in" data-route={@route} data-parent-route={@parent_route} data-edit-route={if @screen == :task, do: @route <> "/edit", else: ""} data-records={Jason.encode!(@checklists)}>
      <Text data-style="eyebrow"><%= String.upcase(@account_id) %> / SHARED CHECKLISTS</Text>
      <Text data-style="title"><%= @screen_title %></Text>
      <Text data-style="subtitle">Saved on Phoenix. Available after reconnect.</Text>
      <Pressable :if={@parent_route != ""} id="parent-link" data-navigate={@parent_route} data-nav-action="replace" data-style="button">
        <Text data-style="buttonLabel">Back to checklists</Text>
      </Pressable>
      <Text :if={@error} data-style="caption"><%= @error %></Text>
      <View :for={checklist <- @visible_checklists} id={checklist.id} data-style="card">
        <Text data-style="caption"><%= checklist.title %></Text>
        <Pressable :if={@screen == :list} id={"open-" <> checklist.id} data-navigate={TestServerWeb.ChecklistLive.checklist_path(checklist.id)} data-nav-action="push" data-style="button">
          <Text data-style="buttonLabel">Open checklist</Text>
        </Pressable>
        <Pressable :if={@screen == :list} id={"server-open-" <> checklist.id} phx-click="server_navigation" phx-value-id={checklist.id} phx-value-replace="false" data-style="button">
          <Text data-style="buttonLabel">Continue</Text>
        </Pressable>
        <View :for={task <- checklist.tasks} id={task.id} data-style="task">
          <Text data-style="taskTitle"><%= task.title %></Text>
          <Text data-style="caption"><%= if task.completed, do: "Complete", else: "To do" %> · version <%= task.version %></Text>
          <Pressable :if={@screen != :task} id={"open-" <> task.id} data-navigate={TestServerWeb.ChecklistLive.task_path(checklist.id, task.id)} data-nav-action="push" data-style="button">
            <Text data-style="buttonLabel">View task</Text>
          </Pressable>
          <Text :if={@screen == :task} id="task-notes" data-style="caption"><%= if task.notes == "", do: "No notes yet.", else: task.notes %></Text>

          <Pressable id={"toggle-" <> task.id} data-style="button" phx-click="toggle_task" phx-value-id={task.id} phx-value-version={task.version}>
            <Text data-style="buttonLabel"><%= if task.completed, do: "Mark incomplete", else: "Complete task" %></Text>
          </Pressable>
        </View>
      </View>
    </View>
    """
  end
end
