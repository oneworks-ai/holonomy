plugins {
    id("com.android.application") version "8.7.3" apply false
    id("com.android.library") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}

tasks.register("testAdapterUnit") {
    group = "verification"
    description = "Runs Android adapter JVM tests for engine-host and capability-provider modules."
    dependsOn(
        ":host-core:testDebugUnitTest",
        ":v8-host:testDebugUnitTest",
        ":network-host:testDebugUnitTest",
        ":session-host:testDebugUnitTest",
    )
}
