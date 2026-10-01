defmodule TestServerWeb.ObserveControllerTest do
  use TestServerWeb.ConnCase, async: false

  test "local collector accepts bounded OTLP JSON and rejects oversized batches", %{conn: conn} do
    conn = conn |> put_req_header("content-type", "application/json")

    accepted =
      post(conn, "/observe/lvn-checklist-local/v1/logs", Jason.encode!(%{resourceLogs: []}))

    assert json_response(accepted, 200) == %{}
    assert json_response(get(build_conn(), "/observe/summary"), 200)["logs"] >= 1

    large =
      post(
        conn,
        "/observe/lvn-checklist-local/v1/logs",
        Jason.encode!(%{body: String.duplicate("x", 262_145)})
      )

    assert response(large, 413) == ""
    assert response(post(conn, "/observe/lvn-checklist-local/v1/other", "{}"), 404) == ""
  end

  test "collector drops record bodies, exception details and arbitrary attributes", %{conn: conn} do
    record = %{
      body: %{stringValue: "secret"},
      attributes: [
        %{key: "event.name", value: %{stringValue: "lvn.document.received"}},
        %{key: "parseMs", value: %{doubleValue: 2.5}},
        %{key: "password", value: %{stringValue: "secret"}}
      ]
    }

    body = %{resourceLogs: [%{scopeLogs: [%{logRecords: [record]}]}]}

    post(
      conn |> put_req_header("content-type", "application/json"),
      "/observe/lvn-checklist-local/v1/logs",
      Jason.encode!(body)
    )

    [summary | _] = :persistent_term.get({TestServerWeb.ObserveController, "logs"})

    assert summary.samples == [
             %{name: "lvn.document.received", measurements: %{"parseMs" => 2.5}}
           ]

    refute inspect(summary) =~ "secret"
  end

  test "collector retains fixed document kinds and byte/coalescing metrics", %{conn: conn} do
    records =
      for kind <- ["full", "patch", "status"] do
        %{
          attributes: [
            %{key: "event.name", value: %{stringValue: "lvn.document.received"}},
            %{key: "kind", value: %{stringValue: kind}},
            %{key: "patchBytes", value: %{doubleValue: 120}},
            %{key: "fullSnapshotBytes", value: %{doubleValue: 1000}},
            %{key: "bridgeBytes", value: %{doubleValue: 120}},
            %{key: "coalescedCallbacks", value: %{doubleValue: 4}}
          ]
        }
      end

    ingest_records(conn, records)
    [summary | _] = :persistent_term.get({TestServerWeb.ObserveController, "logs"})
    assert Enum.map(summary.samples, & &1.labels["kind"]) == ["full", "patch", "status"]

    for sample <- summary.samples do
      assert sample.measurements == %{
               "patchBytes" => 120,
               "fullSnapshotBytes" => 1000,
               "bridgeBytes" => 120,
               "coalescedCallbacks" => 4
             }
    end
  end

  test "collector accepts fixed resync labels while dropping arbitrary kinds and identifiers", %{
    conn: conn
  } do
    attrs = [
      %{key: "kind", value: %{stringValue: "private document content"}},
      %{key: "revision", value: %{doubleValue: 42}},
      %{key: "documentRevision", value: %{doubleValue: 8}},
      %{key: "documentGeneration", value: %{doubleValue: 3}},
      %{key: "sessionId", value: %{stringValue: "private-session-id"}},
      %{key: "operationId", value: %{stringValue: "private-operation-id"}},
      %{key: "accountId", value: %{doubleValue: 17}},
      %{key: "patchBytes", value: %{stringValue: "private-content"}}
    ]

    records =
      for name <- ["lvn.document.received", "lvn.document.resync", "lvn.document.private-content"] do
        %{
          body: %{stringValue: "private document body"},
          attributes: [%{key: "event.name", value: %{stringValue: name}} | attrs]
        }
      end

    ingest_records(conn, records)
    [summary | _] = :persistent_term.get({TestServerWeb.ObserveController, "logs"})

    assert summary.samples == [
             %{name: "lvn.document.received", measurements: %{}},
             %{name: "lvn.document.resync", measurements: %{}}
           ]

    refute inspect(summary) =~ "private"
    refute inspect(summary) =~ "revision"
    refute inspect(summary) =~ "accountId"
  end

  defp ingest_records(conn, records) do
    body = %{resourceLogs: [%{scopeLogs: [%{logRecords: records}]}]}

    conn
    |> put_req_header("content-type", "application/json")
    |> post("/observe/lvn-checklist-local/v1/logs", Jason.encode!(body))
    |> json_response(200)
  end
end
