package ai.oneworks.holonomy.network

import org.json.JSONArray
import org.json.JSONObject

internal data class HttpRequestMetadata(
    val headers: List<Pair<String, String>>,
    val method: String,
    val url: AuthorizedNetworkUrl,
)

internal fun parseHttpRequestMetadata(
    args: JSONObject,
    configuration: AndroidNetworkHostConfiguration,
): HttpRequestMetadata {
    require(args.hasExactKeys("headers", "method", "url"))
    val method = normalizeHttpMethod(args.get("method") as? String ?: throw IllegalArgumentException())
    val rawUrl = args.get("url") as? String ?: throw IllegalArgumentException()
    val url = configuration.authorizeUrl(rawUrl)
    val headers = readRequestHeaders(
        args.get("headers") as? JSONArray ?: throw IllegalArgumentException(),
        configuration.limits,
    )
    val aggregate = measuredUtf8(method).toLong() + measuredUtf8(rawUrl) + measuredHeaders(headers)
    if (aggregate > configuration.limits.maxHeaderBytes.toLong() + configuration.limits.maxRequestBodyBytes) {
        throw HttpRequestLimitExceeded()
    }
    if (method == "GET" || method == "HEAD") require(headers.none { it.first == "content-length" })
    return HttpRequestMetadata(headers = headers, method = method, url = url)
}

internal fun reauthorizeHttpRequestMetadata(
    metadata: HttpRequestMetadata,
    configuration: AndroidNetworkHostConfiguration,
) {
    require(normalizeHttpMethod(metadata.method) == metadata.method)
    val url = configuration.authorizeUrl(metadata.url.raw)
    require(
        url.host == metadata.url.host && url.hostHeader == metadata.url.hostHeader &&
            url.origin == metadata.url.origin && url.port == metadata.url.port &&
            url.raw == metadata.url.raw && url.requestTarget == metadata.url.requestTarget &&
            url.scheme == metadata.url.scheme
    )
    require(measuredHeaders(metadata.headers) <= configuration.limits.maxHeaderBytes)
    require(metadata.headers.size <= configuration.limits.maxHeaders)
    for ((name, value) in metadata.headers) validateRequestHeader(name, value)
}

private fun normalizeHttpMethod(value: String): String {
    require(METHOD_TOKEN.matches(value))
    val upper = value.uppercase()
    require(upper !in FORBIDDEN_METHODS)
    if (upper in NORMALIZED_METHODS) require(value == upper)
    return value
}

private fun readRequestHeaders(array: JSONArray, limits: AndroidNetworkLimits): List<Pair<String, String>> {
    if (array.length() > limits.maxHeaders) throw HttpRequestLimitExceeded()
    val output = ArrayList<Pair<String, String>>(array.length())
    val names = HashSet<String>()
    var bytes = 0L
    repeat(array.length()) { index ->
        val entry = array.get(index) as? JSONArray ?: throw IllegalArgumentException()
        require(entry.length() == 2)
        val name = entry.get(0) as? String ?: throw IllegalArgumentException()
        val value = entry.get(1) as? String ?: throw IllegalArgumentException()
        validateRequestHeader(name, value)
        require(names.add(name))
        bytes += measuredUtf8(name).toLong() + measuredUtf8(value) + HEADER_FRAMING_BYTES
        if (bytes > limits.maxHeaderBytes) throw HttpRequestLimitExceeded()
        output += name to value
    }
    return output
}

private fun validateRequestHeader(name: String, value: String) {
    require(name == name.lowercase() && HEADER_NAME.matches(name))
    require(name !in HTTP_MANAGED_REQUEST_HEADERS && !name.startsWith("proxy-") && !name.startsWith("sec-"))
    require(value.all { it.code <= 0xFF } && !hasInvalidHttpText(value))
}

private fun measuredHeaders(headers: List<Pair<String, String>>): Long = headers.fold(0L) { total, entry ->
    total + measuredUtf8(entry.first) + measuredUtf8(entry.second) + HEADER_FRAMING_BYTES
}

private fun measuredUtf8(value: String): Int = value.toByteArray(Charsets.UTF_8).size

internal class HttpRequestLimitExceeded : IllegalArgumentException()

private const val HEADER_FRAMING_BYTES = 4
private val FORBIDDEN_METHODS = setOf("CONNECT", "TRACE", "TRACK")
private val NORMALIZED_METHODS = setOf("DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT")
private val METHOD_TOKEN = Regex("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")
private val HEADER_NAME = Regex("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")
