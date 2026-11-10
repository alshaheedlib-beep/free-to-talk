#!/usr/bin/env bash
# Runs on GitHub's Mac: boots an iPhone simulator, installs هون, puts it at the Polytechnic and takes screenshots.
set -x
mkdir -p shots
UDID=$(xcrun simctl list devices available -j | python3 -c "
import json,sys
d=json.load(sys.stdin)['devices']
phones=[x for rt,ds in sorted(d.items(), reverse=True) if 'iOS' in rt for x in ds if x['name'].startswith('iPhone')]
print(phones[0]['udid'])")
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" ios/build/Build/Products/Release-iphonesimulator/Hon.app
xcrun simctl privacy "$UDID" grant location-always ps.alshaheed.hon || true
xcrun simctl location "$UDID" set 31.5336,35.0972 || true
xcrun simctl launch "$UDID" ps.alshaheed.hon
# GitHub's Macs can be slow: give the page time to load before judging it
sleep 60
xcrun simctl io "$UDID" screenshot shots/ios-1-home.png
sleep 60
xcrun simctl io "$UDID" screenshot shots/ios-2-later.png
xcrun simctl spawn "$UDID" log show --last 3m --predicate 'process == "Hon"' --style compact 2>/dev/null | tail -40 || true
ls -la shots
