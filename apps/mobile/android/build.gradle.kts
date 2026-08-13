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

    // Flutter の Gradle プラグインはプラグイン側の compileSdk を上書きせず警告するだけなので、
    // permission_handler_android のように自前で `compileSdk = 37` を書いているプラグインは、
    // app と同じ理由(hash string `android-37` のプラットフォームが配られていない)で落ちる。
    // app/build.gradle.kts と同じようにマイナー版を補ってやる。
    //
    // afterEvaluate はここ(ルートの評価中)で登録するので、AGP が自分の afterEvaluate で
    // DSL を確定させるより先に走る。
    afterEvaluate {
        val androidExtension =
            extensions.findByType(com.android.build.api.dsl.CommonExtension::class.java)
        if (androidExtension != null &&
            (androidExtension.compileSdk ?: 0) >= 37 &&
            androidExtension.compileSdkMinor == null
        ) {
            androidExtension.compileSdkMinor = 0
        }
    }

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
