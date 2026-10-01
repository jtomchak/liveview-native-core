defmodule TestServerWeb.ChecklistUploadTest do
  use TestServerWeb.ConnCase, async: false
  import Phoenix.LiveViewTest
  alias TestServer.Checklists
  @path "/checklists/workshop-launch/tasks/workshop-1"
  @png Base.decode64!(
         "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII="
       )

  setup %{conn: conn} do
    {:ok, sid} = Checklists.issue_session("workshop")
    conn = init_test_session(conn, %{"account_id" => "workshop", "auth_session_id" => sid})
    {:ok, conn: conn, sid: sid}
  end

  defp file(name, type, content),
    do: %{name: name, type: type, content: content, last_modified: 1_710_000_000_000}

  defp finish(view, name, type, content) do
    input = file_input(view, "#attachment-form", :attachment, [file(name, type, content)])
    render_upload(input, name)
  end

  defp save(view, id \\ "workshop-1") do
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")
    render_click(view, "attach_upload", %{"id" => id, "version" => to_string(task.version)})
  end

  test "native upload input declares progress/ref metadata and initial disabled save", %{
    conn: conn
  } do
    body = conn |> get(@path <> "?_format=react_native") |> response(200)
    assert body =~ "<UploadInput"
    assert body =~ ~s(name="attachment")
    assert body =~ "data-phx-upload-ref="
    assert body =~ ~s(data-upload-progress="0")
    assert body =~ ~s(data-upload-status="idle")
    assert body =~ ~s(id="save-attachment" disabled="true")
  end

  test "text and PNG uploads finalize private durable metadata", %{conn: conn} do
    for {name, type, content} <- [
          {"instructions.txt", "text/plain", "Bring gloves"},
          {"setup.png", "image/png", @png}
        ] do
      {:ok, view, _} = live(conn, @path)
      finish(view, name, type, content)
      assert has_element?(view, "#attachment-form", "100%")
      assert {:ok, before} = Checklists.get_task("workshop", "workshop-1")

      if name == "instructions.txt" do
        render_submit(view, "attach_upload", %{
          "entity_id" => before.id,
          "version" => to_string(before.version)
        })
      else
        save(view)
      end

      assert has_element?(view, "#upload-message", "Attachment saved")
      {:ok, after_task} = Checklists.get_task("workshop", "workshop-1")
      assert after_task.version == before.version + 1
      attachment = List.last(after_task.attachments)
      assert attachment.name == name
      assert attachment.type == type
      assert attachment.size == byte_size(content)
      path = Path.join(TestServer.Attachments.root(), attachment.storage_key)
      assert File.read!(path) == content
      on_exit(fn -> File.rm(path) end)
      {:ok, reopened, _} = live(conn, @path)
      assert has_element?(reopened, ".attachment-summary", name)
    end
  end

  test "oversized and unsupported file selections are rejected", %{conn: conn} do
    for {name, type, content} <- [
          {"huge.txt", "text/plain", String.duplicate("a", 2_097_153)},
          {"unsafe.exe", "application/octet-stream", "bad"}
        ] do
      {:ok, view, _} = live(conn, @path)
      input = file_input(view, "#attachment-form", :attachment, [file(name, type, content)])
      assert {:error, _} = render_upload(input, name)
      assert has_element?(view, "[role=alert]")
    end
  end

  test "partial upload cancellation allows another selection and successful save", %{conn: conn} do
    {:ok, view, _} = live(conn, @path)

    input =
      file_input(view, "#attachment-form", :attachment, [
        file("cancel.txt", "text/plain", "A draft attachment")
      ])

    render_upload(input, "cancel.txt", 50)
    view |> element("#cancel-upload") |> render_click()
    refute has_element?(view, "#cancel-upload")
    finish(view, "retry.txt", "text/plain", "Retry complete")
    save(view)
    assert has_element?(view, "#upload-message", "Attachment saved")
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")
    path = Path.join(TestServer.Attachments.root(), List.last(task.attachments).storage_key)
    on_exit(fn -> File.rm(path) end)
  end

  test "foreign target and stale versions cannot consume a ready upload", %{conn: conn} do
    {:ok, view, _} = live(conn, @path)
    finish(view, "guarded.txt", "text/plain", "Keep until valid save")
    {:ok, before} = Checklists.get_task("workshop", "workshop-1")
    save(view, "studio-1")
    assert {:ok, ^before} = Checklists.get_task("workshop", "workshop-1")
    render_click(view, "attach_upload", %{"id" => before.id, "version" => "0"})
    assert {:ok, ^before} = Checklists.get_task("workshop", before.id)
    save(view)
    {:ok, task} = Checklists.get_task("workshop", before.id)
    assert task.version == before.version + 1
    path = Path.join(TestServer.Attachments.root(), List.last(task.attachments).storage_key)
    on_exit(fn -> File.rm(path) end)
  end

  test "invalid PNG contents fail without attaching metadata", %{conn: conn} do
    {:ok, view, _} = live(conn, @path)
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")
    finish(view, "fake.png", "image/png", "not a PNG")
    save(view)
    assert has_element?(view, "#upload-message", "could not be saved")
    assert {:ok, ^task} = Checklists.get_task("workshop", "workshop-1")
  end

  test "finalization rolls back files for authorization and version failures", %{sid: sid} do
    source =
      Path.join(System.tmp_dir!(), "upload-rollback-#{System.unique_integer([:positive])}.txt")

    File.write!(source, "Private note")
    on_exit(fn -> File.rm(source) end)
    entry = %{client_name: "../private.txt", client_size: 12}
    directory = Path.join(TestServer.Attachments.root(), "workshop")
    before_files = Path.wildcard(Path.join(directory, "*"))
    {:ok, task} = Checklists.get_task("workshop", "workshop-1")

    assert {:error, {:conflict, _}} =
             TestServer.Attachments.attach(
               "workshop",
               sid,
               task.id,
               task.version - 1,
               source,
               entry
             )

    assert Path.wildcard(Path.join(directory, "*")) == before_files
    :ok = Checklists.revoke_session("workshop", sid)

    assert {:error, :unauthorized} =
             TestServer.Attachments.attach("workshop", sid, task.id, task.version, source, entry)

    assert Path.wildcard(Path.join(directory, "*")) == before_files
    assert {:ok, ^task} = Checklists.get_task("workshop", task.id)
    File.write!(source, "")

    assert {:error, :invalid_file} =
             TestServer.Attachments.store("workshop", source, %{entry | client_size: 0})

    assert Path.wildcard(Path.join(directory, "*")) == before_files
  end
end
