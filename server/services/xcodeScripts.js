import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NON_PM2_TYPES } from './streamingDetect.js';

const execAsync = promisify(exec);

// Shared Xcode project constants
export const XCODE_TEAM_ID = 'TYQ32QCF6K';
export const XCODE_BUNDLE_PREFIX = 'net.shadowpuppet';
export const toBundleId = (name) => `${XCODE_BUNDLE_PREFIX}.${name.replace(/[^a-zA-Z0-9]/g, '')}`;
export const toTargetName = (name) => name.replace(/[^a-zA-Z0-9_]/g, '_');

export const XCODE_ENV_EXAMPLE = `TEAM_ID=${XCODE_TEAM_ID}
APPSTORE_API_KEY_ID=YOUR_KEY_ID
APPSTORE_ISSUER_ID=YOUR_ISSUER_ID
APPSTORE_API_PRIVATE_KEY_PATH=~/Library/Mobile Documents/com~apple~CloudDocs/AppDev/AuthKey_XXXXXXXXXX.p8
`;

/**
 * Generate the generic deploy.sh script content.
 * Supports --ios, --macos, --watch, --all, --skip-tests flags.
 * Works with both XcodeGen (project.yml) and raw .xcodeproj projects.
 */
export function generateDeployScript(targetName, _bundleId) {
  return `#!/bin/bash
set -euo pipefail

# ${targetName} - Local TestFlight Deploy
# Usage: ./deploy.sh [--skip-tests] [--ios] [--macos] [--watch] [--all]
# Default (no platform flag): iOS only

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load environment
if [ -f .env ]; then
    set -a
    source .env
    set +a
else
    echo "❌ .env file not found. Copy .env.example to .env and fill in values."
    exit 1
fi

KEY_PATH="$APPSTORE_API_PRIVATE_KEY_PATH"

if [ ! -f "$KEY_PATH" ]; then
    echo "❌ API key not found at: $KEY_PATH"
    exit 1
fi

# Ensure altool can find the key (it only checks specific directories)
mkdir -p ~/.private_keys
KEY_FILENAME="AuthKey_\${APPSTORE_API_KEY_ID}.p8"
if [ ! -f ~/.private_keys/"$KEY_FILENAME" ]; then
    ln -sf "$KEY_PATH" ~/.private_keys/"$KEY_FILENAME"
    echo "🔑 Symlinked API key to ~/.private_keys/"
fi

# Detect project type: XcodeGen (project.yml) or raw .xcodeproj
if [ -f project.yml ]; then
    PROJECT_MODE="xcodegen"
else
    PROJECT_MODE="xcodeproj"
fi

PROJECT="${targetName}.xcodeproj"
BUILD_DIR="$SCRIPT_DIR/build"

# Parse flags
SKIP_TESTS=false
BUILD_IOS=false
BUILD_MACOS=false
BUILD_WATCH=false
for arg in "$@"; do
    case "$arg" in
        --skip-tests) SKIP_TESTS=true ;;
        --ios) BUILD_IOS=true ;;
        --macos) BUILD_MACOS=true ;;
        --watch) BUILD_WATCH=true ;;
        --all) BUILD_IOS=true; BUILD_MACOS=true; BUILD_WATCH=true ;;
    esac
done
# Default to iOS if no platform specified
if ! $BUILD_IOS && ! $BUILD_MACOS && ! $BUILD_WATCH; then
    BUILD_IOS=true
fi

# Auto-increment build number
if [ "$PROJECT_MODE" = "xcodegen" ]; then
    CURRENT_BUILD=$(grep CURRENT_PROJECT_VERSION project.yml | head -1 | awk '{print $2}')
    NEW_BUILD=$((CURRENT_BUILD + 1))
    echo "📦 Build number: $CURRENT_BUILD → $NEW_BUILD"
    /usr/bin/sed -i '' "s/CURRENT_PROJECT_VERSION: \${CURRENT_BUILD}/CURRENT_PROJECT_VERSION: \${NEW_BUILD}/" project.yml

    echo "⚙️  Regenerating Xcode project..."
    xcodegen generate
else
    CURRENT_BUILD=$(grep -m1 'CURRENT_PROJECT_VERSION = ' "$PROJECT/project.pbxproj" | awk '{print $3}' | tr -d ';')
    NEW_BUILD=$((CURRENT_BUILD + 1))
    echo "📦 Build number: $CURRENT_BUILD → $NEW_BUILD"
    /usr/bin/sed -i '' "s/CURRENT_PROJECT_VERSION = \${CURRENT_BUILD};/CURRENT_PROJECT_VERSION = \${NEW_BUILD};/g" "$PROJECT/project.pbxproj"
fi

# Run tests (unless skipped)
if ! $SKIP_TESTS; then
    echo "🧪 Running tests..."
    DESTINATION=$(
        SIMINFO=$(xcrun simctl list devices available -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    if 'iOS' not in runtime:
        continue
    parts = runtime.replace('com.apple.CoreSimulator.SimRuntime.iOS-', '').split('-')
    os_ver = '.'.join(parts)
    for d in devices:
        name = d.get('name', '')
        if d.get('isAvailable') and 'iPhone 16' in name and 'Plus' not in name and 'Pro' not in name and 'e' != name[-1:]:
            print(f'{name},{os_ver}')
            sys.exit(0)
for runtime, devices in data.get('devices', {}).items():
    if 'iOS' not in runtime:
        continue
    parts = runtime.replace('com.apple.CoreSimulator.SimRuntime.iOS-', '').split('-')
    os_ver = '.'.join(parts)
    for d in devices:
        if d.get('isAvailable') and 'iPhone' in d.get('name', ''):
            print(f\\"{d['name']},{os_ver}\\")
            sys.exit(0)
" 2>/dev/null)
        SIM_NAME="\${SIMINFO%%,*}"
        SIM_OS="\${SIMINFO##*,}"
        if [ -n "$SIM_NAME" ] && [ -n "$SIM_OS" ]; then
            echo "platform=iOS Simulator,name=$SIM_NAME,OS=$SIM_OS"
        else
            echo "platform=iOS Simulator,name=iPhone 16,OS=18.6"
        fi
    )
    xcodebuild test \\
        -project "$PROJECT" \\
        -scheme "${targetName}" \\
        -only-testing:${targetName}Tests \\
        -destination "$DESTINATION" \\
        -configuration Debug \\
        CODE_SIGNING_ALLOWED=NO \\
        -quiet
    echo "✅ Tests passed"
fi

# Clean build directory
rm -rf "$BUILD_DIR"

PLATFORMS_BUILT=0

# --- iOS Build & Upload ---
if $BUILD_IOS; then
    ARCHIVE_IOS="$BUILD_DIR/${targetName}_iOS.xcarchive"
    EXPORT_IOS="$BUILD_DIR/export_ios"

    echo "📦 Archiving iOS..."
    xcodebuild archive \\
        -project "$PROJECT" \\
        -scheme "${targetName}" \\
        -configuration Release \\
        -destination 'generic/platform=iOS' \\
        -archivePath "$ARCHIVE_IOS" \\
        CODE_SIGNING_ALLOWED=NO \\
        CODE_SIGN_IDENTITY="" \\
        CODE_SIGNING_REQUIRED=NO \\
        -quiet
    echo "✅ iOS archive complete"

    cat > "$BUILD_DIR/exportOptions_ios.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
EOF

    echo "📤 Exporting iOS IPA..."
    xcodebuild -exportArchive \\
        -archivePath "$ARCHIVE_IOS" \\
        -exportOptionsPlist "$BUILD_DIR/exportOptions_ios.plist" \\
        -exportPath "$EXPORT_IOS" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet
    echo "✅ iOS IPA exported"

    IPA_PATH="$EXPORT_IOS/${targetName}.ipa"
    if [ ! -f "$IPA_PATH" ]; then
        echo "❌ iOS IPA not found at $IPA_PATH"
        ls -la "$EXPORT_IOS/"
        exit 1
    fi

    echo "🚀 Uploading iOS to TestFlight..."
    xcrun altool --upload-app \\
        --file "$IPA_PATH" \\
        --type ios \\
        --apiKey "$APPSTORE_API_KEY_ID" \\
        --apiIssuer "$APPSTORE_ISSUER_ID" \\
        --transport DAV
    echo "✅ iOS upload complete!"
    PLATFORMS_BUILT=$((PLATFORMS_BUILT + 1))

    if $BUILD_MACOS || $BUILD_WATCH; then
        echo "⏳ Waiting 60s before next upload to avoid Apple CDN contention..."
        sleep 60
    fi
fi

# --- macOS Build & Upload ---
if $BUILD_MACOS; then
    ARCHIVE_MACOS="$BUILD_DIR/${targetName}_macOS.xcarchive"
    EXPORT_MACOS="$BUILD_DIR/export_macos"

    echo "📦 Archiving macOS..."
    xcodebuild archive \\
        -project "$PROJECT" \\
        -scheme "${targetName} macOS" \\
        -configuration Release \\
        -destination 'generic/platform=macOS' \\
        -archivePath "$ARCHIVE_MACOS" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet
    echo "✅ macOS archive complete"

    cat > "$BUILD_DIR/exportOptions_macos.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
EOF

    echo "📤 Exporting macOS pkg..."
    xcodebuild -exportArchive \\
        -archivePath "$ARCHIVE_MACOS" \\
        -exportOptionsPlist "$BUILD_DIR/exportOptions_macos.plist" \\
        -exportPath "$EXPORT_MACOS" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet
    echo "✅ macOS pkg exported"

    PKG_PATH=$(find "$EXPORT_MACOS" -name "*.pkg" | head -1)
    if [ -z "$PKG_PATH" ]; then
        echo "❌ macOS package not found in $EXPORT_MACOS"
        ls -la "$EXPORT_MACOS/"
        exit 1
    fi

    echo "🚀 Uploading macOS to TestFlight..."
    xcrun altool --upload-app \\
        --file "$PKG_PATH" \\
        --type macos \\
        --apiKey "$APPSTORE_API_KEY_ID" \\
        --apiIssuer "$APPSTORE_ISSUER_ID"
    echo "✅ macOS upload complete!"
    PLATFORMS_BUILT=$((PLATFORMS_BUILT + 1))

    if $BUILD_WATCH; then
        echo "⏳ Waiting 60s before next upload to avoid Apple CDN contention..."
        sleep 60
    fi
fi

# --- watchOS Build & Upload ---
if $BUILD_WATCH; then
    ARCHIVE_WATCH="$BUILD_DIR/${targetName}_watchOS.xcarchive"
    EXPORT_WATCH="$BUILD_DIR/export_watchos"

    echo "📦 Archiving watchOS..."
    xcodebuild archive \\
        -project "$PROJECT" \\
        -scheme "${targetName} Watch" \\
        -configuration Release \\
        -destination 'generic/platform=watchOS' \\
        -archivePath "$ARCHIVE_WATCH" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet
    echo "✅ watchOS archive complete"

    cat > "$BUILD_DIR/exportOptions_watchos.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
EOF

    echo "📤 Exporting watchOS..."
    xcodebuild -exportArchive \\
        -archivePath "$ARCHIVE_WATCH" \\
        -exportOptionsPlist "$BUILD_DIR/exportOptions_watchos.plist" \\
        -exportPath "$EXPORT_WATCH" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet
    echo "✅ watchOS exported"

    # watchOS is typically bundled with iOS, but standalone apps need separate upload
    WCK_PATH=$(find "$EXPORT_WATCH" -name "*.ipa" | head -1)
    if [ -n "$WCK_PATH" ]; then
        echo "🚀 Uploading watchOS to TestFlight..."
        xcrun altool --upload-app \\
            --file "$WCK_PATH" \\
            --type ios \\
            --apiKey "$APPSTORE_API_KEY_ID" \\
            --apiIssuer "$APPSTORE_ISSUER_ID" \\
            --transport DAV
        echo "✅ watchOS upload complete!"
    else
        echo "ℹ️  No standalone watchOS IPA (bundled with iOS app)"
    fi
    PLATFORMS_BUILT=$((PLATFORMS_BUILT + 1))
fi

echo "✅ Build $NEW_BUILD submitted to TestFlight ($PLATFORMS_BUILT platform(s))."

# Commit the build number bump
if [ "$PROJECT_MODE" = "xcodegen" ]; then
    git add project.yml "$PROJECT/project.pbxproj"
else
    git add "$PROJECT/project.pbxproj"
fi
git commit -m "build: bump to build $NEW_BUILD"
echo "📝 Committed build number bump"

# Clean up
rm -rf "$BUILD_DIR"
echo "🧹 Cleaned build artifacts"
`;
}

