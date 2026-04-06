import { writeFile } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ensureDir, ensureDirs } from '../lib/fileUtils.js';
import { XCODE_TEAM_ID, toBundleId, toTargetName } from '../services/xcodeScripts.js';

const execAsync = promisify(exec);

export async function scaffoldIOS(repoPath, name, dirName, addStep) {
  const bundleId = toBundleId(name);
  const teamId = XCODE_TEAM_ID;
  const targetName = toTargetName(name);

  // project.yml (XcodeGen source of truth)
  await writeFile(join(repoPath, 'project.yml'), `name: ${targetName}
options:
  bundleIdPrefix: net.shadowpuppet
  deploymentTarget:
    iOS: "17.0"
  xcodeVersion: "16.0"
  generateEmptyDirectories: true

settings:
  base:
    DEVELOPMENT_TEAM: ${teamId}
    MARKETING_VERSION: "1.0.0"
    CURRENT_PROJECT_VERSION: 1
    SWIFT_VERSION: "5.9"

targets:
  ${targetName}:
    type: application
    platform: iOS
    sources:
      - path: ${targetName}
        excludes:
          - Preview Content/PreviewAssets.xcassets
      - path: ${targetName}/Preview Content/PreviewAssets.xcassets
        buildPhase: none
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}
        INFOPLIST_FILE: ${targetName}/Info.plist
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        INFOPLIST_KEY_ITSAppUsesNonExemptEncryption: NO
        INFOPLIST_KEY_UISupportedInterfaceOrientations: "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
        INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad: "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
        INFOPLIST_KEY_UILaunchScreen_Generation: true
        DEVELOPMENT_ASSET_PATHS: "\\"${targetName}/Preview Content\\""
        GENERATE_INFOPLIST_FILE: true
    scheme:
      testTargets:
        - ${targetName}Tests

  ${targetName}Tests:
    type: bundle.unit-test
    platform: iOS
    sources:
      - path: ${targetName}Tests
    dependencies:
      - target: ${targetName}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}Tests
        GENERATE_INFOPLIST_FILE: true
        TEST_HOST: "$(BUILT_PRODUCTS_DIR)/${targetName}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/${targetName}"
        BUNDLE_LOADER: "$(TEST_HOST)"
`);

  // Create source directories
  const srcDir = join(repoPath, targetName);
  const previewDir = join(srcDir, 'Preview Content');
  const testsDir = join(repoPath, `${targetName}Tests`);

  await ensureDirs([srcDir, previewDir, testsDir]);

  // Info.plist
  await writeFile(join(srcDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>This app needs microphone access for audio recording.</string>
</dict>
</plist>
`);

  // App entry point
  await writeFile(join(srcDir, `${targetName}App.swift`), `import SwiftUI

@main
struct ${targetName}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`);

  // ContentView
  await writeFile(join(srcDir, 'ContentView.swift'), `import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "app.fill")
                    .font(.system(size: 60))
                    .foregroundStyle(.blue)

                Text("${name}")
                    .font(.largeTitle)
                    .fontWeight(.bold)

                Text("Built with PortOS")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .navigationTitle("${name}")
        }
    }
}
`);

  // Assets.xcassets
  await ensureDir(join(srcDir, 'Assets.xcassets', 'AppIcon.appiconset'));
  await writeFile(join(srcDir, 'Assets.xcassets', 'Contents.json'), '{"info":{"version":1,"author":"xcode"}}');
  await writeFile(join(srcDir, 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'), `{
  "images": [{"idiom": "universal", "platform": "ios", "size": "1024x1024"}],
  "info": {"version": 1, "author": "xcode"}
}`);

  // Preview Assets
  await ensureDir(join(previewDir, 'PreviewAssets.xcassets'));
  await writeFile(join(previewDir, 'PreviewAssets.xcassets', 'Contents.json'), '{"info":{"version":1,"author":"xcode"}}');

  // Unit test
  await writeFile(join(testsDir, `${targetName}Tests.swift`), `import XCTest
@testable import ${targetName}

final class ${targetName}Tests: XCTestCase {
    func testAppLaunches() {
        XCTAssertTrue(true, "App scaffold is functional")
    }
}
`);

  // .env.example
  await writeFile(join(repoPath, '.env.example'), `TEAM_ID=${teamId}
APPSTORE_API_KEY_ID=YOUR_KEY_ID
APPSTORE_ISSUER_ID=YOUR_ISSUER_ID
APPSTORE_API_PRIVATE_KEY_PATH=~/Library/Mobile Documents/com~apple~CloudDocs/AppDev/AuthKey_XXXXXXXXXX.p8
`);

  // deploy.sh (TestFlight local deploy)
  const deployScript = `#!/bin/bash
set -euo pipefail

# ${name} - Local TestFlight Deploy
# Usage: ./deploy.sh [--skip-tests]

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

# Ensure altool can find the key
mkdir -p ~/.private_keys
KEY_FILENAME="AuthKey_\${APPSTORE_API_KEY_ID}.p8"
if [ ! -f ~/.private_keys/"$KEY_FILENAME" ]; then
    ln -sf "$KEY_PATH" ~/.private_keys/"$KEY_FILENAME"
    echo "🔑 Symlinked API key to ~/.private_keys/"
fi

PROJECT="${targetName}.xcodeproj"
SCHEME="${targetName}"
BUILD_DIR="$SCRIPT_DIR/build"
ARCHIVE_PATH="$BUILD_DIR/$SCHEME.xcarchive"
EXPORT_PATH="$BUILD_DIR/export"

