plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val repositoryRoot = rootProject.projectDir.resolve("../..").canonicalFile
val generatedAssets = layout.buildDirectory.dir("generated/v86Assets")
val primaryAssetRoot = providers.gradleProperty("holonomy.v86.assetsDir")
    .orElse(providers.environmentVariable("HOLO_V86_ANDROID_ASSET_ROOT"))
val compatibilityAssetRoot = providers.environmentVariable("HOLO_V86_PROBE_ASSET_ROOT")

val prepareV86Assets by tasks.registering(Exec::class) {
    workingDir(repositoryRoot)
    commandLine(
        "node",
        layout.projectDirectory.file("tools/prepare-v86-assets.mjs").asFile.absolutePath,
        layout.projectDirectory.dir("src/main/backend").asFile.absolutePath,
        generatedAssets.get().asFile.absolutePath,
        primaryAssetRoot.orNull ?: compatibilityAssetRoot.orNull ?: "",
    )
    inputs.dir(layout.projectDirectory.dir("src/main/backend"))
    inputs.file(layout.projectDirectory.file("tools/prepare-v86-assets.mjs"))
    (primaryAssetRoot.orNull ?: compatibilityAssetRoot.orNull)?.let { inputs.dir(it) }
    outputs.dir(generatedAssets)
}

android {
    namespace = "ai.oneworks.holonomy.v86"
    compileSdk = 35

    defaultConfig {
        minSdk = 29
        ndk {
            abiFilters += setOf("arm64-v8a", "x86_64")
        }
    }

    sourceSets.getByName("main").assets.srcDir(generatedAssets)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

tasks.configureEach {
    if (name == "preBuild") dependsOn(prepareV86Assets)
}

dependencies {
    api(project(":capability-host"))
    api(project(":host-core"))
    implementation(project(":network-host"))
    implementation("com.caoccao.javet:javet-v8-android:5.0.10")
    testImplementation("com.google.code.gson:gson:2.10.1")
    testImplementation("junit:junit:4.13.2")
}