// Shared bash currency_for_locale function (used by both screenshot scripts)
const CURRENCY_CASE_BLOCK = `currency_for_locale() {
    case "$1" in
        en)    echo "USD" ;;
        de|fr|nl|es-ES|it) echo "EUR" ;;
        sv)    echo "SEK" ;;
        es-MX) echo "MXN" ;;
        pt-BR) echo "BRL" ;;
        ja)    echo "JPY" ;;
        zh-Hans) echo "CNY" ;;
        ko)    echo "KRW" ;;
        *)     echo "USD" ;;
    esac
}`;

/**
 * Generate generic iOS/iPad screenshot capture script.
 * All generators accept (targetName, bundleId) for uniform calling.
 */
export function generateScreenshotScript(targetName, bundleId) {
  return `#!/bin/bash
#
# take_screenshots.sh — Capture App Store Connect screenshots for all languages and devices.
#
# Usage:
#   ./take_screenshots.sh                       # all languages, all devices
#   ./take_screenshots.sh en                    # single language, all devices
#   ./take_screenshots.sh en de fr              # specific languages, all devices
#   ./take_screenshots.sh --iphone-only         # all languages, iPhone only
#   ./take_screenshots.sh --ipad-only           # all languages, iPad only
#   ./take_screenshots.sh --screen 01_home      # only capture one screen
#
# Requires: ScreenshotTests target in ${targetName}UITests
#

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$PROJECT_DIR/${targetName}.xcodeproj"
SCHEME="${targetName}"
SCREENSHOTS_DIR="$PROJECT_DIR/screenshots"
CONFIG_FILE_PROJECT="$PROJECT_DIR/.screenshot_config.json"
CONFIG_FILE_TMP="/tmp/${targetName.toLowerCase()}_screenshot_config.json"
DERIVED_DATA="$PROJECT_DIR/.build/DerivedData"
BUNDLE_ID="${bundleId}"

# App Store Connect screenshot device specs
# Format: "Simulator Name|OS version|folder_name|test_method"
IPHONE_DEVICE="iPhone 16 Pro Max|18.6|iphone_6.7|testCaptureIPhoneScreenshots"
IPAD_DEVICE="iPad Pro 13-inch (M4)|18.6|ipad_13|testCaptureIPadScreenshots"

# Supported languages (add your app's localizations here)
ALL_LANGUAGES=("en")

# Currency code per locale
${CURRENCY_CASE_BLOCK}

# Parse arguments
LANGUAGES=()
DEVICES=()
SCREEN=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --iphone-only) DEVICES=("$IPHONE_DEVICE") ; shift ;;
        --ipad-only)   DEVICES=("$IPAD_DEVICE") ; shift ;;
        --screen)      SCREEN="$2" ; shift 2 ;;
        --help|-h)
            echo "Usage: $0 [--iphone-only|--ipad-only] [--screen <name>] [lang1 lang2 ...]"
            echo ""
            echo "Languages: \${ALL_LANGUAGES[*]}"
            echo "Devices: iPhone 16 Pro Max (6.7\\"), iPad Pro 13\\" (M4)"
            exit 0
            ;;
        *)
            LANGUAGES+=("$1") ; shift ;;
    esac
done

# Defaults
[[ \${#LANGUAGES[@]} -eq 0 ]] && LANGUAGES=("\${ALL_LANGUAGES[@]}")
[[ \${#DEVICES[@]} -eq 0 ]] && DEVICES=("$IPHONE_DEVICE" "$IPAD_DEVICE")

TOTAL_LANGS=\${#LANGUAGES[@]}
TOTAL_DEVICES=\${#DEVICES[@]}
TOTAL_RUNS=$((TOTAL_LANGS * TOTAL_DEVICES))
CURRENT_RUN=0
FAILED=()

echo "=========================================="
echo "  ${targetName} App Store Screenshot Capture"
echo "=========================================="
echo "  Languages: \${LANGUAGES[*]}"
echo "  Devices:   $TOTAL_DEVICES"
echo "  Total runs: $TOTAL_RUNS"
[[ -n "$SCREEN" ]] && echo "  Screen:    $SCREEN"
echo "  Output:    $SCREENSHOTS_DIR/{locale}/{device}/"
echo "=========================================="
echo ""

write_config() {
    local locale="$1"
    local device="$2"
    local output="$3"
    local currency
    currency=$(currency_for_locale "$locale")
    cat > "$CONFIG_FILE_PROJECT" <<JSONEOF
{
    "locale": "$locale",
    "device": "$device",
    "output_dir": "$output",
    "currency": "$currency",
    "target_screen": "$SCREEN"
}
JSONEOF
    cp "$CONFIG_FILE_PROJECT" "$CONFIG_FILE_TMP" 2>/dev/null || true
}

# Build test bundles (once per device)
for device_spec in "\${DEVICES[@]}"; do
    IFS='|' read -r DEVICE_NAME DEVICE_OS DEVICE_FOLDER TEST_METHOD <<< "$device_spec"

    echo "🔨 Building test bundle for $DEVICE_NAME..."
    xcodebuild build-for-testing \\
        -project "$PROJECT" \\
        -scheme "$SCHEME" \\
        -destination "platform=iOS Simulator,name=$DEVICE_NAME,OS=$DEVICE_OS" \\
        -derivedDataPath "$DERIVED_DATA" \\
        CODE_SIGNING_ALLOWED=NO \\
        -quiet 2>&1 || {
            echo "❌ Build failed for $DEVICE_NAME"
            exit 1
        }
    echo "✅ Build complete for $DEVICE_NAME"
    echo ""
done

# Boot simulators and pre-grant notification permissions
for device_spec in "\${DEVICES[@]}"; do
    IFS='|' read -r DEVICE_NAME _ _ _ <<< "$device_spec"
    echo "🚀 Booting $DEVICE_NAME simulator..."
    xcrun simctl boot "$DEVICE_NAME" 2>/dev/null || true
done
sleep 3
for device_spec in "\${DEVICES[@]}"; do
    IFS='|' read -r DEVICE_NAME _ _ _ <<< "$device_spec"
    xcrun simctl privacy "$DEVICE_NAME" grant notifications "$BUNDLE_ID" 2>/dev/null || true
done

# Capture screenshots
for device_spec in "\${DEVICES[@]}"; do
    IFS='|' read -r DEVICE_NAME DEVICE_OS DEVICE_FOLDER TEST_METHOD <<< "$device_spec"

    for LANG in "\${LANGUAGES[@]}"; do
        CURRENT_RUN=$((CURRENT_RUN + 1))
        echo "📸 [$CURRENT_RUN/$TOTAL_RUNS] $LANG on $DEVICE_NAME..."

        write_config "$LANG" "$DEVICE_FOLDER" "$SCREENSHOTS_DIR"

        if xcodebuild test-without-building \\
            -project "$PROJECT" \\
            -scheme "$SCHEME" \\
            -destination "platform=iOS Simulator,name=$DEVICE_NAME,OS=$DEVICE_OS" \\
            -derivedDataPath "$DERIVED_DATA" \\
            -only-testing:"${targetName}UITests/ScreenshotTests/$TEST_METHOD" \\
            CODE_SIGNING_ALLOWED=NO \\
            -quiet 2>&1; then
            echo "   ✅ $LANG / $DEVICE_FOLDER complete"
        else
            echo "   ⚠️  $LANG / $DEVICE_FOLDER had failures (screenshots may still be saved)"
            FAILED+=("$LANG/$DEVICE_FOLDER")
        fi
    done
done

# Clean up config files
rm -f "$CONFIG_FILE_PROJECT" "$CONFIG_FILE_TMP"

# Summary
echo ""
echo "=========================================="
echo "  Screenshot Capture Complete"
echo "=========================================="

TOTAL_SCREENSHOTS=$(find "$SCREENSHOTS_DIR" -name "*.png" -newer "$PROJECT_DIR/take_screenshots.sh" 2>/dev/null | wc -l | tr -d ' ')
echo "  Screenshots captured: $TOTAL_SCREENSHOTS"
echo "  Output directory: $SCREENSHOTS_DIR/"
echo ""

for LANG in "\${LANGUAGES[@]}"; do
    for device_spec in "\${DEVICES[@]}"; do
        IFS='|' read -r _ _ DEVICE_FOLDER _ <<< "$device_spec"
        DIR="$SCREENSHOTS_DIR/$LANG/$DEVICE_FOLDER"
        if [[ -d "$DIR" ]]; then
            COUNT=$(ls "$DIR"/*.png 2>/dev/null | wc -l | tr -d ' ')
            echo "  $LANG/$DEVICE_FOLDER: $COUNT screenshots"
        fi
    done
done

if [[ \${#FAILED[@]} -gt 0 ]]; then
    echo ""
    echo "⚠️  Runs with failures:"
    for f in "\${FAILED[@]}"; do
        echo "  - $f"
    done
fi

echo ""
echo "Done! Upload screenshots to App Store Connect via Transporter or the web UI."
`;
}

