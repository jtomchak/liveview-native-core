use std::{
    fmt,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

pub use super::{
    attribute::Attribute,
    node::{Node, NodeData, NodeRef},
    printer::PrintOptions,
};
use crate::{
    callbacks::*,
    diff::{fragment::RenderError, PatchResult},
    dom::parser::ParseError,
};

static NEXT_DOCUMENT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, uniffi::Object)]
pub struct Document {
    identity: u64,
    inner: Arc<Mutex<super::Document>>,
}

impl From<super::Document> for Document {
    fn from(doc: super::Document) -> Self {
        Self {
            identity: NEXT_DOCUMENT_ID.fetch_add(1, Ordering::Relaxed),
            inner: Arc::new(Mutex::new(doc)),
        }
    }
}

// crate local api
impl Document {
    #[cfg(feature = "liveview-channels")]
    pub(crate) fn inner(&self) -> Arc<Mutex<super::Document>> {
        self.inner.clone()
    }

    pub fn arc_set_event_handler(&self, handler: Arc<dyn DocumentChangeHandler>) {
        self.inner.lock().expect("lock poisoned!").event_callback = Some(handler);
    }

    #[cfg(feature = "liveview-channels")]
    pub fn merge_deserialized_fragment_json(
        &self,
        json: phoenix_channels_client::JSON,
    ) -> Result<(), RenderError> {
        let results = self
            .inner
            .lock()
            .expect("lock poisoned!")
            .merge_fragment_json(json.into())?;

        let Some(handler) = self
            .inner
            .lock()
            .expect("lock poisoned")
            .event_callback
            .clone()
        else {
            return Ok(());
        };

        for patch in results.into_iter() {
            match patch {
                PatchResult::Add { node, parent, data } => {
                    handler.handle_document_change(
                        ChangeType::Add,
                        node.into(),
                        data,
                        Some(parent.into()),
                    );
                }
                PatchResult::Remove { node, parent, data } => {
                    handler.handle_document_change(
                        ChangeType::Remove,
                        node.into(),
                        data,
                        Some(parent.into()),
                    );
                }
                PatchResult::Change { node, data } => {
                    handler.handle_document_change(ChangeType::Change, node.into(), data, None);
                }
                PatchResult::Replace { node, parent, data } => {
                    handler.handle_document_change(
                        ChangeType::Replace,
                        node.into(),
                        data,
                        Some(parent.into()),
                    );
                }
            }
        }

        Ok(())
    }
}

#[uniffi::export]
impl Document {
    /// Stable across UniFFI wrappers/clones; changes only for a new logical document.
    pub fn identity(&self) -> u64 {
        self.identity
    }

    #[uniffi::constructor]
    pub fn parse(input: String) -> Result<Arc<Self>, ParseError> {
        Ok(Arc::new(Self {
            identity: NEXT_DOCUMENT_ID.fetch_add(1, Ordering::Relaxed),
            inner: Arc::new(Mutex::new(super::Document::parse(input)?)),
        }))
    }

    #[uniffi::constructor]
    pub fn empty() -> Arc<Self> {
        Arc::new(Self {
            identity: NEXT_DOCUMENT_ID.fetch_add(1, Ordering::Relaxed),
            inner: Arc::new(Mutex::new(super::Document::empty())),
        })
    }

    #[uniffi::constructor]
    pub fn parse_fragment_json(input: String) -> Result<Arc<Self>, RenderError> {
        let inner = Arc::new(Mutex::new(super::Document::parse_fragment_json(input)?));
        Ok(Arc::new(Self {
            identity: NEXT_DOCUMENT_ID.fetch_add(1, Ordering::Relaxed),
            inner,
        }))
    }

    pub fn set_event_handler(&self, handler: Box<dyn DocumentChangeHandler>) {
        self.inner.lock().expect("lock poisoned!").event_callback = Some(Arc::from(handler));
    }

    pub fn merge_fragment_json(&self, json: &str) -> Result<(), RenderError> {
        let json = serde_json::from_str(json)?;

        let results = self
            .inner
            .lock()
            .expect("lock poisoned!")
            .merge_fragment_json(json)?;

        let Some(handler) = self
            .inner
            .lock()
            .expect("lock poisoned")
            .event_callback
            .clone()
        else {
            return Ok(());
        };

        for patch in results.into_iter() {
            match patch {
                PatchResult::Add { node, parent, data } => {
                    handler.handle_document_change(
                        ChangeType::Add,
                        node.into(),
                        data,
                        Some(parent.into()),
                    );
                }
                PatchResult::Remove { node, parent, data } => {
                    handler.handle_document_change(
                        ChangeType::Remove,
                        node.into(),
                        data,
                        Some(parent.into()),
                    );
                }
                PatchResult::Change { node, data } => {
                    handler.handle_document_change(ChangeType::Change, node.into(), data, None);
                }
                PatchResult::Replace { node, parent, data } => {
                    handler.handle_document_change(
                        ChangeType::Replace,
                        node.into(),
                        data,
                        Some(parent.into()),
                    );
                }
            }
        }

        Ok(())
    }

    pub fn next_upload_id(&self) -> u64 {
        self.inner.lock().expect("lock poisoned!").next_upload_id()
    }

