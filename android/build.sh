#!/usr/bin/env bash
# Сборка настоящего Android-приложения на Kotlin без Android Studio и Gradle.
# Нужны: JDK 17+, компилятор Kotlin (kotlinc) и из Android SDK — platform android-34 и build-tools 34
# (aapt2, d8, zipalign, apksigner). Пути задаются переменными KOTLIN_HOME и ANDROID_SDK.
# Подпись: ключ android/youmusic.keystore (в репозиторий не кладётся). Обновлять приложение
# поверх старого можно, только если подписать тем же ключом.
set -euo pipefail
cd "$(dirname "$0")"
KOTLIN_HOME=${KOTLIN_HOME:?укажи папку kotlinc}
SDK=${ANDROID_SDK:?укажи папку с android-34 и build-tools}
JAR=$SDK/platforms/android-34/android.jar
BT=$SDK/build-tools/34.0.0
VERSION_CODE=${VERSION_CODE:-3}
VERSION_NAME=${VERSION_NAME:-3.0}
KEYSTORE=${KEYSTORE:-youmusic.keystore}
rm -rf build && mkdir -p build/dex

"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml build/res.zip \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"
"$KOTLIN_HOME/bin/kotlinc" src -classpath "$JAR" -jvm-target 1.8 -no-reflect -d build/classes.jar 2>&1 | grep -v "^warning" || true
test -f build/classes.jar
"$BT/d8" --release --min-api 24 --lib "$JAR" --output build/dex build/classes.jar "$KOTLIN_HOME/lib/kotlin-stdlib.jar"
cp build/base.apk build/unsigned.apk
(cd build/dex && zip -q -j ../unsigned.apk classes*.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:youmusic --key-pass pass:youmusic --out build/YouMusic.apk build/aligned.apk
"$BT/apksigner" verify build/YouMusic.apk
echo "Готово: build/YouMusic.apk ($(du -h build/YouMusic.apk | cut -f1))"