/**
 * Generate generic macOS screenshot capture script.
 * Accepts (targetName, bundleId) for uniform calling — bundleId unused here.
 */
export function generateMacScreenshotScript(targetName, _bundleId) {
  return `#!/bin/bash
#
# take_screenshots_macos.sh — Capture macOS App Store screenshots for all languages.
#
# Prerequisites:
#   Your terminal app needs TWO macOS permissions (System Settings → Privacy & Security):
#     1. Screen Recording — to capture the app window
#     2. Accessibility — to navigate the sidebar via AppleScript
#   Grant these, then re-run the script.
#
# Usage:
#   ./take_screenshots_macos.sh              # all languages
#   ./take_screenshots_macos.sh en de        # specific languages
#

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$PROJECT_DIR/${targetName}.xcodeproj"
SCHEME="${targetName} macOS"
SCREENSHOTS_DIR="$PROJECT_DIR/screenshots"
DERIVED_DATA="$PROJECT_DIR/.build/DerivedData"
APP_PATH="$DERIVED_DATA/Build/Products/Debug/${targetName}.app"

# Supported languages (add your app's localizations here)
ALL_LANGUAGES=("en")

# Currency per locale
${CURRENCY_CASE_BLOCK}

# Parse arguments
LANGUAGES=()
for arg in "$@"; do
    case "$arg" in
        --help|-h)
            echo "Usage: $0 [lang1 lang2 ...]"
            echo "Languages: \${ALL_LANGUAGES[*]}"
            echo ""
            echo "Requires Screen Recording + Accessibility permissions for your terminal."
            exit 0
            ;;
        *) LANGUAGES+=("$arg") ;;
    esac
done
[[ \${#LANGUAGES[@]} -eq 0 ]] && LANGUAGES=("\${ALL_LANGUAGES[@]}")

# macOS App Store screenshot size: 1280x800 minimum, Retina preferred
WINDOW_WIDTH=1440
WINDOW_HEIGHT=900

echo "=========================================="
echo "  ${targetName} macOS Screenshot Capture"
echo "=========================================="
echo "  Languages: \${LANGUAGES[*]}"
echo "  Window: \${WINDOW_WIDTH}x\${WINDOW_HEIGHT}"
echo "  Output: $SCREENSHOTS_DIR/{locale}/macos/"
echo "=========================================="
echo ""

# Build macOS app
echo "🔨 Building macOS app..."
xcodebuild build \\
    -project "$PROJECT" \\
    -scheme "$SCHEME" \\
    -derivedDataPath "$DERIVED_DATA" \\
    CODE_SIGNING_ALLOWED=NO \\
    -quiet 2>&1 || {
        echo "❌ Build failed"
        exit 1
    }
echo "✅ Build complete"
echo ""

if [[ ! -d "$APP_PATH" ]]; then
    echo "❌ App not found at $APP_PATH"
    exit 1
fi

# Get window ID via CGWindowListCopyWindowInfo
get_window_id() {
    swift -e '
    import Cocoa
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
    for w in windowList {
        let owner = w[kCGWindowOwnerName as String] as? String ?? ""
        if owner == "${targetName}" {
            if let num = w[kCGWindowNumber as String] as? Int { print(num); break }
        }
    }
    ' 2>/dev/null
}

# Position and resize window
setup_window() {
    osascript -e "
    tell application \\"System Events\\"
        tell process \\"${targetName}\\"
            if (count of windows) > 0 then
                set position of first window to {100, 100}
                set size of first window to {\${WINDOW_WIDTH}, \${WINDOW_HEIGHT}}
            end if
        end tell
    end tell" 2>/dev/null
}

# Click a sidebar item by row number
click_sidebar() {
    local row="$1"
    osascript -e "
    tell application \\"System Events\\"
        tell process \\"${targetName}\\"
            tell outline 1 of scroll area 1 of group 1 of splitter group 1 of group 1 of window 1
                select row $row
            end tell
        end tell
    end tell" 2>/dev/null || true
}

# Click at a position in the window (relative to window top-left, in points)
click_at() {
    local x="$1" y="$2"
    osascript -e "
    tell application \\"${targetName}\\" to activate
    tell application \\"System Events\\"
        tell process \\"${targetName}\\"
            set winPos to position of window 1
            set absX to (item 1 of winPos) + $x
            set absY to (item 2 of winPos) + $y
            click at {absX, absY}
        end tell
    end tell" 2>/dev/null || true
}

# Go back via Cmd+[ keyboard shortcut
go_back() {
    osascript -e '
    tell application "${targetName}" to activate
    delay 0.3
    tell application "System Events"
        key code 33 using command down
    end tell' 2>/dev/null || true
}

# Take screenshot of the app window
capture_window() {
    local output_path="$1"
    osascript -e 'tell application "${targetName}" to activate' 2>/dev/null
    sleep 0.5
    local wid
    wid=$(get_window_id)
    if [[ -n "$wid" ]]; then
        screencapture -l "$wid" -o -x "$output_path" 2>/dev/null
    else
        screencapture -R "100,100,\${WINDOW_WIDTH},\${WINDOW_HEIGHT}" -o -x "$output_path" 2>/dev/null
    fi
}

# Capture screenshots for one language
capture_locale() {
    local lang="$1"
    local currency
    currency=$(currency_for_locale "$lang")
    local out_dir="$SCREENSHOTS_DIR/$lang/macos"
    mkdir -p "$out_dir"

    echo "📸 Capturing $lang (currency: $currency)..."

    # Kill any existing instance
    killall "${targetName}" 2>/dev/null || true
    sleep 1

    # Launch with locale settings
    # Customize these args for your app's launch parameters
    open "$APP_PATH" --args \\
        -AppleLanguages "($lang)" \\
        -AppleLocale "$lang"

    sleep 4
    setup_window
    sleep 1

    # Capture the main screen
    # Add additional captures here for your app's screens:
    #   click_sidebar 1  → capture_window "$out_dir/01_home.png"
    #   click_sidebar 2  → capture_window "$out_dir/02_list.png"
    #   etc.
    capture_window "$out_dir/01_home.png"

    # Quit
    killall "${targetName}" 2>/dev/null || true
    sleep 1

    local count
    count=$(ls "$out_dir"/*.png 2>/dev/null | wc -l | tr -d ' ')
    echo "   ✅ $lang/macos: $count screenshots"
}

# Capture all locales
FAILED=()
for lang in "\${LANGUAGES[@]}"; do
    if ! capture_locale "$lang"; then
        FAILED+=("$lang")
    fi
done

echo ""
echo "=========================================="
echo "  macOS Screenshot Capture Complete"
echo "=========================================="
for lang in "\${LANGUAGES[@]}"; do
    dir="$SCREENSHOTS_DIR/$lang/macos"
    if [[ -d "$dir" ]]; then
        count=$(ls "$dir"/*.png 2>/dev/null | wc -l | tr -d ' ')
        echo "  $lang/macos: $count screenshots"
    fi
done

if [[ \${#FAILED[@]} -gt 0 ]]; then
    echo ""
    echo "⚠️  Failed: \${FAILED[*]}"
fi

echo ""
echo "Done! Upload to App Store Connect under the macOS platform."
echo "If sidebar navigation failed, grant Accessibility permission to your terminal."
`;
}

