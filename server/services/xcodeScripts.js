import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Xcode-based app types (excludes 'swift' which is SPM-only, no .xcodeproj)
const XCODE_TYPES = new Set(['ios-native', 'macos-native', 'xcode']);

// Shared Xcode project constants
export const XCODE_TEAM_ID = 'TYQ32QCF6K';
export const XCODE_BUNDLE_PREFIX = 'net.shadowpuppet';
export const toBundleId = (name) => {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '');
  return `${XCODE_BUNDLE_PREFIX}.${sanitized || 'app'}`;
};
/**
 * Convert an arbitrary app name into a valid Swift / Xcode target identifier.
 * Identifiers must start with a letter or underscore and contain only
 * [A-Za-z0-9_]. Names that sanitize to empty or start with a digit are
 * prefixed with `App` so the generated Swift compiles cleanly.
 */
export const toTargetName = (name) => {
  const sanitized = (name ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!sanitized) return 'App';
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `App_${sanitized}`;
};

// Quote values that contain spaces because deploy.sh sources this file with
// `source .env`; an unquoted value with spaces would be split on whitespace.
export const XCODE_ENV_EXAMPLE = `TEAM_ID=${XCODE_TEAM_ID}
APPSTORE_API_KEY_ID=YOUR_KEY_ID
APPSTORE_ISSUER_ID=YOUR_ISSUER_ID
APPSTORE_API_PRIVATE_KEY_PATH="~/Library/Mobile Documents/com~apple~CloudDocs/AppDev/AuthKey_XXXXXXXXXX.p8"
`;

/**
 * Generate the generic deploy.sh script content.
 *
 * Produces a self-contained, universal TestFlight deployment script that:
 *   - Supports --ios, --macos, --watch, --all, --skip-tests flags
 *   - Defaults to every platform the project has a scheme for ("all available")
 *   - Auto-detects scheme naming conventions (TargetName vs TargetName_iOS,
 *     "TargetName macOS" vs TargetName_macOS, etc.)
 *   - Works with both XcodeGen (project.yml) and raw .xcodeproj projects
 *   - Rolls back the build-number bump if deploy fails, so a failed upload
 *     doesn't permanently consume a build number
 *   - Runs uploads serially with a 60s gap between each to avoid Apple's CDN
 *     rejecting concurrent uploads from the same API key
 *   - Greps altool output for DEFINITIVE failure banners only (never plain
 *     "ERROR: " — altool emits normal multipart-retry events as ERROR lines)
 */
