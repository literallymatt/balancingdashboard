import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.bmdash"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.bmdash.balancing"
        minSdk = 30
        targetSdk = 35
        // Strictly increasing for every build, so a newer APK always counts as an update (and an older one cannot
        // replace a newer one by accident). The build stamp and commit are shown in the app's Data tab.
        versionCode = (System.currentTimeMillis() / 60_000).toInt()
        val stamp = ZonedDateTime.now(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm 'UTC'"))
        versionName = "0.3.0 · built $stamp · ${System.getenv("GITHUB_SHA")?.take(7) ?: "local"}"
    }

    // A fixed key for personal sideloading, shared by local and CI builds so that every APK installs over the
    // previous one. It is not a Play Store key and protects nothing but "is this an update to my app".
    signingConfigs {
        create("sideload") {
            storeFile = rootProject.file("sideload.keystore")
            storePassword = "bmdash-sideload"
            keyAlias = "bmdash"
            keyPassword = "bmdash-sideload"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // The web UI is shared with the desktop dashboard: bmdash/static is copied in at build time.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
}

val syncWebAssets by tasks.registering(Sync::class) {
    from(rootProject.file("../bmdash/static")) { into("static") }
    into(layout.buildDirectory.dir("generated/webassets"))
}
tasks.matching { it.name != "syncWebAssets" && (it.name.contains("Assets", true) || it.name.contains("Lint", true)) }
    .configureEach { dependsOn(syncWebAssets) }

dependencies {
    implementation(project(":core"))
}