/**
 * Management scripts that should exist in an Xcode project.
 * Used by scaffold for generation and health check for detection.
 */
export const XCODE_MANAGEMENT_SCRIPTS = [
  { name: 'deploy.sh', description: 'TestFlight deployment', generator: generateDeployScript },
  { name: 'take_screenshots.sh', description: 'iOS/iPad screenshot automation', generator: generateScreenshotScript },
  { name: 'take_screenshots_macos.sh', description: 'macOS screenshot automation', generator: generateMacScreenshotScript }
];

/**
 * Check which management scripts are missing from an Xcode app's repo.
 * Returns { missing: [{name, description}], present: [{name, description}] }
 */
export function checkScripts(app) {
  if (!app?.repoPath || !NON_PM2_TYPES.has(app.type)) {
    return { missing: [], present: [] };
  }

  const missing = [];
  const present = [];

  for (const script of XCODE_MANAGEMENT_SCRIPTS) {
    const path = join(app.repoPath, script.name);
    if (existsSync(path)) {
      present.push({ name: script.name, description: script.description });
    } else {
      missing.push({ name: script.name, description: script.description });
    }
  }

  return { missing, present };
}

/**
 * Derive the target name and bundle ID from an Xcode project at repoPath.
 * Checks project.yml first, then falls back to .xcodeproj name, then app name.
 */
