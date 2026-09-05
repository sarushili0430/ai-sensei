allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)

    // CameraX 1.6.1 publishes concurrent-futures as a runtime-only dependency,
    // but javac on JDK 25 also needs it while reading CameraX class signatures.
    // Keep the workaround scoped to the CameraX Flutter plugin.
    if (name == "camera_android_camerax") {
        pluginManager.withPlugin("com.android.library") {
            dependencies.add(
                "implementation",
                "androidx.concurrent:concurrent-futures:1.1.0",
            )
        }
    }
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
