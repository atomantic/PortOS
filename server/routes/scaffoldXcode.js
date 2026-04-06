import { writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ensureDir, ensureDirs } from '../lib/fileUtils.js';
import {
  XCODE_TEAM_ID, XCODE_BUNDLE_PREFIX, XCODE_ENV_EXAMPLE,
  toBundleId, toTargetName,
  generateDeployScript, generateScreenshotScript, generateMacScreenshotScript
} from '../services/xcodeScripts.js';

const execAsync = promisify(exec);

/**
 * Scaffold a multi-platform Xcode project (iOS + macOS + watchOS)
 * with XcodeGen, deploy script, and screenshot automation.
 */
export async function scaffoldXcode(repoPath, name, dirName, addStep) {
  const bundleId = toBundleId(name);
  const teamId = XCODE_TEAM_ID;
  const targetName = toTargetName(name);
  const watchTarget = `${targetName}_Watch`;

  // project.yml — XcodeGen source of truth with iOS, macOS, and watchOS targets
  await writeFile(join(repoPath, 'project.yml'), `name: ${targetName}
options:
  bundleIdPrefix: ${XCODE_BUNDLE_PREFIX}
  deploymentTarget:
    iOS: "17.0"
    macOS: "14.0"
    watchOS: "10.0"
  xcodeVersion: "16.0"
  generateEmptyDirectories: true

settings:
  base:
    DEVELOPMENT_TEAM: ${teamId}
    MARKETING_VERSION: "1.0.0"
    CURRENT_PROJECT_VERSION: 1
    SWIFT_VERSION: "5.9"

targets:
  # --- iOS Target ---
  ${targetName}:
    type: application
    platform: iOS
    sources:
      - path: ${targetName}
        excludes:
          - Preview Content/PreviewAssets.xcassets
      - path: ${targetName}/Preview Content/PreviewAssets.xcassets
        buildPhase: none
      - path: Shared
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
        - ${targetName}UITests

  # --- macOS Target ---
  ${targetName} macOS:
    type: application
    platform: macOS
    sources:
      - path: ${targetName}
        excludes:
          - Preview Content/PreviewAssets.xcassets
          - Info.plist
      - path: Shared
    entitlements:
      path: ${targetName}-macOS.entitlements
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}
        PRODUCT_NAME: ${targetName}
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        INFOPLIST_KEY_ITSAppUsesNonExemptEncryption: NO
        GENERATE_INFOPLIST_FILE: true

  # --- watchOS Target ---
  ${watchTarget}:
    type: application
    platform: watchOS
    sources:
      - path: ${watchTarget}
      - path: Shared
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}.watchkitapp
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        INFOPLIST_KEY_WKCompanionAppBundleIdentifier: ${bundleId}
        GENERATE_INFOPLIST_FILE: true
    dependencies:
      - target: ${targetName}
        embed: false

  # --- Unit Tests ---
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

  # --- UI Tests (screenshot automation) ---
  ${targetName}UITests:
    type: bundle.ui-testing
    platform: iOS
    sources:
      - path: ${targetName}UITests
    dependencies:
      - target: ${targetName}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}UITests
        GENERATE_INFOPLIST_FILE: true
        TEST_TARGET_NAME: ${targetName}
`);

  // Create source directories
  const srcDir = join(repoPath, targetName);
  const sharedDir = join(repoPath, 'Shared');
  const watchDir = join(repoPath, watchTarget);
  const previewDir = join(srcDir, 'Preview Content');
  const testsDir = join(repoPath, `${targetName}Tests`);
  const uiTestsDir = join(repoPath, `${targetName}UITests`);

  await ensureDirs([srcDir, sharedDir, watchDir, previewDir, testsDir, uiTestsDir]);

  // Info.plist (iOS)
  await writeFile(join(srcDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
`);

  // macOS entitlements
  await writeFile(join(repoPath, `${targetName}-macOS.entitlements`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
</dict>
</plist>
`);

  // Shared module (cross-platform models/logic)
  await writeFile(join(sharedDir, 'AppConstants.swift'), `import Foundation

enum AppConstants {
    static let appName = "${targetName}"
    static let bundleId = "${bundleId}"
}
`);

  // iOS/macOS App entry point (multi-platform)
  await writeFile(join(srcDir, `${targetName}App.swift`), `import SwiftUI

@main
struct ${targetName}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        #if os(macOS)
        .defaultSize(width: 900, height: 600)
        #endif
    }
}
`);

  // ContentView with platform conditionals
  await writeFile(join(srcDir, 'ContentView.swift'), `import SwiftUI

struct ContentView: View {
    var body: some View {
        #if os(macOS)
        NavigationSplitView {
            List {
                NavigationLink("Home", destination: HomeView())
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
        } detail: {
            HomeView()
        }
        #else
        NavigationStack {
            HomeView()
        }
        #endif
    }
}

struct HomeView: View {
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "app.fill")
                .font(.system(size: 60))
                .foregroundStyle(.blue)

            Text(AppConstants.appName)
                .font(.largeTitle)
                .fontWeight(.bold)

            Text("Built with PortOS")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .navigationTitle(AppConstants.appName)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
`);

  // watchOS App
  await writeFile(join(watchDir, `${watchTarget}App.swift`), `import SwiftUI

@main
struct ${watchTarget}App: App {
    var body: some Scene {
        WindowGroup {
            WatchContentView()
        }
    }
}
`);

  await writeFile(join(watchDir, 'WatchContentView.swift'), `import SwiftUI

struct WatchContentView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "app.fill")
                .font(.title)
                .foregroundStyle(.blue)

            Text(AppConstants.appName)
                .font(.headline)
        }
    }
}
`);

  // Asset catalogs
  await ensureDir(join(srcDir, 'Assets.xcassets', 'AppIcon.appiconset'));
  await writeFile(join(srcDir, 'Assets.xcassets', 'Contents.json'), '{"info":{"version":1,"author":"xcode"}}');
  await writeFile(join(srcDir, 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'), `{
  "images": [{"idiom": "universal", "platform": "ios", "size": "1024x1024"}],
  "info": {"version": 1, "author": "xcode"}
}`);

  await ensureDir(join(watchDir, 'Assets.xcassets', 'AppIcon.appiconset'));
  await writeFile(join(watchDir, 'Assets.xcassets', 'Contents.json'), '{"info":{"version":1,"author":"xcode"}}');
  await writeFile(join(watchDir, 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'), `{
  "images": [{"idiom": "universal", "platform": "watchos", "size": "1024x1024"}],
  "info": {"version": 1, "author": "xcode"}
}`);

  await ensureDir(join(previewDir, 'PreviewAssets.xcassets'));
  await writeFile(join(previewDir, 'PreviewAssets.xcassets', 'Contents.json'), '{"info":{"version":1,"author":"xcode"}}');

  // Unit tests
  await writeFile(join(testsDir, `${targetName}Tests.swift`), `import XCTest
@testable import ${targetName}

final class ${targetName}Tests: XCTestCase {
    func testAppLaunches() {
        XCTAssertTrue(true, "App scaffold is functional")
    }
}
`);

  // UI Tests with screenshot stubs
  await writeFile(join(uiTestsDir, 'ScreenshotTests.swift'), `import XCTest

final class ScreenshotTests: XCTestCase {

    private var app: XCUIApplication!
    private var config: [String: Any] = [:]

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()

        let projectPath = ProcessInfo.processInfo.environment["PROJECT_DIR"]
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().path
        let configPaths = [
            "\\(projectPath)/.screenshot_config.json",
            "/tmp/${targetName.toLowerCase()}_screenshot_config.json"
        ]

        for path in configPaths {
            if let data = FileManager.default.contents(atPath: path),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                config = json
                break
            }
        }

        if let locale = config["locale"] as? String {
            app.launchArguments += ["-AppleLanguages", "(\\(locale))", "-AppleLocale", locale]
        }
        if let currency = config["currency"] as? String {
            app.launchArguments += ["-currencyCode", currency]
        }
    }

    // MARK: - iPhone Screenshots

    func testCaptureIPhoneScreenshots() throws {
        app.launch()
        let outputDir = screenshotOutputDir(device: config["device"] as? String ?? "iphone_6.7")
        let targetScreen = config["target_screen"] as? String ?? ""

        if targetScreen.isEmpty || targetScreen == "01_home" {
            takeScreenshot(named: "01_home", outputDir: outputDir)
        }
    }

    // MARK: - iPad Screenshots

    func testCaptureIPadScreenshots() throws {
        app.launch()
        let outputDir = screenshotOutputDir(device: config["device"] as? String ?? "ipad_13")
        let targetScreen = config["target_screen"] as? String ?? ""

        if targetScreen.isEmpty || targetScreen == "01_home" {
            takeScreenshot(named: "01_home", outputDir: outputDir)
        }
    }

    // MARK: - Helpers

    private func screenshotOutputDir(device: String) -> String {
        let base = config["output_dir"] as? String ?? "screenshots"
        let locale = config["locale"] as? String ?? "en"
        return "\\(base)/\\(locale)/\\(device)"
    }

    private func takeScreenshot(named name: String, outputDir: String) {
        let screenshot = app.screenshot()
        let fm = FileManager.default
        try? fm.createDirectory(atPath: outputDir, withIntermediateDirectories: true, attributes: nil)
        let path = "\\(outputDir)/\\(name).png"
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: path))
    }
}
`);

  // .env.example
  await writeFile(join(repoPath, '.env.example'), XCODE_ENV_EXAMPLE);

  // Scripts (from generators in xcodeScripts service)
  await writeFile(join(repoPath, 'deploy.sh'), generateDeployScript(targetName, bundleId));
  await writeFile(join(repoPath, 'take_screenshots.sh'), generateScreenshotScript(targetName, bundleId));
  await writeFile(join(repoPath, 'take_screenshots_macos.sh'), generateMacScreenshotScript(targetName, bundleId));

  await Promise.all([
    chmod(join(repoPath, 'deploy.sh'), 0o755),
    chmod(join(repoPath, 'take_screenshots.sh'), 0o755),
    chmod(join(repoPath, 'take_screenshots_macos.sh'), 0o755),
  ]);

  // CLAUDE.md
  await writeFile(join(repoPath, 'CLAUDE.md'), `# ${name}

