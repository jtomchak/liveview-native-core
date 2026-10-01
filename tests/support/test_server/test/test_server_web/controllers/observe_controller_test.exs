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
end
