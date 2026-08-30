pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "oneworks-holonomy-android"
include(":host-core")
include(":capability-host")
include(":v8-host")
include(":network-host")
include(":process-backend-v86")
include(":session-host")
include(":e2e")
