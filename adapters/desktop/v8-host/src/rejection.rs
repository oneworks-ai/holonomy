use crate::state::state;

pub extern "C" fn callback(message: v8::PromiseRejectMessage) {
    // V8 invokes this on its owned thread with valid callback handles.
    v8::callback_scope!(unsafe scope, &message);
    let shared = state(scope);
    let promise = message.get_promise();
    match message.get_event() {
        v8::PromiseRejectEvent::PromiseRejectWithNoHandler => {
            if let Some(value) = message.get_value() {
                if shared.borrow().unhandled.len() >= 1024 {
                    scope.terminate_execution();
                    return;
                }
                shared.borrow_mut().unhandled.push((
                    v8::Global::new(scope, promise),
                    v8::Global::new(scope, value),
                ));
            }
        }
        v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => forget(scope, promise),
        _ => {}
    }
}

pub fn handle(scope: &v8::PinScope, promise: v8::Local<v8::Promise>) {
    promise.mark_as_handled();
    forget(scope, promise);
}

fn forget(scope: &v8::PinScope, promise: v8::Local<v8::Promise>) {
    state(scope)
        .borrow_mut()
        .unhandled
        .retain(|(candidate, _)| v8::Local::new(scope, candidate) != promise);
}

pub fn check(scope: &mut v8::PinScope) -> Option<()> {
    let rejection = state(scope)
        .borrow()
        .unhandled
        .first()
        .map(|(_, value)| value.clone());
    if let Some(rejection) = rejection {
        let rejection = v8::Local::new(scope, rejection);
        scope.throw_exception(rejection);
        None
    } else {
        Some(())
    }
}
