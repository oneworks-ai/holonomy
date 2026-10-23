# Capability Runtime machine contracts

This directory is the machine-readable owner for RFC-0001 contracts. It owns
strict SandboxPolicy parsing, canonical JSON/digests, closed operation and
capability registries, and shared cross-platform vectors.

- Keep this layer platform-neutral and free of Node, Android, Service, UI, and
  Provider implementations.
- Missing or unknown policy fields fail closed. Normalization may sort declared
  sets, but it must never widen authority.
- Service compiles these contracts; Runtime Broker and Providers consume the
  frozen result. Do not duplicate policy parsing in adapters.
- Tests belong under `__tests__/js-runtime-kernel/capability-runtime/`.
- Public Provider support is not inferred from a registry row; support claims
  require the milestone E2E evidence.
- `engine-gate-registry.ts` and `engine-gate-dispatch.ts` own the Host-only Gate pipeline, independent of Providers but sharing plugin revision lifecycle. Decision completion is not chain settlement: retain the graph lease for all started frames, including unawaited next and late cancellation settlement. Platform adapters own deadlines, V8 hooks and source capture; Policy remains a prior hard ceiling.
- Capability-specific facades, registries and Provider-neutral contracts live
  in `packages/capabilities/*/src/kernel/`; this directory owns only shared
  admission, snapshot, policy, authority, resource, delivery and lifecycle
  primitives plus their aggregate composition points.
- Host profile paths, Provider registration/configuration and platform I/O
  belong to adapters and must not enter this platform-neutral package.
- `invocation-host-input.ts` verifies independently selected Host request-body inspection authority, separate from Guest invocation JSON. `broker-host-bindings.ts` activates branded request/generation/digest-bound readers and strips them from Provider contexts. The Network package's `request-body-reader.ts` owns bounded staging, one-shot quotas and best-effort zeroization; reader-bearing invocations also inherit a finite Policy socket deadline.
- `resource-registry.ts` retains the trusted publication owner for event schema,
  Provider module and resource type. Host adapters obtain its bounded
  `eventDescriptor` through Broker/Kernel before subscribing; Guest event
  streams do not supply that metadata. Resource event schema validation and
  generation fencing remain here.
- `guest-facade-support.ts::createCapabilityCallbackDispatcherV1` adapts the caller-owned Event Loop's `enqueueIoCallback` to the optional trusted local `CapabilityGuestBridgeV1.enqueueCallback` port. Capability FS error-first callbacks use its bounded I/O/check batches, referenced liveness and normal tick/fatal-callback boundary; Promise API settlement is unchanged. Native, Node and Android bootstrap install this local port without adding Host IPC or a scheduler. Low-level bridge users that omit it retain legacy delivery, not a Node-phase guarantee.
