plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "ai.oneworks.holonomy.sdk.consumer"
    compileSdk = 35
    defaultConfig {
        applicationId = "ai.oneworks.holonomy.sdk.consumer"
        minSdk = 29
        targetSdk = 35
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += setOf("arm64-v8a", "x86_64") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin { jvmToolchain(17) }
dependencies {
    implementation(files("../libraries/host-core-debug.aar"))
    implementation(files("../libraries/v8-host-debug.aar"))
    implementation(files("../libraries/runtime-host-debug.aar"))
    implementation(files("../libraries/crypto-host-debug.aar"))
    implementation("com.caoccao.javet:javet-v8-android:5.0.10")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
