defmodule TestServer.Attachments do
  @moduledoc "Private server-generated file storage for the foreground upload sample."

  def root do
    Application.get_env(
      :test_server,
      :attachment_store_path,
      Path.join(
        Path.dirname(Application.fetch_env!(:test_server, :checklist_store_path)),
        "uploads"
      )
    )
  end

  def store(account_id, source, entry) do
    extension = entry.client_name |> Path.extname() |> String.downcase()

    with {:ok, content} <- File.read(source),
         true <-
           byte_size(content) > 0 and byte_size(content) <= 2_097_152 and
             byte_size(content) == entry.client_size,
         {:ok, type} <- content_type(extension, content) do
      filename = Base.encode16(:crypto.strong_rand_bytes(16), case: :lower) <> extension
      key = account_id <> "/" <> filename
      destination = Path.join(root(), key)

      name =
        entry.client_name
        |> Path.basename()
        |> String.replace(~r/[^\p{L}\p{N}._ -]/u, "_")
        |> String.slice(0, 120)

      with :ok <- File.mkdir_p(Path.dirname(destination)),
           :ok <- File.write(destination, content, [:binary, :exclusive]),
           :ok <- sync(destination) do
        {:ok, %{name: name, type: type, size: byte_size(content), storage_key: key}, destination}
      else
        _ ->
          File.rm(destination)
          {:error, :storage}
      end
    else
      _ -> {:error, :invalid_file}
    end
  end

  def attach(account_id, sid, task_id, expected_version, source, entry) do
    case store(account_id, source, entry) do
      {:ok, metadata, destination} ->
        case TestServer.Checklists.authorized_attach_task(
               account_id,
               sid,
               task_id,
               metadata,
               expected_version
             ) do
          {:ok, _task} ->
            {:ok, metadata}

          error ->
            File.rm(destination)
            error
        end

      error ->
        error
    end
  end

  defp sync(path) do
    case :file.open(String.to_charlist(path), [:read, :write, :binary]) do
      {:ok, file} ->
        result = :file.sync(file)
        :file.close(file)
        result

      error ->
        error
    end
  end

  defp content_type(".png", <<137, 80, 78, 71, 13, 10, 26, 10, _::binary>>),
    do: {:ok, "image/png"}

  defp content_type(".txt", content) do
    if String.valid?(content), do: {:ok, "text/plain"}, else: {:error, :invalid_file}
  end

  defp content_type(_, _), do: {:error, :invalid_file}
end
