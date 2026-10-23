use super::{guest_sync::invoke, state::Subscription};
use crate::state::{error, state};
pub fn subscribe(
    scope: &mut v8::PinScope,
    binding: &str,
    callback: v8::Local<v8::Function>,
) -> Option<String> {
    if binding.len() > 128
        || state(scope)
            .borrow()
            .remote
            .as_ref()?
            .guest
            .subscriptions
            .len()
            >= 256
    {
        let e = error(scope, "Native resource subscription limit");
        scope.throw_exception(e);
        return None;
    }
    let id = invoke(scope, "subscribe", &[binding.into()])?;
    let context = scope.get_current_context();
    state(scope)
        .borrow_mut()
        .remote
        .as_mut()?
        .guest
        .subscriptions
        .insert(
            id.clone(),
            Subscription {
                callback: v8::Global::new(scope, callback),
                context: v8::Global::new(scope, context),
            },
        );
    Some(id)
}
pub fn unsubscribe(scope: &mut v8::PinScope, id: &str) -> Option<()> {
    state(scope)
        .borrow_mut()
        .remote
        .as_mut()?
        .guest
        .subscriptions
        .remove(id);
    invoke(scope, "unsubscribe", &[id.into()])?;
    Some(())
}
pub(super) fn deliver_events(scope: &mut v8::PinScope) -> Option<bool> {
    let json = invoke(scope, "drainResourceEvents", &[])?;
    let events: serde_json::Value = serde_json::from_str(&json).ok()?;
    state(scope)
        .borrow_mut()
        .remote
        .as_mut()?
        .guest
        .events_pending = events["remaining"].as_u64()? > 0;
    let events = events["events"].as_array()?;
    for event in events {
        let id = event["subscriptionId"].as_str()?;
        let subscription = {
            let shared = state(scope);
            let state = shared.borrow();
            state
                .remote
                .as_ref()?
                .guest
                .subscriptions
                .get(id)
                .map(|s| (s.context.clone(), s.callback.clone()))
        };
        let Some((context, callback)) = subscription else {
            continue;
        };
        let context = v8::Local::new(scope, context);
        let scope = &mut v8::ContextScope::new(scope, context);
        let callback = v8::Local::new(scope, callback);
        let message = v8::String::new(scope, event["event"].as_str()?)?;
        let receiver = v8::undefined(scope);
        callback.call(scope, receiver.into(), &[message.into()])?;
    }
    Some(!events.is_empty())
}
