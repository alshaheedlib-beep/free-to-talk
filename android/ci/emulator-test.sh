#!/usr/bin/env bash
# Runs inside the Android emulator on GitHub: installs the app, puts the phone at the
# Polytechnic, opens هون and takes screenshots that get attached to the release.
set -x
mkdir -p shots
adb install -r hon.apk
adb shell pm grant ps.alshaheed.hon android.permission.ACCESS_FINE_LOCATION || true
adb shell pm grant ps.alshaheed.hon android.permission.ACCESS_COARSE_LOCATION || true
adb emu geo fix 35.0972 31.5336
adb shell settings put secure location_mode 3 || true
adb shell am start -W -n ps.alshaheed.hon/.MainActivity
sleep 30
adb emu geo fix 35.0972 31.5336
sleep 5
adb exec-out screencap -p > shots/1-home.png

# tap "ازرع رسالة هون" (bottom centre) to open the compose sheet
read -r W H < <(adb shell wm size | sed -E 's/.*: ([0-9]+)x([0-9]+).*/\1 \2/')
adb shell input tap $((W / 2)) $((H - H / 12))
sleep 3
adb exec-out screencap -p > shots/2-compose.png

# Android back button should close the sheet, not leave the app
adb shell input keyevent KEYCODE_BACK
sleep 2
adb exec-out screencap -p > shots/3-after-back.png

adb logcat -d -s chromium:I WebViewFactory:I AndroidRuntime:E > shots/logcat.txt || true
ls -la shots
