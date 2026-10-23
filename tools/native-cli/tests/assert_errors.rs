use std::{fs, process::Command};

#[test]
fn node_free_assertions_validate_errors_collections_and_native_promise_brand() {
    let root = std::env::temp_dir().join(format!("holo-assert-errors-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let source = r#"
        import assert from 'node:assert/strict';
        const error = Object.assign(new TypeError('boom'), {code:'ACTUAL'});
        const wrong = [];
        try { assert.throws(() => {throw error}, {code:'WRONG'}); }
        catch (error) { wrong.push(error.code); }
        try { await assert.rejects(Promise.reject(error), {code:'WRONG'}); }
        catch (error) { wrong.push(error.code); }
        for (const [actual, expected] of [[new Date(0),new Date(1)],[/a/,/b/],
          [new Map([['a',1]]),new Map([['a',2]])],[new Set([1]),new Set([2])]]) {
          try { assert.throws(() => {throw {detail:actual}}, {detail:expected}); }
          catch (error) { wrong.push(error.code); }
        }
        assert.deepEqual(wrong, new Array(6).fill('ERR_ASSERTION'));
        let getterCalls = 0;
        const fake = Object.create(Promise.prototype, {then:{get(){getterCalls++;return (_r,j)=>j(error)}}});
        await assert.rejects(async () => {await assert.rejects(fake)}, {code:'ERR_INVALID_ARG_TYPE'});
        assert.equal(getterCalls, 0);
        const pending = Promise.reject(error);
        let constructorCalls = 0;
        Object.defineProperty(pending,'constructor',{get(){constructorCalls++;return Promise}});
        await assert.rejects(pending,{code:'ACTUAL'});
        assert.equal(constructorCalls,1);
        assert.equal(assert.throws(()=>{throw error},{code:'ACTUAL'}),undefined);
        console.log('NATIVE_ASSERT_ERRORS_OK');
    "#;
    fs::write(root.join("index.mjs"), source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args(["--timeout", "3000", "index.mjs"])
        .current_dir(&root)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    let _ = fs::remove_dir_all(&root);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"NATIVE_ASSERT_ERRORS_OK\n");
}
