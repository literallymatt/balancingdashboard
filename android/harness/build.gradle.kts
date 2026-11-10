import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    id("org.jetbrains.kotlin.jvm")
    application
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
tasks.withType<KotlinCompile>().configureEach { compilerOptions.jvmTarget.set(JvmTarget.JVM_17) }
tasks.withType<JavaCompile>().configureEach { options.release.set(17) }

application { mainClass.set("bmdash.harness.MainKt") }

dependencies {
    implementation(project(":core"))
    implementation("org.json:json:20240303")
    implementation("org.xerial:sqlite-jdbc:3.46.1.0")
}
