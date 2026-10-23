use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-cjs-metadata-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn run(&self, entry: &str, source: &str) {
        fs::write(self.0.join(entry), source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(["--timeout", "3000", entry])
            .current_dir(&self.0)
            .env_clear()
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("CJS_METADATA_OK"));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn commonjs_entry_guard_resolve_cache_and_loaded_state_use_virtual_identities() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("child.cjs"), "globalThis.childExecutions=(globalThis.childExecutions??0)+1; module.exports={id:module.id,filename:module.filename,main:require.main,initiallyLoaded:module.loaded,loaded:()=>module.loaded};").unwrap();
    fixture.run(
        "index.js",
        r#"
        const assert=require('node:assert/strict');
        assert.equal(require.main,module); assert.equal(module.id,'.');
        assert.equal(module.filename,__filename); assert.equal(module.loaded,false);
        assert.equal(require.resolve('node:path'),'node:path');
        assert.equal(require.resolve('./child.cjs'),'app://workspace/child.cjs');
        assert.equal(globalThis.childExecutions,undefined);
        const child=require('./child.cjs'); assert.equal(child.main,module);
        assert.equal(child.id,'app://workspace/child.cjs'); assert.equal(child.filename,child.id);
        assert.equal(child.initiallyLoaded,false); assert.equal(child.loaded(),true);
        assert.equal(require('./child.cjs'),child); assert.equal(globalThis.childExecutions,1);
        if(require.main===module) console.log('CJS_METADATA_OK');
    "#,
    );
}
#[test]
fn commonjs_imported_by_esm_has_no_main_and_require_never_coerces_objects() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("child.cjs"), r#"
        const assert=require('node:assert/strict'); const path=require('node:path'); const alias=require;
        assert.equal(require.main,undefined); let coerced=0;
        const fake={toString(){coerced++;return 'node:path'}};
        assert.throws(()=>alias(fake),{code:'ERR_INVALID_ARG_TYPE'});
        assert.throws(()=>alias.resolve(fake),{code:'ERR_INVALID_ARG_TYPE'});
        assert.equal(coerced,0); module.exports={loaded:()=>module.loaded};
    "#).unwrap();
    fixture.run("index.mjs", "import assert from 'node:assert/strict'; import child from './child.cjs'; assert.equal(child.loaded(),true); console.log('CJS_METADATA_OK');");
}

#[test]
fn conditional_package_require_and_import_remain_distinct_in_one_commonjs_parent() {
    let fixture = Fixture::new();
    let package = fixture.0.join("node_modules/dual");
    fs::create_dir_all(&package).unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"exports":{"import":"./import.mjs","require":"./require.cjs"}}"#,
    )
    .unwrap();
    fs::write(package.join("import.mjs"), "export const mode='import';").unwrap();
    fs::write(package.join("require.cjs"), "exports.mode='require';").unwrap();
    fixture.run(
        "index.js",
        r#"
        const assert=require('node:assert/strict');
        const value=require('dual'); assert.equal(value.mode,'require');
        assert.equal(require.resolve('dual'),'app://workspace/node_modules/dual/require.cjs');
        import('dual').then(namespace=>{
            assert.equal(namespace.mode,'import'); assert.equal(require('dual'),value);
            console.log('CJS_METADATA_OK');
        });
    "#,
    );
}

#[test]
fn failed_bodies_retry_but_loaded_exports_getters_do_not_rerun_module_bodies() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("body.cjs"),
        "globalThis.bodyRuns=(globalThis.bodyRuns??0)+1;throw new Error('body failed');",
    )
    .unwrap();
    fs::write(fixture.0.join("getter.cjs"), "globalThis.getterRuns=(globalThis.getterRuns??0)+1;Object.defineProperty(module,'exports',{get(){throw new Error('exports blocked')}});").unwrap();
    fixture.run(
        "index.js",
        r#"
        const assert=require('node:assert/strict');
        assert.throws(()=>require('./body.cjs')); assert.throws(()=>require('./body.cjs'));
        assert.equal(globalThis.bodyRuns,2);
        assert.throws(()=>require('./getter.cjs')); assert.throws(()=>require('./getter.cjs'));
        assert.equal(globalThis.getterRuns,1); console.log('CJS_METADATA_OK');
    "#,
    );
}

#[test]
fn resolve_only_edges_do_not_silently_become_executable_alias_loads() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("resolve-only.cjs"),
        "globalThis.resolveOnlyRan=true;module.exports=42;",
    )
    .unwrap();
    fixture.run("index.js", r#"
        const assert=require('node:assert/strict'); const alias=require;
        assert.equal(require.resolve('./resolve-only.cjs'),'app://workspace/resolve-only.cjs');
        assert.throws(()=>alias('./resolve-only.cjs'),{code:'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED'});
        assert.equal(globalThis.resolveOnlyRan,undefined); console.log('CJS_METADATA_OK');
    "#);
}