export function generateDeployScript(targetName, _bundleId) {
  return `#!/bin/bash
set -euo pipefail

# ${targetName} - Local TestFlight Deploy
#
# Usage: ./deploy.sh [--skip-tests] [--ios] [--macos] [--watch] [--all]
#
#   Default (no platform flag): every platform the project has a scheme for.
#   --ios / --macos / --watch : single platform
#   --all                     : explicit "all available" (same as default)
#
# Uploads are serial with a 60s gap between each to avoid Apple's CDN
# rejecting concurrent uploads from the same API key.

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
# Expand ~ to $HOME (~ doesn't expand inside double quotes)
KEY_PATH="\${KEY_PATH/#~/\$HOME}"

if [ ! -f "$KEY_PATH" ]; then
    echo "❌ API key not found at: $KEY_PATH"
    exit 1
fi

# altool only looks in ~/.private_keys/ for the API key — symlink it in.
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
APP_NAME="${targetName}"

# Scheme name candidates. Auto-detected against \`xcodebuild -list\` so the
# same template works regardless of whether the project uses "TargetName" /
# "TargetName macOS" / "TargetName_Watch" (PortOS scaffold convention) or
# "TargetName_iOS" / "TargetName_macOS" / "TargetName_watchOS" (common
# hand-rolled convention).
SCHEME_IOS_CANDIDATES=("${targetName}" "${targetName}_iOS")
SCHEME_MACOS_CANDIDATES=("${targetName} macOS" "${targetName}_macOS")
SCHEME_WATCH_CANDIDATES=("${targetName}_Watch" "${targetName}_watchOS" "${targetName} watchOS")
TEST_BUNDLE_CANDIDATES=("${targetName}Tests" "${targetName}Tests_iOS")

AVAILABLE_SCHEMES=$(xcodebuild -project "$PROJECT" -list 2>/dev/null || true)
resolve_scheme() {
    local name
    for name in "$@"; do
        if echo "$AVAILABLE_SCHEMES" | grep -qxE "[[:space:]]*$name"; then
            echo "$name"
            return 0
        fi
    done
    return 1
}
SCHEME_IOS=$(resolve_scheme "\${SCHEME_IOS_CANDIDATES[@]}" || true)
SCHEME_MACOS=$(resolve_scheme "\${SCHEME_MACOS_CANDIDATES[@]}" || true)
SCHEME_WATCH=$(resolve_scheme "\${SCHEME_WATCH_CANDIDATES[@]}" || true)
SCHEME_TEST="$SCHEME_IOS"                           # tests always use iOS sim

HAS_IOS=false;   [ -n "$SCHEME_IOS" ]   && HAS_IOS=true
HAS_MACOS=false; [ -n "$SCHEME_MACOS" ] && HAS_MACOS=true
HAS_WATCH=false; [ -n "$SCHEME_WATCH" ] && HAS_WATCH=true

# Parse flags. Explicit per-platform flags are separate from the --all / default
# fan-out so we can hard-error on an explicit flag naming a missing scheme but
# silently skip missing schemes under --all.
SKIP_TESTS=false
BUILD_IOS=false
BUILD_MACOS=false
BUILD_WATCH=false
EXPLICIT_IOS=false
EXPLICIT_MACOS=false
EXPLICIT_WATCH=false
FAN_OUT=false
for arg in "$@"; do
    case "$arg" in
        --skip-tests) SKIP_TESTS=true ;;
        --ios)   EXPLICIT_IOS=true ;;
        --macos) EXPLICIT_MACOS=true ;;
        --watch) EXPLICIT_WATCH=true ;;
        --all)   FAN_OUT=true ;;
    esac
done

if ! $EXPLICIT_IOS && ! $EXPLICIT_MACOS && ! $EXPLICIT_WATCH && ! $FAN_OUT; then
    FAN_OUT=true
fi
if $FAN_OUT; then
    $HAS_IOS   && BUILD_IOS=true
    $HAS_MACOS && BUILD_MACOS=true
    $HAS_WATCH && BUILD_WATCH=true
fi
if $EXPLICIT_IOS;   then $HAS_IOS   || { echo "❌ No iOS scheme found (tried: \${SCHEME_IOS_CANDIDATES[*]})"; exit 1; }; BUILD_IOS=true;   fi
if $EXPLICIT_MACOS; then $HAS_MACOS || { echo "❌ No macOS scheme found (tried: \${SCHEME_MACOS_CANDIDATES[*]})"; exit 1; }; BUILD_MACOS=true; fi
if $EXPLICIT_WATCH; then $HAS_WATCH || { echo "❌ No watchOS scheme found (tried: \${SCHEME_WATCH_CANDIDATES[*]})"; exit 1; }; BUILD_WATCH=true; fi

if ! $BUILD_IOS && ! $BUILD_MACOS && ! $BUILD_WATCH; then
    echo "❌ No platforms to build — project has no recognized schemes."
    exit 1
fi

MSG="🎯 Deploying to:"
if $BUILD_IOS;   then MSG="$MSG iOS";     fi
if $BUILD_MACOS; then MSG="$MSG macOS";   fi
if $BUILD_WATCH; then MSG="$MSG watchOS"; fi
echo "$MSG"

# Auto-increment build number. Snapshot the file(s) first so we can roll back
# on any failure and not permanently consume a build number that never shipped
# to TestFlight. Snapshot via cp rather than \`git checkout --\` so any
# pre-existing uncommitted edits in the operator's working tree are preserved.
ORIG_PBXPROJ=$(mktemp)
cp "$PROJECT/project.pbxproj" "$ORIG_PBXPROJ"
ORIG_PROJECT_YML=""
if [ "$PROJECT_MODE" = "xcodegen" ]; then
    ORIG_PROJECT_YML=$(mktemp)
    cp project.yml "$ORIG_PROJECT_YML"
fi

if [ "$PROJECT_MODE" = "xcodegen" ]; then
    CURRENT_BUILD=$(grep CURRENT_PROJECT_VERSION project.yml | head -1 | awk '{print $2}')
    NEW_BUILD=$((CURRENT_BUILD + 1))
    echo "📦 Build number: $CURRENT_BUILD → $NEW_BUILD"
    /usr/bin/sed -i '' "s/CURRENT_PROJECT_VERSION: \${CURRENT_BUILD}/CURRENT_PROJECT_VERSION: \${NEW_BUILD}/" project.yml
else
    CURRENT_BUILD=$(grep -m1 'CURRENT_PROJECT_VERSION = ' "$PROJECT/project.pbxproj" | awk '{print $3}' | tr -d ';')
    NEW_BUILD=$((CURRENT_BUILD + 1))
    echo "📦 Build number: $CURRENT_BUILD → $NEW_BUILD"
    /usr/bin/sed -i '' "s/CURRENT_PROJECT_VERSION = \${CURRENT_BUILD};/CURRENT_PROJECT_VERSION = \${NEW_BUILD};/g" "$PROJECT/project.pbxproj"
fi

DEPLOY_SUCCESS=false
rollback_build_bump() {
    if [ "$DEPLOY_SUCCESS" = "false" ]; then
        echo "↩️  Rolling back build number bump (deploy did not complete)..."
        cp "$ORIG_PBXPROJ" "$PROJECT/project.pbxproj" 2>/dev/null || true
        [ -n "$ORIG_PROJECT_YML" ] && cp "$ORIG_PROJECT_YML" project.yml 2>/dev/null || true
    fi
    rm -f "$ORIG_PBXPROJ"
    [ -n "$ORIG_PROJECT_YML" ] && rm -f "$ORIG_PROJECT_YML"
}
trap rollback_build_bump EXIT

if [ "$PROJECT_MODE" = "xcodegen" ]; then
    echo "⚙️  Regenerating Xcode project..."
    xcodegen generate
fi

# Tests run on iOS simulator, so only run them when we're actually building
# iOS. If the project is macOS-only or watch-only, skip tests.
if ! $SKIP_TESTS && $BUILD_IOS; then
    echo "🧪 Running tests..."
    DEVICE_ID=$(xcrun simctl list devices available -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
preferred = ['iPhone 17 Pro', 'iPhone 17', 'iPhone 16 Pro', 'iPhone 16', 'iPhone 15']
for name in preferred:
    for runtime, devices in data.get('devices', {}).items():
        for d in devices:
            if d['name'] == name and d.get('isAvailable', False):
                print(d['udid']); sys.exit(0)
for runtime, devices in data.get('devices', {}).items():
    for d in devices:
        if 'iPhone' in d['name'] and d.get('isAvailable', False):
            print(d['udid']); sys.exit(0)
" 2>/dev/null)
    if [ -z "$DEVICE_ID" ]; then
        echo "❌ No available iPhone simulator found for tests"
        exit 1
    fi
    DESTINATION="platform=iOS Simulator,id=$DEVICE_ID"
    echo "📱 Test destination: $DESTINATION"
    # Resolve test bundle name via xcodebuild -list targets, with candidate fallback
    TEST_BUNDLE=""
    AVAILABLE_TARGETS=$(xcodebuild -project "$PROJECT" -list 2>/dev/null || true)
    for candidate in "\${TEST_BUNDLE_CANDIDATES[@]}"; do
        if echo "$AVAILABLE_TARGETS" | grep -qxE "[[:space:]]*$candidate"; then
            TEST_BUNDLE="$candidate"; break
        fi
    done
    TEST_ARGS=(-project "$PROJECT" -scheme "$SCHEME_TEST")
    [ -n "$TEST_BUNDLE" ] && TEST_ARGS+=(-only-testing:"$TEST_BUNDLE")
    TEST_ARGS+=(-destination "$DESTINATION" -configuration Debug CODE_SIGNING_ALLOWED=NO -quiet)
    xcodebuild test "\${TEST_ARGS[@]}"
    echo "✅ Tests passed"
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Shared export options plist (identical for all three platforms: automatic
# signing, app-store-connect method).
EXPORT_PLIST="$BUILD_DIR/exportOptions.plist"
cat > "$EXPORT_PLIST" <<EOF
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

# altool exits 0 even when uploads fail — the failure is buried in its
# stdout XML-ish log. Grep the log for DEFINITIVE failure banners only.
#
# Do NOT grep plain "ERROR: " — altool emits normal multipart upload retry
# events as "ERROR: [ContentDelivery.Uploader...] WILL RETRY PART N" and
# "ERROR: The network connection was lost.", which Apple's uploader recovers
# from internally. Grepping those killed the script mid-recovery on good
# uploads. Use only Apple's terminal-failure banners:
#   - "UPLOAD FAILED"       : Apple's summary banner when retries exhausted
#   - "Validation failed (" : server-side 4xx from App Store Connect
#   - "ERROR ITMS-"         : legacy Apple error code format
#   - "product-errors"      : Apple's structured error output
FAIL_MARKERS="UPLOAD FAILED|Validation failed \\(|ERROR ITMS-|product-errors"

UPLOADED_ONE=false
inter_upload_delay() {
    if $UPLOADED_ONE; then
        echo "⏳ Waiting 60s before next upload to avoid Apple CDN contention..."
        sleep 60
    fi
}

# --- iOS Build & Upload ---
if $BUILD_IOS; then
    ARCHIVE_IOS="$BUILD_DIR/\${APP_NAME}_iOS.xcarchive"
    EXPORT_IOS="$BUILD_DIR/export_ios"

    echo "📦 Archiving iOS..."
    xcodebuild archive \\
        -project "$PROJECT" \\
        -scheme "$SCHEME_IOS" \\
        -configuration Release \\
        -destination 'generic/platform=iOS' \\
        -archivePath "$ARCHIVE_IOS" \\
        CODE_SIGNING_ALLOWED=NO \\
        CODE_SIGN_IDENTITY="" \\
        CODE_SIGNING_REQUIRED=NO \\
        -quiet
    echo "✅ iOS archive complete"

    echo "📤 Exporting iOS IPA..."
    xcodebuild -exportArchive \\
        -archivePath "$ARCHIVE_IOS" \\
        -exportOptionsPlist "$EXPORT_PLIST" \\
        -exportPath "$EXPORT_IOS" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet

    IPA_PATH=$(find "$EXPORT_IOS" -name "*.ipa" | head -1)
    if [ -z "$IPA_PATH" ]; then
        echo "❌ iOS IPA not found in $EXPORT_IOS"
        ls -la "$EXPORT_IOS/"
        exit 1
    fi

    inter_upload_delay
    echo "🚀 Uploading iOS to TestFlight..."
    IOS_UPLOAD_LOG="$BUILD_DIR/ios_upload.log"
    set +e
    xcrun altool --upload-app \\
        --file "$IPA_PATH" \\
        --type ios \\
        --apiKey "$APPSTORE_API_KEY_ID" \\
        --apiIssuer "$APPSTORE_ISSUER_ID" \\
        --transport DAV 2>&1 | tee "$IOS_UPLOAD_LOG"
    IOS_UPLOAD_STATUS=\${PIPESTATUS[0]}
    set -e
    if [ "$IOS_UPLOAD_STATUS" -ne 0 ] || grep -qE "$FAIL_MARKERS" "$IOS_UPLOAD_LOG"; then
        echo "❌ iOS upload failed — see errors above"
        exit 1
    fi
    echo "✅ iOS upload complete!"
    UPLOADED_ONE=true
fi

# --- macOS Build & Upload ---
if $BUILD_MACOS; then
    ARCHIVE_MACOS="$BUILD_DIR/\${APP_NAME}_macOS.xcarchive"
    EXPORT_MACOS="$BUILD_DIR/export_macos"

    echo "📦 Archiving macOS..."
    xcodebuild archive \\
        -project "$PROJECT" \\
        -scheme "$SCHEME_MACOS" \\
        -configuration Release \\
        -destination 'generic/platform=macOS' \\
        -archivePath "$ARCHIVE_MACOS" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet
    echo "✅ macOS archive complete"

    echo "📤 Exporting macOS pkg..."
    xcodebuild -exportArchive \\
        -archivePath "$ARCHIVE_MACOS" \\
        -exportOptionsPlist "$EXPORT_PLIST" \\
        -exportPath "$EXPORT_MACOS" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet

    PKG_PATH=$(find "$EXPORT_MACOS" -name "*.pkg" | head -1)
    if [ -z "$PKG_PATH" ]; then
        echo "❌ macOS package not found in $EXPORT_MACOS"
        ls -la "$EXPORT_MACOS/"
        exit 1
    fi

    inter_upload_delay
    echo "🚀 Uploading macOS to TestFlight..."
    MACOS_UPLOAD_LOG="$BUILD_DIR/macos_upload.log"
    set +e
    xcrun altool --upload-app \\
        --file "$PKG_PATH" \\
        --type macos \\
        --apiKey "$APPSTORE_API_KEY_ID" \\
        --apiIssuer "$APPSTORE_ISSUER_ID" 2>&1 | tee "$MACOS_UPLOAD_LOG"
    MACOS_UPLOAD_STATUS=\${PIPESTATUS[0]}
    set -e
    if [ "$MACOS_UPLOAD_STATUS" -ne 0 ] || grep -qE "$FAIL_MARKERS" "$MACOS_UPLOAD_LOG"; then
        echo "❌ macOS upload failed — see errors above"
        exit 1
    fi
    echo "✅ macOS upload complete!"
    UPLOADED_ONE=true
fi

# --- watchOS Build & Upload ---
# Only applies to STANDALONE watch apps (no iOS companion). Watch extensions
# bundled with an iOS app ship inside the iOS IPA.
if $BUILD_WATCH; then
    ARCHIVE_WATCH="$BUILD_DIR/\${APP_NAME}_watchOS.xcarchive"
    EXPORT_WATCH="$BUILD_DIR/export_watchos"

    echo "📦 Archiving watchOS..."
    xcodebuild archive \\
        -project "$PROJECT" \\
        -scheme "$SCHEME_WATCH" \\
        -configuration Release \\
        -destination 'generic/platform=watchOS' \\
        -archivePath "$ARCHIVE_WATCH" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet
    echo "✅ watchOS archive complete"

    echo "📤 Exporting watchOS..."
    xcodebuild -exportArchive \\
        -archivePath "$ARCHIVE_WATCH" \\
        -exportOptionsPlist "$EXPORT_PLIST" \\
        -exportPath "$EXPORT_WATCH" \\
        -allowProvisioningUpdates \\
        -authenticationKeyPath "$KEY_PATH" \\
        -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
        -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
        -quiet

    WATCH_IPA=$(find "$EXPORT_WATCH" -name "*.ipa" | head -1)
    if [ -z "$WATCH_IPA" ]; then
        echo "ℹ️  No standalone watchOS IPA (bundled with iOS app) — skipping upload"
    else
        inter_upload_delay
        echo "🚀 Uploading watchOS to TestFlight..."
        WATCH_UPLOAD_LOG="$BUILD_DIR/watchos_upload.log"
        set +e
        # altool --type for standalone watchOS is still "ios" (Apple types: ios, macos, appletvos, visionos)
        xcrun altool --upload-app \\
            --file "$WATCH_IPA" \\
            --type ios \\
            --apiKey "$APPSTORE_API_KEY_ID" \\
            --apiIssuer "$APPSTORE_ISSUER_ID" \\
            --transport DAV 2>&1 | tee "$WATCH_UPLOAD_LOG"
        WATCH_UPLOAD_STATUS=\${PIPESTATUS[0]}
        set -e
        if [ "$WATCH_UPLOAD_STATUS" -ne 0 ] || grep -qE "$FAIL_MARKERS" "$WATCH_UPLOAD_LOG"; then
            echo "❌ watchOS upload failed — see errors above"
            exit 1
        fi
        echo "✅ watchOS upload complete!"
        UPLOADED_ONE=true
    fi
fi

echo "✅ Build $NEW_BUILD submitted to TestFlight."

# Commit the build-number bump only after every upload succeeds, so a failed
# deploy doesn't leave a consumed build number committed to main.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ "$PROJECT_MODE" = "xcodegen" ]; then
        git add project.yml "$PROJECT/project.pbxproj" 2>/dev/null || true
    else
        git add "$PROJECT/project.pbxproj" 2>/dev/null || true
    fi
    if ! git diff --cached --quiet; then
        git commit -m "build: bump to build $NEW_BUILD"
        echo "📝 Committed build number bump"
    fi
fi
DEPLOY_SUCCESS=true

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

# Detect installed iOS simulator runtime version
IOS_VERSION=$(xcrun simctl list runtimes -j 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in sorted(data.get('runtimes', []), key=lambda x: x.get('version', ''), reverse=True):
    if r.get('isAvailable') and 'iOS' in r.get('name', ''):
        print(r['version']); sys.exit(0)
print('18.0')  # safe fallback
" 2>/dev/null)

# App Store Connect screenshot device specs
# Format: "Simulator Name|OS version|folder_name|test_method"
IPHONE_DEVICE="iPhone 16 Pro Max|\${IOS_VERSION}|iphone_6.7|testCaptureIPhoneScreenshots"
IPAD_DEVICE="iPad Pro 13-inch (M4)|\${IOS_VERSION}|ipad_13|testCaptureIPadScreenshots"

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
 * Each script declares which app types it applies to so that platform-specific
 * scripts (e.g. macOS-only screenshot automation) are not required for apps
 * that have no corresponding target.
 *
 * Type semantics:
 *   - 'xcode'        : multi-platform (iOS + macOS + watchOS) — all scripts apply
 *   - 'ios-native'   : iOS only — deploy + iOS screenshots
 *   - 'macos-native' : macOS only — deploy + macOS screenshots
 *
 * Used by scaffold for generation and health check for detection.
 */
export const XCODE_MANAGEMENT_SCRIPTS = [
  {
    name: 'deploy.sh',
    description: 'TestFlight deployment',
    generator: generateDeployScript,
    appTypes: ['xcode', 'ios-native', 'macos-native']
  },
  {
    name: 'take_screenshots.sh',
    description: 'iOS/iPad screenshot automation',
    generator: generateScreenshotScript,
    appTypes: ['xcode', 'ios-native']
  },
  {
    name: 'take_screenshots_macos.sh',
    description: 'macOS screenshot automation',
    generator: generateMacScreenshotScript,
    appTypes: ['xcode', 'macos-native']
  }
];

/**
 * Return the subset of management scripts that apply to a given app type.
 */
export function scriptsForAppType(appType) {
  return XCODE_MANAGEMENT_SCRIPTS.filter(s => s.appTypes.includes(appType));
}

/**
 * The set of script names installable via the API. Used by route validation
 * to fail fast on bogus payloads instead of relying on installScripts to
 * report unknowns one-by-one.
 */
export const XCODE_SCRIPT_NAMES = XCODE_MANAGEMENT_SCRIPTS.map(s => s.name);

/**
 * Check which management scripts are missing from an Xcode app's repo.
 * Only scripts that apply to the app's type are considered.
 * Returns { missing: [{name, description}], present: [{name, description}] }
 */
export function checkScripts(app) {
  if (!app?.repoPath || !XCODE_TYPES.has(app.type) || !existsSync(app.repoPath)) {
    return { missing: [], present: [] };
  }

  const missing = [];
  const present = [];

  for (const script of scriptsForAppType(app.type)) {
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
  if (process.platform === 'win32') {
    return { targetName: toTargetName(appName), bundleId: toBundleId(appName) };
  }

  const projectYml = join(repoPath, 'project.yml');
  if (existsSync(projectYml)) {
    const content = await readFile(projectYml, 'utf-8');
    // Strip wrapping quotes from YAML scalar values
    const stripQuotes = (s) => s?.replace(/^["']|["']$/g, '');
    // Validate parsed values are safe for bash interpolation
    const isValidTarget = (s) => /^[A-Za-z0-9_ -]+$/.test(s);
    const isValidBundleId = (s) => /^[A-Za-z0-9.-]+$/.test(s);
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const rawName = stripQuotes(nameMatch?.[1]?.trim());
    const projectName = rawName && isValidTarget(rawName) ? rawName : null;
    // Find PRODUCT_BUNDLE_IDENTIFIER entries, skip test/watch targets
    const bundleIds = [...content.matchAll(/PRODUCT_BUNDLE_IDENTIFIER:\s*(.+)$/gm)]
      .map(m => stripQuotes(m[1].trim()))
      .filter(id => id && isValidBundleId(id) && !id.includes('Tests') && !id.includes('watchkitapp'));
    const bundleId = bundleIds[0] || (projectName ? toBundleId(projectName) : toBundleId(appName));
    return {
      targetName: projectName || toTargetName(appName),
      bundleId
    };
  }

  // Try .xcodeproj directory name
  const { stdout } = await execAsync('ls -d *.xcodeproj 2>/dev/null || true', { cwd: repoPath });
  const xcodeproj = stdout.trim().split('\n')[0];
  if (xcodeproj) {
    const target = xcodeproj.replace('.xcodeproj', '');
    if (/^[A-Za-z0-9_ -]+$/.test(target)) {
      return { targetName: target, bundleId: toBundleId(target) };
    }
  }

  return { targetName: toTargetName(appName), bundleId: toBundleId(appName) };
}

/**
 * Install missing management scripts into an Xcode app's repo.
 * Only installs scripts that don't already exist (never overwrites).
 */
export async function installScripts(app, scriptNames) {
  if (!app?.repoPath || !XCODE_TYPES.has(app.type)) {
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
    if (!scriptDef.appTypes.includes(app.type)) {
      errors.push(`Script ${scriptName} does not apply to ${app.type} apps`);
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
    if (process.platform === 'win32') {
      errors.push('Scripts installed but chmod is not supported on Windows');
    } else {
      await execFileAsync('chmod', ['+x', ...installedPaths]).catch(err => {
        errors.push(`chmod failed: ${err.message}`);
      });
    }
  }

  // Create .env.example if deploy.sh was installed and none exists
  if (installed.includes('deploy.sh') && !existsSync(join(app.repoPath, '.env.example'))) {
    await writeFile(join(app.repoPath, '.env.example'), XCODE_ENV_EXAMPLE);
  }

  return { installed, skipped, errors };
}
