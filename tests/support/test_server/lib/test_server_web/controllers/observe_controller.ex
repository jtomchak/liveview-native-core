defmodule TestServerWeb.ObserveController do
  use TestServerWeb, :controller
  # Local sample collector: OTP cache holds the most recent 20 sanitized OTLP summaries.
  # No EAS registration is implied by the local project namespace.
  def ingest(conn, %{"signal" => signal} = params) when signal in ["metrics", "logs", "traces"] do
    if Application.get_env(:test_server, :dev_routes, false) or
         Application.get_env(:test_server, :observe_local, false) do
      body = Map.drop(params, ["project", "signal"])

      if byte_size(Jason.encode!(body)) > 262_144 do
        send_resp(conn, 413, "")
      else
        key = {__MODULE__, signal}

        summary = %{
          received_at: System.system_time(:millisecond),
          bytes: byte_size(Jason.encode!(body)),
          signal: signal,
          samples: samples(body)
        }

        :global.trans({{__MODULE__, signal}, self()}, fn ->
          previous = Enum.filter(:persistent_term.get(key, []), &Map.has_key?(&1, :samples))
          :persistent_term.put(key, Enum.take([summary | previous], 20))
        end)

        json(conn, %{})
      end
    else
      send_resp(conn, 404, "")
    end
  end

  def ingest(conn, _), do: send_resp(conn, 404, "")

  # Retain only fixed event labels and numeric timing/count attributes.
  # Discard exception bodies, stack traces, identifiers and all other metadata.
  defp samples(body) do
    records =
      for resource <- Map.get(body, "resourceLogs", []),
          scope <- Map.get(resource, "scopeLogs", []),
          record <- Map.get(scope, "logRecords", []),
          do: record

    records
    |> Enum.take(200)
    |> Enum.flat_map(fn record ->
      attrs = Map.new(Map.get(record, "attributes", []), &{&1["key"], &1["value"]})
      name = get_in(attrs, ["event.name", "stringValue"])

      if name in ~w(lvn.connect.start lvn.connect.first_document lvn.document.received lvn.event.sent lvn.event.reply lvn.form.reply lvn.react.commit lvn.disconnect lvn.auth.login lvn.auth.form_post lvn.auth.logout lvn.auth.local_logout lvn.navigation lvn.navigation.request lvn.navigation.committed lvn.upload.progress lvn.upload.transferred lvn.upload.cancelled lvn.offline.cache_write lvn.offline.draft_read lvn.offline.draft_write lvn.command.reply lvn.offline.command_queued lvn.offline.command_reply lvn.offline.command_retry) do
        numeric =
          for key <- ~w(durationMs parseMs snapshotMs snapshotBytes callbackCount nodes records pending attempts delayMs),
              value = get_in(attrs, [key, "doubleValue"]),
              is_number(value),
              into: %{},
              do: {key, value}

        [%{name: name, measurements: numeric}]
      else
        []
      end
    end)
  end

  def summary(conn, _) do
    if Application.get_env(:test_server, :dev_routes, false) or
         Application.get_env(:test_server, :observe_local, false) do
      counts =
        Map.new(["metrics", "logs", "traces"], fn signal ->
          {signal, length(:persistent_term.get({__MODULE__, signal}, []))}
        end)

      json(conn, counts)
    else
      send_resp(conn, 404, "")
    end
  end
end
