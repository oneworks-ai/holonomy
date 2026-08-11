package ai.oneworks.holonomy.network

import ai.oneworks.holonomy.host.RuntimeNativeHost
import java.lang.ref.WeakReference

/** Stable identity for one logical runtime generation. */
data class AndroidNetworkProviderGeneration(
    val runtimeId: String,
    val generation: Long,
) {
    init {
        require(RUNTIME_ID.matches(runtimeId))
        require(generation > 0)
    }

    private companion object {
        private val RUNTIME_ID = Regex("^[A-Za-z0-9:._-]{1,128}$")
    }
}

/** Creates the complete native network provider for one runtime generation. */
fun interface AndroidNetworkProviderCreator {
    fun create(generation: AndroidNetworkProviderGeneration): RuntimeNativeHost
}

/**
 * Generation-aware entry point for the default provider or a trusted replacement.
 *
 * A creator must return a fresh host for every call. Reusing a live host identity fails closed so
 * cancellation, resource ownership and disposal cannot cross runtime generations.
 */
class AndroidNetworkProviderFactory private constructor(
    private val creator: AndroidNetworkProviderCreator,
) {
    private val issuedLock = Any()
    private val issued = mutableListOf<WeakReference<RuntimeNativeHost>>()

    fun create(generation: AndroidNetworkProviderGeneration): RuntimeNativeHost {
        val candidate = creator.create(generation)
        synchronized(issuedLock) {
            issued.removeAll { it.get() == null }
            check(issued.none { it.get() === candidate }) {
                "Android network providers must be fresh for every runtime generation"
            }
            issued += WeakReference(candidate)
        }
        return candidate
    }

    companion object {
        @JvmStatic
        @JvmOverloads
        fun default(
            configuration: AndroidNetworkHostConfiguration,
            observation: AndroidNetworkObservationConfiguration = AndroidNetworkObservationConfiguration(),
        ): AndroidNetworkProviderFactory = AndroidNetworkProviderFactory { generation ->
            NetworkHostDependencies.createProvider(configuration, observation, generation)
        }

        @JvmStatic
        fun replacement(creator: AndroidNetworkProviderCreator): AndroidNetworkProviderFactory =
            AndroidNetworkProviderFactory(creator)
    }
}

/** Read-only side channel. It cannot authorize, mutate, cancel or grant credits to a request. */
fun interface AndroidNetworkObserver {
    fun onObservation(observation: AndroidNetworkObservation)

    companion object {
        @JvmField
        val NONE = AndroidNetworkObserver {}
    }
}

data class AndroidNetworkObservationConfiguration @JvmOverloads constructor(
    val observer: AndroidNetworkObserver = AndroidNetworkObserver.NONE,
    val maxPendingObservations: Int = 64,
) {
    init {
        require(maxPendingObservations in 1..1024)
    }
}

enum class AndroidNetworkObservationKind {
    REQUEST,
    TRANSPORT,
    RESPONSE,
    TERMINAL,
}

enum class AndroidNetworkTerminalState {
    COMPLETED,
    CANCELLED,
    CLOSED,
    DISPOSED,
    FAILED,
}
