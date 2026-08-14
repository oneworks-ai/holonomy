plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val repositoryRoot = rootProject.projectDir.resolve("../..").canonicalFile

android {
    namespace = "ai.oneworks.holonomy.session"
    compileSdk = 35

    defaultConfig {
        minSdk = 29
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets.getByName("test").resources.srcDir(
        repositoryRoot.resolve("src/capability-runtime/machine"),
    )
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(project(":host-core"))
    implementation("com.google.code.gson:gson:2.10.1")
    testImplementation("junit:junit:4.13.2")
}