# Auto-increment build number
CURRENT_BUILD=$(grep CURRENT_PROJECT_VERSION project.yml | head -1 | awk '{print $2}')
NEW_BUILD=$((CURRENT_BUILD + 1))
echo "📦 Build number: $CURRENT_BUILD → $NEW_BUILD"
/usr/bin/sed -i '' "s/CURRENT_PROJECT_VERSION: \${CURRENT_BUILD}/CURRENT_PROJECT_VERSION: \${NEW_BUILD}/" project.yml

# Regenerate Xcode project
echo "⚙️  Regenerating Xcode project..."
xcodegen generate

# Run tests (unless skipped)
if [ "\${1:-}" != "--skip-tests" ]; then
    echo "🧪 Running tests..."
    DESTINATION=$(
        if xcrun simctl list devices available | grep -q "iPhone 16"; then
            echo "platform=iOS Simulator,name=iPhone 16"
        elif xcrun simctl list devices available | grep -q "iPhone 15"; then
            echo "platform=iOS Simulator,name=iPhone 15"
        else
            echo "platform=iOS Simulator,name=iPhone 14"
        fi
    )
    xcodebuild test \\
        -project "$PROJECT" \\
        -scheme "$SCHEME" \\
        -only-testing:${targetName}Tests \\
        -destination "$DESTINATION" \\
        -configuration Debug \\
        CODE_SIGNING_ALLOWED=NO \\
        -quiet
    echo "✅ Tests passed"
fi

# Clean build directory
rm -rf "$BUILD_DIR"

# Archive
echo "📦 Archiving..."
xcodebuild archive \\
    -project "$PROJECT" \\
    -scheme "$SCHEME" \\
    -configuration Release \\
    -destination 'generic/platform=iOS' \\
    -archivePath "$ARCHIVE_PATH" \\
    CODE_SIGNING_ALLOWED=NO \\
    CODE_SIGN_IDENTITY="" \\
    CODE_SIGNING_REQUIRED=NO \\
    -quiet

echo "✅ Archive complete"

# Create exportOptions.plist
cat > "$BUILD_DIR/exportOptions.plist" <<EOF
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

# Export IPA
echo "📤 Exporting IPA..."
xcodebuild -exportArchive \\
    -archivePath "$ARCHIVE_PATH" \\
    -exportOptionsPlist "$BUILD_DIR/exportOptions.plist" \\
    -exportPath "$EXPORT_PATH" \\
    -allowProvisioningUpdates \\
    -authenticationKeyPath "$KEY_PATH" \\
    -authenticationKeyID "$APPSTORE_API_KEY_ID" \\
    -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \\
    -quiet

echo "✅ IPA exported"

# Upload to TestFlight
IPA_PATH="$EXPORT_PATH/$SCHEME.ipa"
if [ ! -f "$IPA_PATH" ]; then
    echo "❌ IPA not found at $IPA_PATH"
    ls -la "$EXPORT_PATH/"
    exit 1
fi

echo "🚀 Uploading to TestFlight..."
xcrun altool --upload-app \\
    --file "$IPA_PATH" \\
    --type ios \\
    --apiKey "$APPSTORE_API_KEY_ID" \\
    --apiIssuer "$APPSTORE_ISSUER_ID"

UPLOAD_EXIT=$?
if [ $UPLOAD_EXIT -ne 0 ]; then
    echo "❌ Upload failed with exit code $UPLOAD_EXIT"
    exit $UPLOAD_EXIT
fi

echo "✅ Upload complete! Build $NEW_BUILD submitted to TestFlight."

# Commit the build number bump
git add project.yml "$PROJECT/project.pbxproj"
git commit -m "build: bump to build $NEW_BUILD"
echo "📝 Committed build number bump"

# Clean up
rm -rf "$BUILD_DIR"
echo "🧹 Cleaned build artifacts"
`;
  await writeFile(join(repoPath, 'deploy.sh'), deployScript);
  // Make deploy.sh executable
  await execAsync(`chmod +x "${join(repoPath, 'deploy.sh')}"`, { windowsHide: true });

  // CLAUDE.md
  await writeFile(join(repoPath, 'CLAUDE.md'), `# ${name}

iOS native app built with SwiftUI and XcodeGen.

## Tech Stack

- **SwiftUI** + **SwiftData** (iOS 17.0+)
- **XcodeGen** for project generation (\`project.yml\` is the source of truth, not the \`.xcodeproj\`)
- Bundle ID: \`${bundleId}\`, Team: \`${teamId}\`

## Build Commands

\`\`\`bash
# Generate Xcode project (required after changing project.yml)
xcodegen generate

# Build
xcodebuild build -project ${targetName}.xcodeproj -scheme ${targetName} \\
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO

# Run tests
xcodebuild test -project ${targetName}.xcodeproj -scheme ${targetName} \\
  -only-testing:${targetName}Tests \\
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
\`\`\`

## TestFlight Deployment

Local deploy via \`./deploy.sh\`:

\`\`\`bash
./deploy.sh              # full: tests + archive + upload
./deploy.sh --skip-tests # skip tests for faster iteration
\`\`\`

Requires \`.env\` file with App Store Connect API credentials (see \`.env.example\`).
`);

  addStep('Create iOS project', 'done');

  // Run xcodegen if available
  const { stderr: xgenErr } = await execAsync('xcodegen generate', { cwd: repoPath, windowsHide: true })
    .catch(err => ({ stderr: err.message }));

  if (xgenErr && !xgenErr.includes('Created project')) {
    addStep('Generate Xcode project', 'error', xgenErr);
  } else {
    addStep('Generate Xcode project', 'done');
  }
}
