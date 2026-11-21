#!/usr/bin/env bash
# Сборка APK без Android Studio и Gradle (Ubuntu):
#   apt install aapt apksigner dalvik-exchange zipalign android-sdk-platform-23 openjdk-17-jdk-headless
# Подпись: ключ из переменной KEYSTORE (по умолчанию android/youmusic.keystore, в репозиторий не кладётся).
# Обновлять приложение на телефоне поверх старого можно, только если подписать тем же ключом.
set -euo pipefail
cd "$(dirname "$0")"
ANDROID_JAR=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
KEYSTORE=${KEYSTORE:-youmusic.keystore}
OUT=${OUT:-build/YouMusic.apk}
rm -rf build && mkdir -p build/gen build/classes

if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -alias youmusic -keyalg RSA -keysize 2048 -validity 36500 \
    -storepass youmusic -keypass youmusic -dname "CN=YouMusic" -noprompt
fi

aapt package -f -m -J build/gen -M AndroidManifest.xml -S res -I "$ANDROID_JAR"
javac --release 8 -nowarn -encoding UTF-8 -classpath "$ANDROID_JAR" -d build/classes \
  $(find src build/gen -name '*.java')
dalvik-exchange --dex --output=build/classes.dex build/classes
aapt package -f -M AndroidManifest.xml -S res -A assets -I "$ANDROID_JAR" -F build/unsigned.apk
(cd build && aapt add -f unsigned.apk classes.dex >/dev/null)
zipalign -f 4 build/unsigned.apk build/aligned.apk
apksigner sign --ks "$KEYSTORE" --ks-pass pass:youmusic --key-pass pass:youmusic --out "$OUT" build/aligned.apk
apksigner verify "$OUT"
echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"
