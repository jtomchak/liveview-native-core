use std::time::Duration;

use phoenix_channels_client::Payload;
use serde_json::{json, Value};

use crate::client::{ClientConnectOpts, LiveViewClientBuilder, Platform};

fn text_at(snapshot: &Value, element_id: &str) -> String {
    let nodes = snapshot["nodes"].as_array().unwrap();
    let element = nodes
        .iter()
        .find(|node| node["attributes"]["id"] == element_id)
        .unwrap();
    element["children"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|id| nodes.iter().find(|node| node["id"] == *id)?["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string()
}

#[tokio::test]
#[ignore = "requires tests/support/test_server running on port 4001"]
async fn react_native_counter_round_trip() {
    let builder = LiveViewClientBuilder::new();
    builder.set_format(Platform::ReactNative);
    assert_eq!(builder.format().to_string(), "react_native");
    assert!(matches!(
        Platform::from("react_native".to_string()),
        Platform::ReactNative
    ));
    let client = builder
        .connect(
            "http://127.0.0.1:4001/react_native".into(),
            ClientConnectOpts::default(),
        )
        .await
        .expect("React Native LiveView connection failed");
    let document = client.document().unwrap();
    let snapshot: Value = serde_json::from_str(&document.snapshot_json()).unwrap();
    assert_eq!(text_at(&snapshot, "count"), "0");
    let initial_heartbeat = text_at(&snapshot, "heartbeat");
    for (event, expected) in [
        ("increment", "1"),
        ("decrement", "0"),
        ("increment", "1"),
        ("reset", "0"),
    ] {
        client
            .call(
                "event".into(),
                Payload::JSONPayload {
                    json: json!({ "type": "click", "event": event, "value": {} }).into(),
                },
            )
            .await
            .unwrap();
        let snapshot: Value = serde_json::from_str(&document.snapshot_json()).unwrap();
        assert_eq!(text_at(&snapshot, "count"), expected);
    }
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let snapshot: Value = serde_json::from_str(&document.snapshot_json()).unwrap();
            if text_at(&snapshot, "heartbeat") != initial_heartbeat {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("server did not push an unsolicited heartbeat diff");
    client.shutdown();
}