Multi-platform native app built with SwiftUI (iOS + macOS + watchOS) and XcodeGen.

## Tech Stack

- **SwiftUI** + **SwiftData** (iOS 17.0+, macOS 14.0+, watchOS 10.0+)
- **XcodeGen** for project generation (\`project.yml\` is the source of truth, not the \`.xcodeproj\`)
- Bundle ID: \`${bundleId}\`, Team: \`${teamId}\`

## Build Commands

\`\`\`bash
# Generate Xcode project (required after changing project.yml)
xcodegen generate

# Build iOS
xcodebuild build -project ${targetName}.xcodeproj -scheme ${targetName} \\
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO

# Build macOS
xcodebuild build -project ${targetName}.xcodeproj -scheme "${targetName} macOS" \\
  CODE_SIGNING_ALLOWED=NO

# Run tests
xcodebuild test -project ${targetName}.xcodeproj -scheme ${targetName} \\
  -only-testing:${targetName}Tests \\
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
\`\`\`

## TestFlight Deployment

Local deploy via \`./deploy.sh\`:

\`\`\`bash
./deploy.sh              # iOS only (default)
./deploy.sh --macos      # macOS only
./deploy.sh --watch      # watchOS only
./deploy.sh --all        # all platforms
./deploy.sh --skip-tests # skip tests for faster iteration
\`\`\`

Requires \`.env\` file with App Store Connect API credentials (see \`.env.example\`).

## Screenshot Automation

\`\`\`bash
./take_screenshots.sh              # iOS/iPad, all languages
./take_screenshots.sh en           # single language
./take_screenshots.sh --iphone-only
./take_screenshots_macos.sh        # macOS screenshots
\`\`\`

Screenshots are saved to \`screenshots/{locale}/{device}/\` for upload to App Store Connect.
`);

  addStep('Create multi-platform Xcode project', 'done');

  // Run xcodegen if available
  const { stderr: xgenErr } = await execAsync('xcodegen generate', { cwd: repoPath, windowsHide: true })
    .catch(err => ({ stderr: err.message }));

  if (xgenErr && !xgenErr.includes('Created project')) {
    addStep('Generate Xcode project', 'error', xgenErr);
  } else {
    addStep('Generate Xcode project', 'done');
  }
}
