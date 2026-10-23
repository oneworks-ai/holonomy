use super::*;
use serde_json::json;

fn plan() -> Value {
    let entry = "import './dep.mjs'; export default () => {};";
    let dep = "export const value=1;";
    json!({"rootUrl":"holo-plugins:///test/", "entryUrl":"holo-plugins:///test/index.mjs", "modules":[
        {"url":"holo-plugins:///test/index.mjs", "format":"module", "source":entry,
        "sha256":format!("{:x}",Sha256::digest(entry.as_bytes())), "exportNames":["default"],
        "dependencies":[{"kind":"import","specifier":"./dep.mjs","resolvedUrl":"holo-plugins:///test/dep.mjs","interop":"module-namespace"}]},
        {"url":"holo-plugins:///test/dep.mjs", "format":"module", "source":dep,
        "sha256":format!("{:x}",Sha256::digest(dep.as_bytes())), "exportNames":["value"], "dependencies":[]}
    ]})
}

#[test]
fn all_definitions_and_edges_share_the_same_graph_version() {
    let digest = "a".repeat(64);
    let graph = prepare(&plan().to_string(), &digest).unwrap();
    assert!(graph.entry.ends_with(&digest));
    assert!(graph.definitions.keys().all(|url| url.ends_with(&digest)));
    let target = &graph.dependencies[&graph.entry]["./dep.mjs"];
    assert!(target.ends_with(&digest));
    assert_eq!(
        graph.definitions[&graph.entry]["dependencies"][0]["resolvedUrl"],
        *target
    );
    let second = prepare(&plan().to_string(), &"b".repeat(64)).unwrap();
    assert!(
        graph
            .definitions
            .keys()
            .all(|url| !second.definitions.contains_key(url))
    );
}

#[test]
fn malformed_complete_graphs_are_rejected_before_admission() {
    let base = plan();
    let mut duplicate = base.clone();
    duplicate["modules"]
        .as_array_mut()
        .unwrap()
        .push(base["modules"][0].clone());
    let mut outside = base.clone();
    outside["modules"][0]["dependencies"][0]["resolvedUrl"] =
        json!("holo-plugins:///other/dep.mjs");
    let mut tampered = base.clone();
    tampered["modules"][1]["source"] = json!("changed source without changing digest");
    let mut reserved = base.clone();
    reserved["modules"][1]["url"] = json!("holo-plugins:///test/dep.mjs?holo-bundle=forged");
    let mut missing = base.clone();
    missing["entryUrl"] = json!("holo-plugins:///test/missing.mjs");
    for invalid in [duplicate, outside, tampered, reserved, missing] {
        assert!(prepare(&invalid.to_string(), &"a".repeat(64)).is_err());
    }
}
