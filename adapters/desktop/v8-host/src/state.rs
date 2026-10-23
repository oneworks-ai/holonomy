use holonomy_desktop_host::SourceStore;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Instant,
};

pub type SharedState = Rc<RefCell<HostState>>;
#[derive(Clone)]
pub struct GuestScriptOrigin {
    pub url: String,
    pub line_correction: usize,
}

pub struct HostState {
    pub crypto: holonomy_desktop_host::crypto::NativeCrypto,
    pub control: Option<crate::control::ControlState>,
    pub remote: Option<crate::control::RemoteControl>,
    pub engine_gate: crate::engine_gate::EngineGate,
    pub inspector: Option<crate::inspector::InspectorRuntime>,
    pub wasm_work: crate::wasm::PendingWasmWork,
    pub sources: Option<SourceStore>,
    pub configuration: String,
    pub start: Instant,
    pub wakeup: Option<f64>,
    pub exit_code: Option<i32>,
    pub closing: bool,
    pub controller: Option<v8::Global<v8::Object>>,
    pub planner: Option<crate::module_planner::ModulePlanner>,
    pub modules: HashMap<String, v8::Global<v8::Module>>,
    pub dependencies: HashMap<String, HashMap<String, String>>,
    pub definitions: HashMap<String, serde_json::Value>,
    /// Host-admitted URLs keyed by V8's per-isolate script IDs. Diagnostic only.
    pub guest_script_origins: HashMap<usize, GuestScriptOrigin>,
    pub last_guest_script_id: i32,
    pub guest_script_origins_disabled: bool,
    pub plugin_graphs: HashMap<String, crate::plugin_graph::PluginGraph>,
    pub plugin_members: HashMap<String, String>,
    pub import_owners: HashMap<String, v8::Global<v8::PrimitiveArray>>,
    pub imports: Vec<PendingImport>,
    pub import_count: Rc<Cell<usize>>,
    pub observer_execution_sequence: u64,
    pub commonjs: HashMap<String, v8::Global<v8::Object>>,
    pub unhandled: Vec<(v8::Global<v8::Promise>, v8::Global<v8::Value>)>,
}

impl HostState {
    pub fn new(sources: Option<SourceStore>, configuration: String, start: Instant) -> Self {
        Self {
            crypto: holonomy_desktop_host::crypto::NativeCrypto::default(),
            control: None,
            remote: None,
            engine_gate: crate::engine_gate::EngineGate::new(),
            inspector: None,
            wasm_work: crate::wasm::PendingWasmWork::default(),
            sources,
            configuration,
            start,
            wakeup: None,
            exit_code: None,
            closing: false,
            controller: None,
            planner: None,
            modules: HashMap::new(),
            dependencies: HashMap::new(),
            definitions: HashMap::new(),
            guest_script_origins: HashMap::new(),
            last_guest_script_id: 0,
            guest_script_origins_disabled: false,
            plugin_graphs: HashMap::new(),
            plugin_members: HashMap::new(),
            import_owners: HashMap::new(),
            imports: Vec::new(),
            import_count: Rc::new(Cell::new(0)),
            observer_execution_sequence: 0,
            commonjs: HashMap::new(),
            unhandled: Vec::new(),
        }
    }
}

pub struct PendingImport {
    pub _lease: ImportLease,
    pub module_gate: Option<crate::control::ModuleGateDecision>,
    pub approved: bool,
    pub context: v8::Global<v8::Context>,
    pub plugin_graph: Option<String>,
    pub resolver: v8::Global<v8::PromiseResolver>,
    pub planning: Option<v8::Global<v8::Promise>>,
    pub evaluation: Option<v8::Global<v8::Promise>>,
    pub execution: Option<crate::observer::Execution>,
    pub module: Option<v8::Global<v8::Module>>,
}

pub struct ImportLease(Rc<Cell<usize>>);
impl ImportLease {
    pub fn acquire(count: &Rc<Cell<usize>>) -> Option<Self> {
        if count.get() >= 128 {
            return None;
        }
        count.set(count.get() + 1);
        Some(Self(count.clone()))
    }
}
impl Drop for ImportLease {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

pub fn state(scope: &v8::PinScope) -> SharedState {
    scope
        .get_slot::<SharedState>()
        .expect("Host state installed before entry")
        .clone()
}

pub fn property<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    object: v8::Local<v8::Object>,
    name: &str,
) -> Option<v8::Local<'s, v8::Value>> {
    let name = v8::String::new(scope, name)?;
    object.get(scope, name.into())
}

pub fn call<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    object: v8::Local<v8::Object>,
    name: &str,
    args: &[v8::Local<v8::Value>],
) -> Option<v8::Local<'s, v8::Value>> {
    let method = v8::Local::<v8::Function>::try_from(property(scope, object, name)?).ok()?;
    method.call(scope, object.into(), args)
}

pub fn error<'s>(scope: &mut v8::PinScope<'s, '_>, message: &str) -> v8::Local<'s, v8::Value> {
    let text = v8::String::new(scope, message).unwrap();
    v8::Exception::error(scope, text)
}
