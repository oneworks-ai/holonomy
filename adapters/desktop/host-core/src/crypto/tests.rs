use super::*;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|value| format!("{value:02x}")).collect()
}

#[test]
fn hashes_and_hmac_match_standard_vectors_and_do_not_reuse_ids() {
    let mut crypto = NativeCrypto::default();
    for (kind, expected) in [
        (0, "a9993e364706816aba3e25717850c26c9cd0d89d"),
        (
            1,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        ),
    ] {
        let id = crypto.create(kind, &[], &[]).unwrap();
        crypto.update(id, b"a").unwrap();
        crypto.update(id, b"bc").unwrap();
        assert_eq!(hex(&crypto.digest(id).unwrap()), expected);
        assert!(crypto.digest(id).is_err());
        crypto.dispose_context(id);
    }
    let id = crypto.create(2, &[0x0b; 20], &[]).unwrap();
    assert_eq!(id, 3);
    crypto.update(id, b"Hi There").unwrap();
    assert_eq!(
        hex(&crypto.digest(id).unwrap()),
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );
    assert_eq!(crypto.retained, 0);
}

#[test]
fn aes_gcm_vector_and_authentication_failure_never_release_plaintext() {
    let mut crypto = NativeCrypto::default();
    let id = crypto.create(3, &[0; 32], &[0; 12]).unwrap();
    crypto.update(id, &[0; 16]).unwrap();
    let encrypted = crypto.final_context(id).unwrap();
    assert_eq!(hex(&encrypted.output), "cea7403d4d606b6e074ec5d3baf39d18");
    assert_eq!(
        hex(encrypted.auth_tag.as_ref().unwrap()),
        "d0d1c8a799996bf0265b98b5d48ab919"
    );
    for valid in [true, false] {
        let id = crypto.create(4, &[0; 32], &[0; 12]).unwrap();
        crypto.update(id, &encrypted.output).unwrap();
        let mut tag = encrypted.auth_tag.as_ref().unwrap().clone();
        if !valid {
            tag[0] ^= 1;
        }
        crypto.set_auth_tag(id, &tag).unwrap();
        let result = crypto.final_context(id).unwrap();
        assert_eq!(result.authenticated, Some(valid));
        assert_eq!(
            result.output.as_slice(),
            if valid { &[0; 16][..] } else { &[] }
        );
        assert!(crypto.final_context(id).is_err());
    }
    assert_eq!(crypto.retained, 0);
}

#[test]
fn aad_order_tag_once_and_empty_update_are_stateful() {
    let mut crypto = NativeCrypto::default();
    let id = crypto.create(3, &[1; 32], &[2; 12]).unwrap();
    crypto.set_aad(id, b"a").unwrap();
    crypto.set_aad(id, b"bc").unwrap();
    crypto.update(id, &[]).unwrap();
    assert!(crypto.set_aad(id, b"late").is_err());
    assert!(crypto.set_auth_tag(id, &[0; 16]).is_err());
    let encrypted = crypto.final_context(id).unwrap();
    let id = crypto.create(4, &[1; 32], &[2; 12]).unwrap();
    crypto.set_aad(id, b"abc").unwrap();
    crypto
        .set_auth_tag(id, encrypted.auth_tag.as_ref().unwrap())
        .unwrap();
    assert!(crypto.set_auth_tag(id, &[0; 16]).is_err());
    assert_eq!(crypto.final_context(id).unwrap().authenticated, Some(true));
    let id = crypto.create(4, &[1; 32], &[2; 12]).unwrap();
    assert!(crypto.final_context(id).is_err());
    assert_eq!(crypto.retained, 0);
}

#[test]
fn bounded_admission_and_dispose_release_all_contexts() {
    let mut crypto = NativeCrypto::default();
    assert!(crypto.create(5, &[], &[]).is_err());
    assert!(crypto.create(0, &[1], &[]).is_err());
    assert!(crypto.create(3, &[0; 31], &[0; 12]).is_err());
    assert!(crypto.create(3, &[0; 32], &[0; 11]).is_err());
    assert!(crypto.create(2, &vec![0; MAX_KEY + 1], &[]).is_err());
    let first = crypto.create(3, &[0; 32], &[0; 12]).unwrap();
    for _ in 1..MAX_CONTEXTS {
        crypto.create(1, &[], &[]).unwrap();
    }
    assert!(crypto.create(1, &[], &[]).is_err());
    assert!(crypto.update(first, &vec![0; MAX_UPDATE + 1]).is_err());
    crypto.set_aad(first, &vec![0; MAX_AAD]).unwrap();
    assert!(crypto.set_aad(first, &[0]).is_err());
    crypto.dispose_context(first);
    assert!(crypto.create(1, &[], &[]).unwrap() > first);
    crypto.dispose();
    crypto.dispose();
    assert!(crypto.contexts.is_empty());
    assert_eq!(crypto.retained, 0);
    assert!(crypto.random(0).is_err());
    assert!(crypto.create(1, &[], &[]).is_err());
}

#[test]
fn random_compare_and_accounting_boundaries_are_checked() {
    let mut crypto = NativeCrypto::default();
    assert_eq!(crypto.random(0).unwrap().len(), 0);
    assert_eq!(crypto.random(MAX_RANDOM).unwrap().len(), MAX_RANDOM);
    assert!(crypto.random(MAX_RANDOM + 1).is_err());
    assert!(crypto.equal(b"same", b"same").unwrap());
    assert!(!crypto.equal(b"same", b"samo").unwrap());
    assert!(crypto.equal(&[], &[]).unwrap());
    assert!(crypto.equal(b"a", b"ab").is_err());
    assert!(
        crypto
            .equal(&vec![0; MAX_COMPARE + 1], &vec![0; MAX_COMPARE + 1])
            .is_err()
    );
    let id = crypto.create(1, &[], &[]).unwrap();
    // Counter boundary probes avoid allocating 128 MiB just to test overflow.
    crypto.contexts.get_mut(&id).unwrap().data_bytes = MAX_DATA;
    assert!(crypto.update(id, &[0]).is_err());
    crypto.retained = MAX_TOTAL;
    assert!(crypto.random(1).is_err());
    assert!(crypto.equal(&[0], &[0]).is_err());
    assert!(crypto.create(2, &[0], &[]).is_err());
    assert!(crypto.reserve(id, 1).is_err());
    assert_eq!(crypto.retained, MAX_TOTAL);
}
