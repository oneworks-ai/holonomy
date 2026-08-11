package ai.oneworks.holonomy.network;

/**
 * Immutable, bounded observation summary. URLs, paths, query strings, headers, bodies, resolved
 * addresses and transport objects are deliberately absent.
 */
public final class AndroidNetworkObservation {
    private final AndroidNetworkProviderGeneration generation;
    private final long exchangeSequence;
    private final AndroidNetworkObservationKind kind;
    private final String origin;
    private final String method;
    private final Integer statusCode;
    private final long elapsedMs;
    private final long requestBodyBytes;
    private final long responseBodyBytes;
    private final AndroidNetworkTerminalState terminalState;
    private final String errorCode;

    AndroidNetworkObservation(
            AndroidNetworkProviderGeneration generation,
            long exchangeSequence,
            AndroidNetworkObservationKind kind,
            String origin,
            String method,
            Integer statusCode,
            long elapsedMs,
            long requestBodyBytes,
            long responseBodyBytes,
            AndroidNetworkTerminalState terminalState,
            String errorCode) {
        this.generation = generation;
        this.exchangeSequence = exchangeSequence;
        this.kind = kind;
        this.origin = origin;
        this.method = method;
        this.statusCode = statusCode;
        this.elapsedMs = elapsedMs;
        this.requestBodyBytes = requestBodyBytes;
        this.responseBodyBytes = responseBodyBytes;
        this.terminalState = terminalState;
        this.errorCode = errorCode;
    }

    public AndroidNetworkProviderGeneration getGeneration() {
        return generation;
    }

    public long getExchangeSequence() {
        return exchangeSequence;
    }

    public AndroidNetworkObservationKind getKind() {
        return kind;
    }

    public String getOrigin() {
        return origin;
    }

    public String getMethod() {
        return method;
    }

    public Integer getStatusCode() {
        return statusCode;
    }

    public long getElapsedMs() {
        return elapsedMs;
    }

    public long getRequestBodyBytes() {
        return requestBodyBytes;
    }

    public long getResponseBodyBytes() {
        return responseBodyBytes;
    }

    public AndroidNetworkTerminalState getTerminalState() {
        return terminalState;
    }

    public String getErrorCode() {
        return errorCode;
    }

    AndroidNetworkObservation frozenCopy() {
        AndroidNetworkProviderGeneration generationCopy = generation == null
                ? null
                : new AndroidNetworkProviderGeneration(generation.getRuntimeId(), generation.getGeneration());
        return new AndroidNetworkObservation(
                generationCopy,
                exchangeSequence,
                kind,
                origin,
                method,
                statusCode,
                elapsedMs,
                requestBodyBytes,
                responseBodyBytes,
                terminalState,
                errorCode);
    }

    @Override
    public String toString() {
        return "AndroidNetworkObservation("
                + "generation=" + generation
                + ", exchangeSequence=" + exchangeSequence
                + ", kind=" + kind
                + ", origin=" + origin
                + ", method=" + method
                + ", statusCode=" + statusCode
                + ", elapsedMs=" + elapsedMs
                + ", requestBodyBytes=" + requestBodyBytes
                + ", responseBodyBytes=" + responseBodyBytes
                + ", terminalState=" + terminalState
                + ", errorCode=" + errorCode
                + ')';
    }
}