async function deriveProjectInfo(repoPath, appName) {
  const projectYml = join(repoPath, 'project.yml');
  if (existsSync(projectYml)) {
    const content = await readFile(projectYml, 'utf-8');
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const bundleMatch = content.match(/PRODUCT_BUNDLE_IDENTIFIER:\s*(.+)$/m);
    return {
      targetName: nameMatch?.[1]?.trim() || toTargetName(appName),
      bundleId: bundleMatch?.[1]?.trim() || toBundleId(appName)
    };
  }

  // Try .xcodeproj directory name
  const { stdout } = await execAsync('ls -d *.xcodeproj 2>/dev/null || true', { cwd: repoPath });
  const xcodeproj = stdout.trim().split('\n')[0];
  if (xcodeproj) {
    const target = xcodeproj.replace('.xcodeproj', '');
    return { targetName: target, bundleId: toBundleId(target) };
  }

  return { targetName: toTargetName(appName), bundleId: toBundleId(appName) };
}

/**
 * Install missing management scripts into an Xcode app's repo.
 * Only installs scripts that don't already exist (never overwrites).
 */
export async function installScripts(app, scriptNames) {
  if (!app?.repoPath || !NON_PM2_TYPES.has(app.type)) {
    return { installed: [], skipped: [], errors: ['Not an Xcode app'] };
  }

  const { targetName, bundleId } = await deriveProjectInfo(app.repoPath, app.name);

  const installed = [];
  const skipped = [];
  const errors = [];
  const installedPaths = [];

  for (const scriptName of scriptNames) {
    const scriptDef = XCODE_MANAGEMENT_SCRIPTS.find(s => s.name === scriptName);
    if (!scriptDef) {
      errors.push(`Unknown script: ${scriptName}`);
      continue;
    }

    const destPath = join(app.repoPath, scriptName);
    if (existsSync(destPath)) {
      skipped.push(scriptName);
      continue;
    }

    await writeFile(destPath, scriptDef.generator(targetName, bundleId));
    installedPaths.push(destPath);
    installed.push(scriptName);
  }

  // Batch chmod for all installed scripts
  if (installedPaths.length) {
    await execAsync(`chmod +x ${installedPaths.map(p => `"${p}"`).join(' ')}`, { windowsHide: true });
  }

  // Create .env.example if deploy.sh was installed and none exists
  if (installed.includes('deploy.sh') && !existsSync(join(app.repoPath, '.env.example'))) {
    await writeFile(join(app.repoPath, '.env.example'), XCODE_ENV_EXAMPLE);
  }

  return { installed, skipped, errors };
}
