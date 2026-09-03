import { writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { exec } from '../lib/childProcess.js';
import { promisify } from 'util';
import { ensureDir, ensureDirs } from '../lib/fileUtils.js';
import { writeAgentInstructions } from '../lib/agentInstructionsFile.js';
import {
  XCODE_TEAM_ID, XCODE_BUNDLE_PREFIX, XCODE_ENV_EXAMPLE,
  toBundleId, toTargetName,
  generateDeployScript, generateScreenshotScript, generateMacScreenshotScript
} from './xcodeScripts.js';

const execAsync = promisify(exec);

/** Every platform this scaffolder knows how to emit, in `project.yml` order. */
const XCODE_PLATFORMS = ['ios', 'macos', 'watchos'];

/** `options.deploymentTarget` line per platform. */
const DEPLOYMENT_TARGET_LINES = {
  ios: '    iOS: "17.0"',
  macos: '    macOS: "14.0"',
  watchos: '    watchOS: "10.0"',
};

const appIconContents = platform => `{
  "images": [{"idiom": "universal", "platform": "${platform}", "size": "1024x1024"}],
  "info": {"version": 1, "author": "xcode"}
}`;

const EMPTY_ASSET_CATALOG = '{"info":{"version":1,"author":"xcode"}}';

/**
 * Build `project.yml` from a shared preamble plus one target block per platform.
 * Target blocks only carry `# --- ... ---` headers in a multi-target project —
 * a single-platform project has nothing to disambiguate.
 */
function buildProjectYml({ targetName, watchTarget, bundleId, teamId, platforms, multi }) {
  const deploymentTargets = XCODE_PLATFORMS
    .filter(p => platforms.includes(p))
    .map(p => DEPLOYMENT_TARGET_LINES[p])
    .join('\n');
  const sharedSource = multi ? '\n      - path: Shared' : '';
  const uiTestScheme = multi ? `\n        - ${targetName}UITests` : '';

  const blocks = [];
  const addBlock = (label, body) => blocks.push(multi ? `  # --- ${label} ---\n${body}` : body);

  addBlock('iOS Target', `  ${targetName}:
    type: application
    platform: iOS
    sources:
      - path: ${targetName}
        excludes:
          - Preview Content/PreviewAssets.xcassets
      - path: ${targetName}/Preview Content/PreviewAssets.xcassets
        buildPhase: none${sharedSource}
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
        - ${targetName}Tests${uiTestScheme}`);

  if (platforms.includes('macos')) {
    addBlock('macOS Target', `  ${targetName} macOS:
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
        GENERATE_INFOPLIST_FILE: true`);
  }

  if (platforms.includes('watchos')) {
    addBlock('watchOS Target', `  ${watchTarget}:
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
        embed: false`);
  }

  addBlock('Unit Tests', `  ${targetName}Tests:
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
        BUNDLE_LOADER: "$(TEST_HOST)"`);

  if (multi) {
    addBlock('UI Tests (screenshot automation)', `  ${targetName}UITests:
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
        TEST_TARGET_NAME: ${targetName}`);
  }

  return `name: ${targetName}
options:
  bundleIdPrefix: ${XCODE_BUNDLE_PREFIX}
  deploymentTarget:
${deploymentTargets}
  xcodeVersion: "16.0"
  generateEmptyDirectories: true

settings:
  base:
    DEVELOPMENT_TEAM: ${teamId}
    MARKETING_VERSION: "1.0.0"
    CURRENT_PROJECT_VERSION: 1
    SWIFT_VERSION: "5.9"

targets:
${blocks.join('\n\n')}
`;
}

/**
 * `ContentView.swift` — the multi-platform variant renders through the `Shared`
 * module's `AppConstants`, so it is only valid when `Shared` is emitted.
 */
const buildContentView = ({ name, multi }) => (multi ? `import SwiftUI

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
` : `import SwiftUI

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

function buildAgentInstructions({ name, bundleId, teamId, targetName, platforms, multi }) {
  const platformVersions = [
    platforms.includes('ios') && 'iOS 17.0+',
    platforms.includes('macos') && 'macOS 14.0+',
    platforms.includes('watchos') && 'watchOS 10.0+',
  ].filter(Boolean).join(', ');

  const summary = multi
    ? `Multi-platform native app built with SwiftUI (${platforms.map(p => ({ ios: 'iOS', macos: 'macOS', watchos: 'watchOS' })[p]).join(' + ')}) and XcodeGen.`
    : 'iOS native app built with SwiftUI and XcodeGen.';

  const macBuild = platforms.includes('macos') ? `

# Build macOS
xcodebuild build -project ${targetName}.xcodeproj -scheme "${targetName} macOS" \\
  CODE_SIGNING_ALLOWED=NO` : '';

  const deployFlags = multi
    ? `./deploy.sh              # every platform the project has a scheme for (default)
./deploy.sh --ios        # iOS only
./deploy.sh --macos      # macOS only
./deploy.sh --watch      # watchOS only (standalone watch apps)
./deploy.sh --all        # explicit "all available" (same as default)
./deploy.sh --skip-tests # skip tests for faster iteration`
    : `./deploy.sh              # full: tests + archive + upload
./deploy.sh --skip-tests # skip tests for faster iteration`;

  const screenshots = multi ? `

## Screenshot Automation

\`\`\`bash
./take_screenshots.sh              # iOS/iPad, all languages
./take_screenshots.sh en           # single language
./take_screenshots.sh --iphone-only${platforms.includes('macos') ? `
./take_screenshots_macos.sh        # macOS screenshots` : ''}
\`\`\`

Screenshots are saved to \`screenshots/{locale}/{device}/\` for upload to App Store Connect.` : '';

  return `# ${name}

${summary}

## Tech Stack

- **SwiftUI** + **SwiftData** (${platformVersions})
- **XcodeGen** for project generation (\`project.yml\` is the source of truth, not the \`.xcodeproj\`)
- Bundle ID: \`${bundleId}\`, Team: \`${teamId}\`

## Build Commands

\`\`\`bash
# Generate Xcode project (required after changing project.yml)
xcodegen generate

# Build${multi ? ' iOS' : ''}
xcodebuild build -project ${targetName}.xcodeproj -scheme ${targetName} \\
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO${macBuild}

# Run tests
xcodebuild test -project ${targetName}.xcodeproj -scheme ${targetName} \\
  -only-testing:${targetName}Tests \\
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
\`\`\`

## TestFlight Deployment

Local deploy via \`./deploy.sh\`:

\`\`\`bash
${deployFlags}
\`\`\`

Requires \`.env\` file with App Store Connect API credentials (see \`.env.example\`).${screenshots}
`;
}

/**
 * Scaffold an Xcode project with XcodeGen, a deploy script and (for
 * multi-platform projects) screenshot automation.
 *
 * `platforms` selects which targets are emitted — `['ios']` reproduces the
 * `ios-native` template, the default reproduces `xcode-multiplatform`. iOS is
 * always emitted: it hosts the unit-test target every variant ships.
 */
export async function scaffoldXcode(repoPath, name, dirName, addStep, { platforms = XCODE_PLATFORMS } = {}) {
  const bundleId = toBundleId(name);
  const teamId = XCODE_TEAM_ID;
  const targetName = toTargetName(name);
  const watchTarget = `${targetName}_Watch`;
  const hasMacos = platforms.includes('macos');
  const hasWatchos = platforms.includes('watchos');
  // A second platform is what pulls in the `Shared` module, the UI-test target
  // and the screenshot automation — iOS on its own needs none of them.
  const multi = hasMacos || hasWatchos;

  await writeFile(
    join(repoPath, 'project.yml'),
    buildProjectYml({ targetName, watchTarget, bundleId, teamId, platforms, multi })
  );

  // Source directories
  const srcDir = join(repoPath, targetName);
  const sharedDir = join(repoPath, 'Shared');
  const watchDir = join(repoPath, watchTarget);
  const previewDir = join(srcDir, 'Preview Content');
  const testsDir = join(repoPath, `${targetName}Tests`);
  const uiTestsDir = join(repoPath, `${targetName}UITests`);

  await ensureDirs([
    srcDir,
    multi && sharedDir,
    hasWatchos && watchDir,
    previewDir,
    testsDir,
    multi && uiTestsDir,
  ].filter(Boolean));

  // Info.plist (iOS). The iOS-only template ships a microphone usage string;
  // the multi-platform one leaves the dictionary empty.
  await writeFile(join(srcDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${multi ? '<dict/>' : `<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>This app needs microphone access for audio recording.</string>
</dict>`}
</plist>
`);

  if (hasMacos) {
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
  }

  if (multi) {
    // Shared module (cross-platform models/logic)
    await writeFile(join(sharedDir, 'AppConstants.swift'), `import Foundation

enum AppConstants {
    static let appName = "${targetName}"
    static let bundleId = "${bundleId}"
}
`);
  }

  // App entry point
  await writeFile(join(srcDir, `${targetName}App.swift`), `import SwiftUI

@main
struct ${targetName}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }${hasMacos ? `
        #if os(macOS)
        .defaultSize(width: 900, height: 600)
        #endif` : ''}
    }
}
`);

  await writeFile(join(srcDir, 'ContentView.swift'), buildContentView({ name, multi }));

  if (hasWatchos) {
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
  }

  // Asset catalogs
  await ensureDir(join(srcDir, 'Assets.xcassets', 'AppIcon.appiconset'));
  await writeFile(join(srcDir, 'Assets.xcassets', 'Contents.json'), EMPTY_ASSET_CATALOG);
  await writeFile(join(srcDir, 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'), appIconContents('ios'));

  if (hasWatchos) {
    await ensureDir(join(watchDir, 'Assets.xcassets', 'AppIcon.appiconset'));
    await writeFile(join(watchDir, 'Assets.xcassets', 'Contents.json'), EMPTY_ASSET_CATALOG);
    await writeFile(join(watchDir, 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'), appIconContents('watchos'));
  }

  await ensureDir(join(previewDir, 'PreviewAssets.xcassets'));
  await writeFile(join(previewDir, 'PreviewAssets.xcassets', 'Contents.json'), EMPTY_ASSET_CATALOG);

  // Unit tests
  await writeFile(join(testsDir, `${targetName}Tests.swift`), `import XCTest
@testable import ${targetName}

final class ${targetName}Tests: XCTestCase {
    func testAppLaunches() {
        XCTAssertTrue(true, "App scaffold is functional")
    }
}
`);

  if (multi) {
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
  }

  // Shared Xcode deployment assets
  await writeFile(join(repoPath, '.env.example'), XCODE_ENV_EXAMPLE);

  // Scripts (from generators in xcodeScripts service)
  const scripts = [
    ['deploy.sh', generateDeployScript(targetName, bundleId)],
    multi && ['take_screenshots.sh', generateScreenshotScript(targetName, bundleId)],
    hasMacos && ['take_screenshots_macos.sh', generateMacScreenshotScript(targetName, bundleId)],
  ].filter(Boolean);

  for (const [file, contents] of scripts) {
    await writeFile(join(repoPath, file), contents);
  }
  if (process.platform !== 'win32') {
    await Promise.all(scripts.map(([file]) => chmod(join(repoPath, file), 0o755)));
  }

  // AGENTS.md (+ the Claude Code bridge)
  await writeAgentInstructions(
    repoPath,
    buildAgentInstructions({ name, bundleId, teamId, targetName, platforms, multi })
  );

  addStep(multi ? 'Create multi-platform Xcode project' : 'Create iOS project', 'done');

  // Run xcodegen if available
  const { stderr: xgenErr } = await execAsync('xcodegen generate', { cwd: repoPath })
    .catch(err => ({ stderr: err.message }));

  if (xgenErr && !xgenErr.includes('Created project')) {
    addStep('Generate Xcode project', 'error', xgenErr);
  } else {
    addStep('Generate Xcode project', 'done');
  }
}
