import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// リリース署名の情報は android/key.properties から読む(コミットしない)。
// CIでは codemagic.yaml が Codemagic の keystore から書き出す。
// 鍵が無い Release を debug 署名へ落とすと、ビルド自体は成功しても
// Play Console へのアップロード時に初めて拒否されるため、明示的に失敗させる。
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}
val releaseBuildRequested = gradle.startParameter.taskNames.any { taskName ->
    taskName.endsWith("assembleRelease", ignoreCase = true) ||
        taskName.endsWith("bundleRelease", ignoreCase = true)
}
if (releaseBuildRequested && keystoreProperties.isEmpty()) {
    throw GradleException(
        "Release署名が未設定です。android/key.properties と upload keystore を用意するか、" +
            "Codemagic の Android — Play internal workflow でビルドしてください。",
    )
}

android {
    namespace = "jp.co.aiSensei"
    // permission_handler_android 14 が compileSdk 37 を要求する。
    // Flutter 3.44.8 の flutter.compileSdkVersion はまだ 36 なので、
    // SDKが追いつくまではここで明示的に上書きする。
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "jp.co.aiSensei"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (keystoreProperties.isNotEmpty()) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
