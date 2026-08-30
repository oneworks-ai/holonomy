package ai.oneworks.holonomy.network;

import android.os.SystemClock;
import java.net.InetAddress;
import java.net.Socket;
import java.lang.reflect.Constructor;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import kotlin.Result;
import kotlin.Unit;
import kotlin.jvm.functions.Function0;
import kotlin.jvm.functions.Function1;

interface NetworkClock {
    long nowMs();
}

interface NetworkAddressResolver extends AutoCloseable {
    NetworkResolution resolve(
            String host,
            int timeoutMs,
            Function1<? super Result<? extends List<? extends InetAddress>>, Unit> callback);

    @Override
    default void close() {}
}

interface NetworkResolution {
    void cancel();
}

interface NetworkConnectionFactory {
    NetworkHttpConnection create(NetworkConnectionTarget target, int timeoutMs);
}

interface NetworkSocketFactory {
    Socket create();
}

interface NetworkTlsLayer {
    Socket secure(
            Socket socket,
            NetworkTlsPolicy policy,
            int port,
            int timeoutMs,
            Function1<? super Socket, Unit> activate);
}

interface NetworkWorker extends AutoCloseable {
    /** A true result transfers exactly-once invocation ownership to the worker, including during close. */
    boolean execute(Function0<Unit> task);
}

final class ExecutorNetworkWorker implements NetworkWorker {
    private final AtomicInteger threadIds = new AtomicInteger(1);
    private final ThreadPoolExecutor executor;

    ExecutorNetworkWorker(int threads) {
        this(threads, threads);
    }

    ExecutorNetworkWorker(int threads, int queuedTasks) {
        if (threads <= 0 || queuedTasks <= 0) throw new IllegalArgumentException();
        executor = new ThreadPoolExecutor(
                threads,
                threads,
                0L,
                TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(queuedTasks),
                work -> {
                    Thread thread = new Thread(
                            work,
                            "holonomy-http-provider-" + threadIds.getAndIncrement());
                    thread.setDaemon(true);
                    return thread;
                },
                new ThreadPoolExecutor.AbortPolicy());
    }

    @Override
    public boolean execute(Function0<Unit> task) {
        try {
            executor.execute(task::invoke);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    @Override
    public void close() {
        List<Runnable> acceptedButNotStarted = executor.shutdownNow();
        for (Runnable task : acceptedButNotStarted) {
            try {
                task.run();
            } catch (Throwable ignored) {
                // A worker task owns its own terminal handling.
            }
        }
    }
}

final class NetworkHostDependencies {
    private static final Constructor<AndroidHttpNetworkHost> HOST_CONSTRUCTOR = findHostConstructor();
    private final NetworkAddressResolver addressResolver;
    private final NetworkClock clock;
    private final NetworkConnectionFactory connectionFactory;
    private final NetworkWorker worker;

    NetworkHostDependencies(
            NetworkAddressResolver addressResolver,
            NetworkClock clock,
            NetworkConnectionFactory connectionFactory,
            NetworkWorker worker) {
        this.addressResolver = addressResolver;
        this.clock = clock;
        this.connectionFactory = connectionFactory;
        this.worker = worker;
    }

    NetworkAddressResolver getAddressResolver() {
        return addressResolver;
    }

    NetworkClock getClock() {
        return clock;
    }

    NetworkConnectionFactory getConnectionFactory() {
        return connectionFactory;
    }

    NetworkWorker getWorker() {
        return worker;
    }

    static NetworkHostDependencies platform(AndroidNetworkLimits limits) {
        return new NetworkHostDependencies(
                new AndroidNetworkAddressResolver(),
                SystemClock::elapsedRealtime,
                (target, timeoutMs) -> new PinnedHttp1Connection(
                        target,
                        timeoutMs,
                        Socket::new,
                        PlatformNetworkTlsLayer.INSTANCE),
                new ExecutorNetworkWorker(limits.getMaxConcurrentConnections()));
    }

    static AndroidHttpNetworkHost createProvider(
            AndroidNetworkHostConfiguration configuration,
            AndroidNetworkObservationConfiguration observation,
            AndroidNetworkProviderGeneration generation) {
        try {
            return HOST_CONSTRUCTOR.newInstance(
                    configuration,
                    platform(configuration.getLimits()),
                    observation,
                    generation,
                    null);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("Cannot create Android network provider", error);
        }
    }

    static AndroidHttpNetworkHost createCapabilityProvider(
            AndroidNetworkHostConfiguration configuration,
            AndroidNetworkObservationConfiguration observation,
            AndroidNetworkProviderGeneration generation,
            AndroidCapabilityNetworkAuthority authority) {
        try {
            return HOST_CONSTRUCTOR.newInstance(
                    configuration,
                    platform(configuration.getLimits()),
                    observation,
                    generation,
                    authority);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("Cannot create capability-bound Android network provider", error);
        }
    }

    private static Constructor<AndroidHttpNetworkHost> findHostConstructor() {
        try {
            Constructor<AndroidHttpNetworkHost> constructor = AndroidHttpNetworkHost.class.getDeclaredConstructor(
                    AndroidNetworkHostConfiguration.class,
                    NetworkHostDependencies.class,
                    AndroidNetworkObservationConfiguration.class,
                    AndroidNetworkProviderGeneration.class,
                    AndroidCapabilityNetworkAuthority.class);
            constructor.setAccessible(true);
            return constructor;
        } catch (ReflectiveOperationException error) {
            throw new ExceptionInInitializerError(error);
        }
    }
}
