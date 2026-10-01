defmodule TestServerWeb.ChecklistLive do
  use TestServerWeb, {:live_view, log: false}
  use TestServerNative, [:live_view, formats: [:react_native]]
  alias TestServer.Checklists

  def mount(_params, session, socket) do
    case TestServerWeb.ChecklistAuth.account(session) do
      {:ok, account_id, sid} ->
        if connected?(socket), do: Checklists.subscribe(account_id)

        {:ok,
         socket
         |> assign(
           account_id: account_id,
           auth_session_id: sid,
           error: nil,
           route_params: %{},
           form_key: nil,
           draft: nil,
           form_errors: %{},
           form_status: "editing",
           validated_seq: 0
         )
         |> assign(upload_status: "idle", upload_message: nil)
         |> allow_upload(:attachment,
           accept: ~w(.png .txt),
           max_entries: 1,
           max_file_size: 2_097_152,
           progress: &upload_progress/3
         )
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
          action when action in [:task, :edit] -> Map.take(params, ["id", "task_id"])
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
      if event in ["validate_task", "save_task"] do
        {:reply, %{status: "unauthorized", client_seq: client_seq(params)},
         assign(socket,
           form_status: "unauthorized",
           form_errors: %{"form" => "Sign in again before saving."}
         )}
      else
        {:noreply, redirect(socket, to: "/sign-in")}
      end
    end
  end

  defp handle_authorized_event("validate_upload", _params, socket), do: {:noreply, socket}

  defp handle_authorized_event("cancel_upload", %{"ref" => ref}, socket) do
    if Enum.any?(socket.assigns.uploads.attachment.entries, &(&1.ref == ref)) do
      {:noreply,
       socket
       |> cancel_upload(:attachment, ref)
       |> assign(upload_status: "cancelled", upload_message: nil)}
    else
      {:noreply, assign(socket, upload_message: "The upload is not available.")}
    end
  end

  defp handle_authorized_event("attach_upload", %{"entity_id" => id} = params, socket),
    do:
      handle_authorized_event(
        "attach_upload",
        Map.put(params, "id", id) |> Map.delete("entity_id"),
        socket
      )

  defp handle_authorized_event(
         "attach_upload",
         %{"id" => id, "version" => raw_version},
         %{assigns: %{screen: :task}} = socket
       ) do
    {done, in_progress} = uploaded_entries(socket, :attachment)

    with true <- id == socket.assigns.selected_task.id,
         {:ok, version} <- parse_version(raw_version),
         {:ok, current} <- Checklists.get_task(socket.assigns.account_id, id),
         true <- current.version == version,
         true <- length(done) == 1 and in_progress == [] do
      [result] =
        consume_uploaded_entries(socket, :attachment, fn %{path: path}, entry ->
          result =
            TestServer.Attachments.attach(
              socket.assigns.account_id,
              socket.assigns.auth_session_id,
              id,
              version,
              path,
              entry
            )

          {:ok, result}
        end)

      case result do
        {:ok, _metadata} ->
          {:noreply,
           socket
           |> assign(upload_status: "saved", upload_message: "Attachment saved.")
           |> refresh()}

        {:error, :unauthorized} ->
          {:noreply, redirect(socket, to: "/sign-in")}

        {:error, {:conflict, _}} ->
          {:noreply,
           socket
           |> assign(
             upload_status: "error",
             upload_message:
               "The task changed. Select the file again after reviewing its current version."
           )
           |> refresh()}

        _ ->
          {:noreply,
           assign(socket,
             upload_status: "error",
             upload_message: "The attachment could not be saved."
           )}
      end
    else
      _ ->
        {:noreply,
         socket
         |> assign(
           upload_message:
             "Wait for the upload to finish and review the current task version before saving."
         )
         |> refresh()}
    end
  end

  defp upload_progress(:attachment, entry, socket) do
    {:noreply,
     assign(socket,
       upload_status: if(entry.done?, do: "ready", else: "uploading"),
       upload_message: nil
     )}
  end

  def upload_state(upload, status, message) do
    entry = List.first(upload.entries)
    errors = upload_errors(upload) ++ Enum.flat_map(upload.entries, &upload_errors(upload, &1))

    errors =
      Enum.map(errors, fn
        :too_large -> "Choose a file no larger than 2 MiB."
        :not_accepted -> "Choose a PNG image or text file."
        :too_many_files -> "Choose one file at a time."
        _ -> "The upload could not be completed."
      end)

    errors = if message && status == "error", do: errors ++ [message], else: errors

    %{
      progress: if(entry, do: entry.progress, else: 0),
      ref: if(entry, do: entry.ref, else: ""),
      status:
        cond do
          errors != [] -> "error"
          entry && entry.done? -> "ready"
          entry -> "uploading"
          true -> status
        end,
      errors: errors
    }
  end

  defp handle_authorized_event(event, params, %{assigns: %{screen: :edit}} = socket)
       when event in ["validate_task", "save_task"] do
    {draft, errors, attrs, version, seq} = normalize_form(params, socket)
    # A delayed validation must not replace the latest submitted draft.
    if seq < socket.assigns.validated_seq do
      {:reply, %{status: "stale", client_seq: seq}, socket}
    else
      socket =
        assign(socket,
          draft: draft,
          form_errors: errors,
          validated_seq: seq,
          form_status: if(map_size(errors) == 0, do: "editing", else: "invalid")
        )

      if event == "validate_task" or map_size(errors) > 0 do
        {:reply,
         %{status: if(map_size(errors) == 0, do: "valid", else: "invalid"), client_seq: seq},
         socket}
      else
        case Checklists.authorized_update_task(
               socket.assigns.account_id,
               socket.assigns.auth_session_id,
               socket.assigns.selected_task.id,
               attrs,
               version
             ) do
          {:ok, task} ->
            {:reply, %{status: "saved", client_seq: seq, version: task.version},
             socket
             |> assign(
               form_status: "saved",
               draft: Map.put(socket.assigns.draft, "version", to_string(task.version))
             )
             |> refresh()}

          {:error, {:conflict, _current}} ->
            {:reply, %{status: "conflict", client_seq: seq},
             socket
             |> assign(
               form_status: "conflict",
               form_errors: %{
                 "version" =>
                   "This task changed. Your draft is safe. Cancel and reopen to review the saved version."
               }
             )
             |> refresh()}

          {:error, :unauthorized} ->
            {:reply, %{status: "unauthorized", client_seq: seq},
             assign(socket,
               form_status: "unauthorized",
               form_errors: %{"form" => "Sign in again before saving."}
             )}

          _ ->
            {:reply, %{status: "invalid", client_seq: seq},
             assign(socket,
               form_status: "invalid",
               form_errors: %{"form" => "The task could not be saved."}
             )}
        end
      end
    end
  end

  defp client_seq(params) do
    case params["client_seq"] do
      value when is_binary(value) ->
        case Integer.parse(value) do
          {number, ""} when number >= 0 and number <= 2_147_483_647 -> number
          _ -> 0
        end

      _ ->
        0
    end
  end

  defp normalize_form(params, socket) do
    task = if is_map(params["task"]), do: params["task"], else: %{}
    selected = socket.assigns.selected_task
    title = if is_binary(task["title"]), do: task["title"], else: ""
    notes = if is_binary(task["notes"]), do: task["notes"], else: ""
    completed = task["completed"]
    version_result = parse_version(task["version"])

    seq = client_seq(params)

    errors = %{}

    errors =
      if task["id"] == selected.id,
        do: errors,
        else: Map.put(errors, "id", "This task is not available.")

    errors =
      if is_binary(task["title"]) and String.trim(title) != "" and String.length(title) <= 120,
        do: errors,
        else: Map.put(errors, "title", "Enter a title between 1 and 120 characters.")

    errors =
      if is_binary(task["notes"]) and String.length(notes) <= 2_000,
        do: errors,
        else: Map.put(errors, "notes", "Notes must be at most 2000 characters.")

    errors =
      if completed in ["true", "false"],
        do: errors,
        else: Map.put(errors, "completed", "Choose a valid completion state.")

    errors =
      if match?({:ok, _}, version_result),
        do: errors,
        else: Map.put(errors, "version", "Refresh this task before saving.")

    draft = %{
      "id" => selected.id,
      "title" => title,
      "notes" => notes,
      "completed" => if(completed == "true", do: "true", else: "false"),
      "version" =>
        if(is_binary(task["version"]), do: task["version"], else: to_string(selected.version))
    }

    version =
      case version_result do
        {:ok, value} -> value
        _ -> nil
      end

    {draft, errors, %{title: title, notes: notes, completed: completed == "true"}, version, seq}
  end

  defp handle_authorized_event(event, _params, socket)
       when event in ["validate_task", "save_task"],
       do:
         {:reply, %{status: "invalid", client_seq: 0},
          assign(socket, error: "Open a task to edit it.")}

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
      editing = socket.assigns.live_action == :edit
      key = socket.assigns.account_id <> ":" <> task.id

      socket =
        assign(socket,
          screen: if(editing, do: :edit, else: :task),
          screen_title: if(editing, do: "Edit task", else: task.title),
          visible_checklists: [%{checklist | tasks: [task]}],
          selected_task: task,
          route: if(editing, do: task_path(id, task_id) <> "/edit", else: task_path(id, task_id)),
          parent_route: if(editing, do: task_path(id, task_id), else: checklist_path(id))
        )

      socket =
        if editing and socket.assigns.form_key != key do
          assign(socket,
            form_key: key,
            draft: %{
              "id" => task.id,
              "title" => task.title,
              "notes" => task.notes,
              "completed" => to_string(task.completed),
              "version" => to_string(task.version)
            },
            form_errors: %{},
            form_status: "editing",
            validated_seq: 0
          )
        else
          socket
        end

      {:ok, socket}
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
      <article :for={checklist <- @visible_checklists} :if={@screen != :edit} id={checklist.id}>
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
          <.link
            :if={@screen == :task}
            id="edit-task"
            navigate={task_path(checklist.id, task.id) <> "/edit"}
          >
            Edit task
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
      <form
        :if={@screen == :edit}
        id="task-form"
        phx-change="validate_task"
        phx-submit="save_task"
        phx-debounce="250"
        data-form-key={@form_key}
        data-version={@selected_task.version}
        data-form-errors={Jason.encode!(@form_errors)}
        data-form-status={@form_status}
        data-saved-route={@parent_route}
        data-validated-seq={@validated_seq}
      >
        <input name="task[id]" type="hidden" value={@draft["id"]} />
        <input name="task[version]" type="hidden" value={@draft["version"]} />
        <input name="client_seq" type="hidden" value={@validated_seq} />
        <label>Title <input name="task[title]" value={@draft["title"]} /></label>
        <p id="title-error">{@form_errors["title"]}</p>
        <label>Notes <textarea name="task[notes]">{@draft["notes"]}</textarea></label>
        <p id="notes-error">{@form_errors["notes"]}</p>
        <input name="task[completed]" type="hidden" value="false" />
        <label>
          Completed
          <input
            name="task[completed]"
            type="checkbox"
            value="true"
            checked={@draft["completed"] == "true"}
          />
        </label>
        <p id="completed-error">{@form_errors["completed"]}</p>
        <p id="version-error">{@form_errors["version"]}</p>
        <p id="form-error">{@form_errors["id"] || @form_errors["form"]}</p>
        <p :if={@form_status == "saved"} id="save-success">Task saved.</p>
        <.link
          :if={@form_status == "saved"}
          id="saved-task-link"
          navigate={@parent_route}
          replace={true}
        >
          View saved task
        </.link>
        <button type="submit">Save task</button>
        <.link id="cancel-edit" navigate={@parent_route} replace={true}>Cancel</.link>
      </form>
      <form
        :if={@screen == :task}
        id="attachment-form"
        phx-change="validate_upload"
        phx-submit="attach_upload"
      >
        <input type="hidden" name="entity_id" value={@selected_task.id} />
        <input type="hidden" name="version" value={@selected_task.version} />
        <.live_file_input upload={@uploads.attachment} />
        <p
          :for={error <- upload_state(@uploads.attachment, @upload_status, @upload_message).errors}
          role="alert"
        >
          {error}
        </p>
        <div :for={entry <- @uploads.attachment.entries}>
          <span>{entry.client_name}: {entry.progress}%</span>
          <button id="cancel-upload" type="button" phx-click="cancel_upload" phx-value-ref={entry.ref}>
            Cancel upload
          </button>
        </div>
        <button
          id="save-attachment"
          type="submit"
          disabled={not Enum.any?(@uploads.attachment.entries, & &1.done?)}
        >
          Save attachment
        </button>
        <p id="upload-message">{@upload_message}</p>
        <p :for={attachment <- Map.get(@selected_task, :attachments, [])} class="attachment-summary">
          {attachment.name} · {attachment.size} bytes
        </p>
      </form>
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
      <View :if={@screen != :edit} :for={checklist <- @visible_checklists} id={checklist.id} data-style="card">
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
          <Pressable :if={@screen == :task} id="edit-task" data-navigate={TestServerWeb.ChecklistLive.task_path(checklist.id, task.id) <> "/edit"} data-nav-action="push" data-style="button">
            <Text data-style="buttonLabel">Edit task</Text>
          </Pressable>
          <Text :if={@screen == :task} id="task-notes" data-style="caption"><%= if task.notes == "", do: "No notes yet.", else: task.notes %></Text>

          <Pressable id={"toggle-" <> task.id} data-style="button" phx-click="toggle_task" phx-value-id={task.id} phx-value-version={task.version}>
            <Text data-style="buttonLabel"><%= if task.completed, do: "Mark incomplete", else: "Complete task" %></Text>
          </Pressable>
        </View>
      </View>
      <Form :if={@screen == :edit} id="task-form" data-form-key={@form_key} data-version={@selected_task.version} data-form-errors={Jason.encode!(@form_errors)} data-form-status={@form_status} data-saved-route={@parent_route} data-validated-seq={@validated_seq} phx-change="validate_task" phx-submit="save_task" phx-debounce="250">
        <Text data-style="caption">TITLE</Text>
        <TextInput name="task[title]" value={@draft["title"]} accessibilityLabel="Title" />
        <Text data-style="caption">NOTES</Text>
        <TextInput name="task[notes]" value={@draft["notes"]} multiline="true" accessibilityLabel="Notes" />
        <Text data-style="caption">COMPLETED</Text>
        <Switch name="task[completed]" value={@draft["completed"]} accessibilityLabel="Completed" />
        <HiddenInput name="task[id]" value={@draft["id"]} />
        <HiddenInput name="task[version]" value={@draft["version"]} />
        <FormButton data-style="button"><Text data-style="buttonLabel">Save task</Text></FormButton>
        <Pressable id="cancel-edit" data-form-cancel="true" data-navigate={@parent_route} data-nav-action="replace" data-style="button"><Text data-style="buttonLabel">Cancel</Text></Pressable>
      </Form>
      <View :if={@screen == :task} data-style="card">
        <Text data-style="caption">ATTACHMENTS</Text>
        <UploadInput name="attachment" id={@uploads.attachment.ref} data-phx-upload-ref={@uploads.attachment.ref} accept=".png,.txt" data-phx-active-refs={Enum.map_join(@uploads.attachment.entries, ",", & &1.ref)} data-phx-done-refs={Enum.filter(@uploads.attachment.entries, & &1.done?) |> Enum.map_join(",", & &1.ref)} data-phx-preflighted-refs={Enum.filter(@uploads.attachment.entries, & &1.preflighted?) |> Enum.map_join(",", & &1.ref)} data-upload-progress={TestServerWeb.ChecklistLive.upload_state(@uploads.attachment, @upload_status, @upload_message).progress} data-upload-ref={TestServerWeb.ChecklistLive.upload_state(@uploads.attachment, @upload_status, @upload_message).ref} data-upload-status={TestServerWeb.ChecklistLive.upload_state(@uploads.attachment, @upload_status, @upload_message).status} data-upload-errors={Jason.encode!(TestServerWeb.ChecklistLive.upload_state(@uploads.attachment, @upload_status, @upload_message).errors)} />
        <Pressable :for={entry <- @uploads.attachment.entries} id="cancel-upload" data-cancel-upload-field="attachment" phx-click="cancel_upload" phx-value-ref={entry.ref} data-style="button"><Text data-style="buttonLabel">Cancel upload</Text></Pressable>
        <Pressable id="save-attachment" disabled={if Enum.any?(@uploads.attachment.entries, & &1.done?), do: "false", else: "true"} phx-click="attach_upload" phx-value-id={@selected_task.id} phx-value-version={@selected_task.version} data-style="button"><Text data-style="buttonLabel">Save attachment</Text></Pressable>
        <Text :if={@upload_message} id="upload-message" data-style="caption"><%= @upload_message %></Text>
        <Text :for={attachment <- Map.get(@selected_task, :attachments, [])} data-style="caption"><%= attachment.name %> · <%= attachment.size %> bytes</Text>
      </View>
    </View>
    """
  end
end
