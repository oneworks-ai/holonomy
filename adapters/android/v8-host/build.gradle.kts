plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.oneworks.mobile.runtime.v8"
    compileSdk = 35

    defaultConfig {
        minSdk = 29
        ndk {
            abiFilters += setOf("arm64-v8a", "x86_64")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(project(":host-core"))
    implementation("com.caoccao.javet:javet-v8-android:5.0.10")
    testImplementation("junit:junit:4.13.2")
}
