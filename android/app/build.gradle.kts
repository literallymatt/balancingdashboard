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
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Personal sideload build: signed with the auto-generated debug key so it installs directly.
            signingConfig = signingConfigs.getByName("debug")
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
