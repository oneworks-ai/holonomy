plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val repositoryRoot = rootProject.projectDir.resolve("../..").canonicalFile
val generatedRuntimeAssets = layout.buildDirectory.dir("generated/runtimeAssets")
val v86ProbeAssetRoot = providers.environmentVariable("HOLO_V86_PROBE_ASSET_ROOT")

val prepareRuntimeAssets by tasks.registering(Exec::class) {
    workingDir(repositoryRoot)
    commandLine(
        "node",
        layout.projectDirectory.file("tools/prepare-runtime-assets.mjs").asFile.absolutePath,
        repositoryRoot.resolve("dist").absolutePath,
        repositoryRoot.resolve("src").absolutePath,
        layout.projectDirectory.dir("src/runtimeBootstrap").asFile.absolutePath,
        layout.projectDirectory.dir("src/runtimeFixtures").asFile.absolutePath,
        repositoryRoot.resolve("node_modules/acorn/dist/acorn.mjs").absolutePath,
        generatedRuntimeAssets.get().asFile.absolutePath,
    )
    inputs.dir(repositoryRoot.resolve("dist"))
    inputs.dir(layout.projectDirectory.dir("src/runtimeBootstrap"))
    inputs.dir(layout.projectDirectory.dir("src/runtimeFixtures"))
    inputs.dir(layout.projectDirectory.dir("src/backendProbe"))
    inputs.file(layout.projectDirectory.file("tools/prepare-runtime-assets.mjs"))
    inputs.file(layout.projectDirectory.file("tools/generate-capability-kernel-fixture.mjs"))
    inputs.file(layout.projectDirectory.file("tools/generate-process-backend-probe.mjs"))
    inputs.file(layout.projectDirectory.file("tools/verify-runtime-assets.mjs"))
    inputs.file(repositoryRoot.resolve("tools/service/capability-runtime-manager.mjs"))
    inputs.file(repositoryRoot.resolve("node_modules/acorn/dist/acorn.mjs"))
    inputs.file(repositoryRoot.resolve("package.json"))
    inputs.file(repositoryRoot.resolve("pnpm-lock.yaml"))
    v86ProbeAssetRoot.orNull?.let { inputs.dir(it) }
    outputs.dir(generatedRuntimeAssets)
}

android {
    namespace = "ai.oneworks.holonomy.e2e"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.oneworks.holonomy.e2e"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk {
            abiFilters += setOf("arm64-v8a", "x86_64")
        }
    }

    sourceSets.getByName("main").assets.srcDir(generatedRuntimeAssets)
    sourceSets.getByName("main").assets.srcDir(
        repositoryRoot.resolve("src/capability-runtime/machine"),
    )

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

tasks.configureEach {
    if (name == "preBuild") dependsOn(prepareRuntimeAssets)
}

dependencies {
    implementation(project(":capability-host"))
    implementation(project(":v8-host"))
    implementation(project(":network-host"))
    implementation(project(":session-host"))
    implementation("com.caoccao.javet:javet-v8-android:5.0.10")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("com.caoccao.javet:javet-v8-android:5.0.10")
}
