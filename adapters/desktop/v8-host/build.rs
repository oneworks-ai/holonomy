use sha2::{Digest, Sha256};
fn main() {
    if std::env::var_os("CARGO_FEATURE_V86_BACKEND").is_some() {
        for (name, digest) in [
            (
                "assets/libv86.js",
                "730d3e4e4bd1d9c7ede4a4995f23da87261a723b3524da9a75c90e6e0610f46b",
            ),
            (
                "assets/v86.wasm",
                "8a969d64cf8f64b8183fdcc3a2ccdb31ae5ae6db7c9fba49949106f574640a7b",
            ),
            (
                "assets/v86-shim.js",
                "2eaf24d85ca70a4831ca2232d8eba84f484e594f1fe8deb14ee189827d7b1c6e",
            ),
            (
                "assets/v86-bootstrap.js",
                "b4679c31445119e16c0689b2423142e9795d8612e03f6d3af6dec6a7b2e2dfdf",
            ),
            (
                "assets/v86-network.js",
                "5e6ce7c30e75ad2c51f7166e01a14109a28d1dcd06f056cc2ad6da65f07f66de",
            ),
        ] {
            println!("cargo:rerun-if-changed={name}");
            let bytes = std::fs::read(name).expect("Missing pinned v86 build asset");
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                digest,
                "v86 build asset digest mismatch"
            );
        }
    }
    for name in [
        "runtime",
        "control",
        "plugin-validator",
        "module-planner",
        "v86-web-standards",
    ] {
        println!("cargo:rerun-if-changed=generated/{name}.js");
        println!("cargo:rerun-if-changed=generated/{name}.sha256");
        let bytes = std::fs::read(format!("generated/{name}.js"))
            .expect("Run node tools/build-native-runtime.mjs before cargo build");
        let expected = std::fs::read_to_string(format!("generated/{name}.sha256"))
            .expect("Missing Runtime asset digest");
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            expected.trim(),
            "Runtime asset digest mismatch"
        );
    }
}
