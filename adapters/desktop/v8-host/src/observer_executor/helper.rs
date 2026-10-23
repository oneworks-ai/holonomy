//! Same-binary child entry. A native reader exits the process on owner EOF,
//! even if the V8 thread is stuck in a synchronous loop or microtask drain.
use super::{event, vm::Session, wire};
use std::sync::mpsc;

fn exit(code: i32) -> ! {
    unsafe { libc::_exit(code) }
}

pub(super) fn entry() -> ! {
    let no_core = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &no_core) } != 0 {
        exit(2);
    }
    let (send, receive) = mpsc::sync_channel::<(u8, Vec<u8>)>(1);
    if std::thread::Builder::new()
        .name("observer-owner-eof".into())
        .spawn(move || {
            let mut input = std::io::stdin().lock();
            loop {
                let frame = wire::read_frame(&mut input).unwrap_or_else(|_| exit(2));
                if send.send(frame).is_err() {
                    exit(2);
                }
            }
        })
        .is_err()
    {
        exit(2);
    }
    let (kind, bytes) = receive.recv().unwrap_or_else(|_| exit(2));
    if kind != wire::INIT {
        exit(2);
    }
    let init: wire::InitRequest = serde_json::from_slice(&bytes).unwrap_or_else(|_| exit(2));
    let mut session = Session::new(&init).unwrap_or_else(|| exit(2));
    let mut output = std::io::stdout().lock();
    if wire::write_response(
        &mut output,
        wire::Response {
            kind: wire::READY,
            epoch: init.epoch,
            sequence: 0,
            nonce: init.nonce,
            failed: false,
            published: false,
        },
    )
    .is_err()
    {
        exit(2);
    }
    let mut previous_sequence = 0_u64;
    loop {
        let (kind, bytes) = receive.recv().unwrap_or_else(|_| exit(2));
        if kind != wire::CALL {
            exit(2);
        }
        let call: wire::CallRequest = serde_json::from_slice(&bytes).unwrap_or_else(|_| exit(2));
        if call.epoch != init.epoch
            || call.nonce != init.nonce
            || call.sequence <= previous_sequence
            || event::validate(&call.event).is_none()
        {
            exit(2);
        }
        previous_sequence = call.sequence;
        let started = wire::Response {
            kind: wire::STARTED,
            epoch: init.epoch,
            sequence: call.sequence,
            nonce: init.nonce,
            failed: false,
            published: false,
        };
        let (failed, published) = session.call(&call.event, || {
            wire::write_response(&mut output, started).is_ok()
        });
        if wire::write_response(
            &mut output,
            wire::Response {
                kind: wire::COMPLETED,
                epoch: init.epoch,
                sequence: call.sequence,
                nonce: init.nonce,
                failed,
                published,
            },
        )
        .is_err()
        {
            exit(2);
        }
    }
}
