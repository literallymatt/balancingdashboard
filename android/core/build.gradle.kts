import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins { id("org.jetbrains.kotlin.jvm") }

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
tasks.withType<KotlinCompile>().configureEach { compilerOptions.jvmTarget.set(JvmTarget.JVM_17) }
tasks.withType<JavaCompile>().configureEach { options.release.set(17) }

dependencies {
    // org.json ships with Android; only needed at compile time here (the harness supplies it on the JVM).
    compileOnly("org.json:json:20240303")
}