    pub fn root(&self) -> Arc<NodeRef> {
        self.inner.lock().expect("lock poisoned!").root().into()
    }

    pub fn get_parent(&self, node_ref: Arc<NodeRef>) -> Option<Arc<NodeRef>> {
        self.inner
            .lock()
            .expect("lock poisoned!")
            .parent(*node_ref)
            .map(|node_ref| node_ref.into())
    }

    pub fn children(&self, node_ref: Arc<NodeRef>) -> Vec<Arc<NodeRef>> {
        self.inner
            .lock()
            .expect("lock poisoned!")
            .children(*node_ref)
            .iter()
            .map(|node| Arc::new(*node))
            .collect()
    }

    pub fn get_attributes(&self, node_ref: Arc<NodeRef>) -> Vec<Attribute> {
        self.inner
            .lock()
            .expect("lock poisoned!")
            .attributes(*node_ref)
            .to_vec()
    }

    pub fn get(&self, node_ref: Arc<NodeRef>) -> NodeData {
        self.inner
            .lock()
            .expect("lock poisoned!")
            .get(*node_ref)
            .clone()
    }

    pub fn get_node(&self, node_ref: Arc<NodeRef>) -> Node {
        let data = self.get(node_ref.clone());
        Node::new(self, &node_ref.clone(), data)
    }

    pub fn render(&self) -> String {
        self.to_string()
    }

    /// A coherent, normalized document for host renderers such as React Native.
    ///
    /// All nodes are read under one lock; IDs are scoped to this document. A flat
    /// table avoids recursive native traversal and retains child ordering.
    pub fn snapshot_json(&self) -> String {
        let document = self.inner.lock().expect("lock poisoned!");
        let root = document.root();
        let mut pending = vec![root];
        let mut nodes = Vec::new();
        while let Some(id) = pending.pop() {
            let children = document.children(id);
            let child_ids: Vec<u32> = children.iter().map(|child| child.0).collect();
            pending.extend(children.iter().rev().copied());
            let node = match document.get(id) {
                NodeData::Root => serde_json::json!({
                    "id": id.0, "kind": "root", "children": child_ids
                }),
                NodeData::NodeElement { element } => {
                    let attributes: serde_json::Map<String, serde_json::Value> = document
                        .attributes(id)
                        .iter()
                        .map(|attribute| {
                            (
                                attribute.name.to_string(),
                                serde_json::json!(attribute.value),
                            )
                        })
                        .collect();
                    serde_json::json!({
                        "id": id.0, "kind": "element", "tag": element.name.to_string(),
                        "attributes": attributes, "children": child_ids
                    })
                }
                NodeData::Leaf { value } => serde_json::json!({
                    "id": id.0, "kind": "text", "text": value, "children": []
                }),
            };
            nodes.push(node);
        }
        serde_json::json!({ "root": root.0, "nodes": nodes }).to_string()
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::Document;

    #[test]
    fn react_native_document_identity_survives_clones_and_changes_for_replacement() {
        let first = Document::parse("<Text>First</Text>".into()).unwrap();
        let clone = first.as_ref().clone();
        let second = Document::parse("<Text>Second</Text>".into()).unwrap();
        assert_eq!(first.identity(), clone.identity());
        assert_ne!(first.identity(), second.identity());
    }

    #[test]
    fn react_native_snapshot_preserves_tags_attributes_and_order() {
        let document = Document::parse(
            "<View id=\"card\"><Text>A &amp; B</Text><Pressable phx-click=\"increment\" disabled /></View>".into()
        ).unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&document.snapshot_json()).unwrap();
        let nodes = snapshot["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 5);
        assert_eq!(nodes[0]["id"], snapshot["root"]);
        assert_eq!(nodes[1]["tag"], "View");
        assert_eq!(nodes[1]["attributes"]["id"], "card");
        assert_eq!(nodes[2]["tag"], "Text");
        assert_eq!(nodes[3]["text"], "A & B");
        assert_eq!(nodes[4]["attributes"]["phx-click"], "increment");
        assert_eq!(nodes[4]["attributes"]["disabled"], "");
        assert_eq!(
            nodes[1]["children"],
            serde_json::json!([nodes[2]["id"], nodes[4]["id"]])
        );
    }

    #[test]
    fn react_native_snapshot_reflects_liveview_fragment_merge() {
        let document =
            Document::parse_fragment_json(r#"{"s":["<Text>","</Text>"],"0":"0"}"#.into()).unwrap();
        document.merge_fragment_json(r#"{"0":"1"}"#).unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&document.snapshot_json()).unwrap();
        assert!(snapshot["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["text"] == "1"));
    }
}
impl Document {
    pub fn print_node(
        &self,
        node: NodeRef,
        writer: &mut dyn std::fmt::Write,
        options: PrintOptions,
    ) -> fmt::Result {
        self.inner
            .lock()
            .map_err(|_| fmt::Error)?
            .print_node(node, writer, options)
    }
}

impl fmt::Display for Document {
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        self.inner
            .lock()
            .map_err(|_| fmt::Error)?
            .print(f, PrintOptions::Pretty)
    }
}
