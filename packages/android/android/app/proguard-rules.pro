# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# arthenica / JamaisMagic ffmpeg-kit — JNI entry points, must not be stripped.
-keep class com.arthenica.ffmpegkit.** { *; }
-keep class com.arthenica.smartexception.** { *; }
-dontwarn com.arthenica.**

# Convert-X local Expo modules.
-keep class expo.modules.convertxffmpeg.** { *; }

# Kotlin metadata for any reflective lookup (Expo Modules SDK uses some).
-keep class kotlin.Metadata { *; }
-keepattributes *Annotation*
-keepattributes Signature
-dontwarn kotlin.reflect.jvm.internal.**

# Phase 6: youtubedl-android — uncomment when the downloader native module
# lands so its JNI entry points survive R8 in release builds.
# -keep class com.yausername.youtubedl_android.** { *; }
# -keep class com.yausername.ffmpeg.** { *; }
# -keep class com.yausername.aria2c.** { *; }
