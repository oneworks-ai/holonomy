plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val repositoryRoot = rootProject.projectDir.resolve("../..").canonicalFile
val generatedTypeScript = layout.buildDirectory.dir("generated/typescript")
val generatedRuntimeAssets = layout.buildDirectory.dir("generated/runtimeAssets")

val buildRuntimeJavaScript by tasks.registering(Exec::class) {
    workingDir(repositoryRoot)
    commandLine(
        repositoryRoot.resolve("node_modules/.bin/tsc").absolutePath,
        "-p",
        repositoryRoot.resolve("tsconfig.build.json").absolutePath,
        "--outDir",
        generatedTypeScript.get().asFile.absolutePath,
        "--declaration",
        "false",
    )
    doFirst {
        delete(generatedTypeScript)
    }
    inputs.files(repositoryRoot.resolve("src").walkTopDown().filter { it.isFile }.toList())
    inputs.file(repositoryRoot.resolve("tsconfig.build.json"))
    outputs.dir(generatedTypeScript)
}

val prepareRuntimeAssets by tasks.registering(Exec::class) {
    dependsOn(buildRuntimeJavaScript)
    workingDir(repositoryRoot)
    commandLine(
        "node",
        layout.projectDirectory.file("tools/prepare-runtime-assets.mjs").asFile.absolutePath,
        generatedTypeScript.get().asFile.absolutePath,
        repositoryRoot.resolve("src").absolutePath,
        layout.projectDirectory.dir("src/runtimeBootstrap").asFile.absolutePath,
        layout.projectDirectory.dir("src/runtimeFixtures").asFile.absolutePath,
        repositoryRoot.resolve("node_modules/acorn/dist/acorn.mjs").absolutePath,
        generatedRuntimeAssets.get().asFile.absolutePath,
    )
    inputs.dir(generatedTypeScript)
    inputs.dir(layout.projectDirectory.dir("src/runtimeBootstrap"))
    inputs.dir(layout.projectDirectory.dir("src/runtimeFixtures"))
    inputs.file(layout.projectDirectory.file("tools/prepare-runtime-assets.mjs"))
    inputs.file(repositoryRoot.resolve("node_modules/acorn/dist/acorn.mjs"))
    outputs.dir(generatedRuntimeAssets)
}

android {
    namespace = "ai.oneworks.mobile.runtime.e2e"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.oneworks.mobile.runtime.e2e"
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
    implementation(project(":v8-host"))
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
