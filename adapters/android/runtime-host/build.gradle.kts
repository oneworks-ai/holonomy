plugins {
    id("com.android.library")
}

val repositoryRoot = rootProject.projectDir.resolve("../..").canonicalFile
val generatedRuntimeAssets = layout.buildDirectory.dir("generated/runtimeAssets")
val prepareRuntimeAssets by tasks.registering(Exec::class) {
    workingDir(repositoryRoot)
    commandLine(
        "node",
        layout.projectDirectory.file("tools/prepare-runtime-assets.mjs").asFile.absolutePath,
        repositoryRoot.resolve("dist").absolutePath,
        repositoryRoot.resolve("src").absolutePath,
        layout.projectDirectory.dir("src/runtimeBootstrap").asFile.absolutePath,
        repositoryRoot.resolve("node_modules/acorn/dist/acorn.mjs").absolutePath,
        generatedRuntimeAssets.get().asFile.absolutePath,
    )
    inputs.dir(repositoryRoot.resolve("dist"))
    inputs.dir(repositoryRoot.resolve("src"))
    listOf("runtime", "holouv", "capabilities/device", "capabilities/fs", "capabilities/network",
        "capabilities/process", "capabilities/storage", "capabilities/system", "plugins/audit",
        "plugins/permission").forEach { owner ->
        inputs.dir(repositoryRoot.resolve("packages/$owner/src"))
        inputs.dir(repositoryRoot.resolve("packages/$owner/dist"))
    }
    inputs.dir(layout.projectDirectory.dir("src/runtimeBootstrap"))
    inputs.dir(layout.projectDirectory.dir("tools"))
    inputs.file(repositoryRoot.resolve("package.json"))
    inputs.file(repositoryRoot.resolve("pnpm-lock.yaml"))
    inputs.file(repositoryRoot.resolve("node_modules/acorn/dist/acorn.mjs"))
    outputs.dir(generatedRuntimeAssets)
}

android {
    namespace = "ai.oneworks.holonomy.runtime"
    compileSdk = 35
    defaultConfig { minSdk = 29 }
    sourceSets.getByName("main").assets.srcDir(generatedRuntimeAssets)
    sourceSets.getByName("main").assets.srcDir(repositoryRoot.resolve("packages/runtime/src/kernel/machine"))
}

tasks.configureEach {
    if (name == "preBuild") dependsOn(prepareRuntimeAssets)
}

dependencies {
    api(project(":v8-host"))
    implementation("com.caoccao.javet:javet-v8-android:5.0.10")
}
