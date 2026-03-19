import { Router } from 'express';
import { writeFile, readdir, copyFile, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir, platform } from 'os';
import { createApp, getReservedPorts } from '../services/apps.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { ensureDir, ensureDirs, safeJSONParse } from '../lib/fileUtils.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, '../../templates');

const router = Router();

// GET /api/directories - Browse directories for directory picker
router.get('/directories', asyncHandler(async (req, res) => {
  const { path: dirPath } = req.query;

  // Default to parent of PortOS project if no path provided
  const defaultPath = resolve(join(__dirname, '../../..'));
  const targetPath = dirPath === '~' ? homedir() : dirPath ? resolve(dirPath) : defaultPath;

  // Validate path exists and is a directory
  if (!existsSync(targetPath)) {
    throw new ServerError('Directory does not exist', {
      status: 400,
      code: 'INVALID_PATH'
    });
  }

  const stats = await stat(targetPath);
  if (!stats.isDirectory()) {
    throw new ServerError('Path is not a directory', {
      status: 400,
      code: 'NOT_A_DIRECTORY'
    });
  }

  // Read directory contents
  const entries = await readdir(targetPath, { withFileTypes: true });
  const directories = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => ({
      name: entry.name,
      path: join(targetPath, entry.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Get parent directory info
  const parentPath = dirname(targetPath);
  const canGoUp = parentPath !== targetPath; // Can't go above root

  // On Windows, include available drive letters so users can navigate between drives
  let drives = null;
  if (platform() === 'win32') {
    // Only check common drive letters (C-Z) to avoid slow floppy/network drives (A-B)
    drives = [];
    for (let i = 67; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const drivePath = `${letter}:${sep}`;
      try { if (existsSync(drivePath)) drives.push(drivePath); } catch { /* skip inaccessible drives */ }
    }
  }

  res.json({
    currentPath: targetPath,
    parentPath: canGoUp ? parentPath : null,
    directories,
    ...(drives && { drives })
  });
}));

// GET /api/templates - List available templates
router.get('/templates', asyncHandler(async (req, res) => {
  const templates = [
    {
      id: 'portos-stack',
      name: 'PortOS Stack',
      description: 'Express + React + Vite with Tailwind, PM2, AI providers, and GitHub Actions CI/CD',
      type: 'portos-stack',
      icon: 'layers',
      builtIn: true,
      features: ['Express.js API', 'React + Vite frontend', 'Tailwind CSS', 'PM2 ecosystem', 'AI Provider Integration', 'GitHub Actions CI/CD', 'Collapsible nav layout'],
      ports: { ui: true, api: true }
    },
    {
      id: 'vite-express',
      name: 'Vite + Express',
      description: 'Full-stack with React frontend and Express API',
      type: 'vite+express',
      icon: 'code',
      features: ['React + Vite', 'Express.js API', 'CORS configured'],
      ports: { ui: true, api: true }
    },
    {
      id: 'vite-react',
      name: 'Vite + React',
      description: 'React app with Vite bundler',
      type: 'vite',
      icon: 'globe',
      features: ['React 18', 'Vite bundler', 'Fast HMR'],
      ports: { ui: true, api: false }
    },
    {
      id: 'express-api',
      name: 'Express API',
      description: 'Node.js Express API server',
      type: 'single-node-server',
      icon: 'server',
      features: ['Express.js', 'CORS', 'Health endpoint'],
      ports: { ui: false, api: true }
    },
    {
      id: 'ios-native',
      name: 'iOS Native App',
      description: 'SwiftUI + XcodeGen with TestFlight deploy script',
      type: 'ios-native',
      icon: 'smartphone',
      features: ['SwiftUI', 'SwiftData', 'XcodeGen', 'TestFlight CI/CD', 'On-device processing'],
      ports: { ui: false, api: false }
    }
  ];

  res.json(templates);
}));

// POST /api/templates/create - User-friendly template creation
router.post('/templates/create', asyncHandler(async (req, res) => {
  const { templateId, name, targetPath } = req.body;

  if (!templateId || !name || !targetPath) {
    throw new ServerError('templateId, name, and targetPath are required', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  // Map to scaffold endpoint format
  const scaffoldData = {
    name,
    template: templateId,
    parentDir: targetPath
  };

  // Map portos-stack to template name used in scaffoldApp
  if (templateId === 'portos-stack') {
    scaffoldData.template = 'portos-stack';
  }

  // Reuse scaffold logic
  req.body = scaffoldData;
  // Forward to scaffold endpoint logic (call the same handler)
  return scaffoldApp(req, res);
}));

/**
 * Find the next available ports starting from USER_APP_PORT_START
 * Returns { apiPort, uiPort } for the next contiguous pair
 */
const USER_APP_PORT_START = 5570;
const USER_APP_PORT_END = 5599;

async function findNextAvailablePorts(needsApi, needsUi) {
  const reservedPorts = await getReservedPorts();
  const reserved = new Set(reservedPorts);

  let apiPort = null;
  let uiPort = null;

  for (let port = USER_APP_PORT_START; port <= USER_APP_PORT_END; port++) {
    if (reserved.has(port)) continue;

    if (needsApi && !apiPort) {
      apiPort = port;
      reserved.add(port);
    } else if (needsUi && !uiPort) {
      uiPort = port;
      reserved.add(port);
    }

    if ((!needsApi || apiPort) && (!needsUi || uiPort)) break;
  }

  return { apiPort, uiPort };
}

// Shared scaffold logic
async function scaffoldApp(req, res) {
  let {
    name,
    template,
    parentDir,
    uiPort,
    apiPort,
    createGitHubRepo = false,
    githubOrg = null
  } = req.body;

  // Validation
  if (!name || !template || !parentDir) {
    throw new ServerError('name, template, and parentDir are required', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  // Auto-allocate ports if not provided
  const templateNeedsPorts = {
    'portos-stack': { api: true, ui: true },
    'vite-express': { api: true, ui: true },
    'vite-react': { api: false, ui: true },
    'express-api': { api: true, ui: false },
    'ios-native': { api: false, ui: false }
  };

  const needs = templateNeedsPorts[template] || { api: false, ui: false };
  if ((needs.api && !apiPort) || (needs.ui && !uiPort)) {
    const allocated = await findNextAvailablePorts(needs.api && !apiPort, needs.ui && !uiPort);
    if (needs.api && !apiPort) apiPort = allocated.apiPort;
    if (needs.ui && !uiPort) uiPort = allocated.uiPort;
  }

  // Sanitize name for directory
  const dirName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const repoPath = join(parentDir, dirName);

  // Check parent exists
  if (!existsSync(parentDir)) {
    throw new ServerError('Parent directory does not exist', {
      status: 400,
      code: 'INVALID_PARENT'
    });
  }

  // Check target doesn't exist
  if (existsSync(repoPath)) {
    throw new ServerError('Directory already exists', {
      status: 400,
      code: 'DIR_EXISTS'
    });
  }

  const steps = [];
  const addStep = (name, status, error = null) => {
    steps.push({ name, status, error, timestamp: Date.now() });
  };

  // Create directory
  await ensureDir(repoPath);
  addStep('Create directory', 'done');

  // Generate project files based on template
  if (template === 'vite-react' || template === 'vite-express') {
    // Create using npm create vite
    // Security: Use spawn with array args instead of execAsync to prevent shell injection
    const { stderr } = await new Promise((resolve) => {
      const child = spawn('npm', ['create', 'vite@latest', dirName, '--', '--template', 'react'], {
        cwd: parentDir,
        shell: process.platform === 'win32',
        windowsHide: true
      });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });
      child.on('close', () => resolve({ stderr }));
      child.on('error', (err) => resolve({ stderr: err.message }));
    });

    if (stderr && !stderr.includes('npm warn')) {
      addStep('Create Vite project', 'error', stderr);
    } else {
      addStep('Create Vite project', 'done');
    }

    // Update vite.config.js with port
    if (uiPort) {
      const viteConfigPath = join(repoPath, 'vite.config.js');
      if (existsSync(viteConfigPath)) {
        let config = await readFile(viteConfigPath, 'utf-8');
        config = config.replace(
          'plugins: [react()]',
          `plugins: [react()],\n  server: {\n    host: '0.0.0.0',\n    port: ${uiPort}\n  }`
        );
        await writeFile(viteConfigPath, config);
      }
    }

    // Add Express server if vite-express template
    if (template === 'vite-express') {
      const serverDir = join(repoPath, 'server');
      await ensureDir(serverDir);

      await writeFile(join(serverDir, 'index.js'), `import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || ${apiPort || 3001};

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(\`Server running on port \${PORT}\`);
});
`);

      // Update package.json to add express and server script
      const pkgPath = join(repoPath, 'package.json');
      const pkgContent = await readFile(pkgPath, 'utf-8');
      const pkg = safeJSONParse(pkgContent, { dependencies: {}, devDependencies: {}, scripts: {} });
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies.express = '^4.21.2';
      pkg.dependencies.cors = '^2.8.5';
      pkg.scripts['server'] = 'node server/index.js';
      pkg.scripts['dev:all'] = 'concurrently "npm run dev" "npm run server"';
      pkg.devDependencies = pkg.devDependencies || {};
      pkg.devDependencies.concurrently = '^8.2.2';
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

      addStep('Add Express server', 'done');
    }
  } else if (template === 'express-api') {
    // Create Express-only project
    const pkg = {
      name: dirName,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'node --watch index.js',
        start: 'node index.js'
      },
      dependencies: {
        express: '^4.21.2',
        cors: '^2.8.5'
      }
    };
    await writeFile(join(repoPath, 'package.json'), JSON.stringify(pkg, null, 2));

    await writeFile(join(repoPath, 'index.js'), `import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || ${apiPort || 3000};

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(\`API server running on port \${PORT}\`);
});
`);

    addStep('Create Express project', 'done');
  } else if (template === 'ios-native') {
    // Create iOS native app with SwiftUI + XcodeGen
    const bundleId = `net.shadowpuppet.${name.replace(/[^a-zA-Z0-9]/g, '')}`;
    const teamId = 'TYQ32QCF6K';

    // project.yml (XcodeGen source of truth)
    await writeFile(join(repoPath, 'project.yml'), `name: ${name.replace(/[^a-zA-Z0-9_]/g, '_')}
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
  ${name.replace(/[^a-zA-Z0-9_]/g, '_')}:
    type: application
    platform: iOS
    sources:
      - path: ${name.replace(/[^a-zA-Z0-9_]/g, '_')}
        excludes:
          - Preview Content/PreviewAssets.xcassets
      - path: ${name.replace(/[^a-zA-Z0-9_]/g, '_')}/Preview Content/PreviewAssets.xcassets
        buildPhase: none
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}
        INFOPLIST_FILE: ${name.replace(/[^a-zA-Z0-9_]/g, '_')}/Info.plist
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        INFOPLIST_KEY_ITSAppUsesNonExemptEncryption: NO
        INFOPLIST_KEY_UISupportedInterfaceOrientations: "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
        INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad: "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
        INFOPLIST_KEY_UILaunchScreen_Generation: true
        DEVELOPMENT_ASSET_PATHS: "\\"${name.replace(/[^a-zA-Z0-9_]/g, '_')}/Preview Content\\""
        GENERATE_INFOPLIST_FILE: true
    scheme:
      testTargets:
        - ${name.replace(/[^a-zA-Z0-9_]/g, '_')}Tests

  ${name.replace(/[^a-zA-Z0-9_]/g, '_')}Tests:
    type: bundle.unit-test
    platform: iOS
    sources:
      - path: ${name.replace(/[^a-zA-Z0-9_]/g, '_')}Tests
    dependencies:
      - target: ${name.replace(/[^a-zA-Z0-9_]/g, '_')}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}Tests
        GENERATE_INFOPLIST_FILE: true
        TEST_HOST: "$(BUILT_PRODUCTS_DIR)/${name.replace(/[^a-zA-Z0-9_]/g, '_')}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/${name.replace(/[^a-zA-Z0-9_]/g, '_')}"
        BUNDLE_LOADER: "$(TEST_HOST)"
`);

    // Create source directories
    const targetName = name.replace(/[^a-zA-Z0-9_]/g, '_');
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
  } else if (template === 'portos-stack') {
    // Create PortOS Stack - full monorepo with client, server, Tailwind, CI/CD
    const clientDir = join(repoPath, 'client');
    const serverDir = join(repoPath, 'server');
    const workflowsDir = join(repoPath, '.github/workflows');

    await ensureDirs([clientDir, serverDir, workflowsDir]);

    // === Root package.json ===
    const rootPkg = {
      name: dirName,
      version: '0.1.0',
      private: true,
      description: `${name} - built with PortOS Stack`,
      type: 'module',
      scripts: {
        'dev': 'concurrently "npm run dev:server" "npm run dev:client"',
        'dev:server': 'cd server && npm run dev',
        'dev:client': 'cd client && npm run dev',
        'build': 'cd client && npm run build',
        'start': 'cd server && npm start',
        'install:all': 'npm install && cd client && npm install && cd ../server && npm install',
        'test': 'cd server && npm test'
      },
      devDependencies: {
        'concurrently': '^8.2.2'
      }
    };
    await writeFile(join(repoPath, 'package.json'), JSON.stringify(rootPkg, null, 2));

    // === Client package.json ===
    const clientPkg = {
      name: `${dirName}-ui`,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        'dev': `vite --host 0.0.0.0 --port ${uiPort || 3000}`,
        'build': 'vite build',
        'preview': 'vite preview'
      },
      dependencies: {
        'lucide-react': '^0.562.0',
        'portos-ai-toolkit': '^0.1.0',
        'react': '^18.3.1',
        'react-dom': '^18.3.1',
        'react-hot-toast': '^2.6.0',
        'react-router-dom': '^7.1.1',
        'socket.io-client': '^4.8.3'
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.3.4',
        'autoprefixer': '^10.4.20',
        'postcss': '^8.4.49',
        'tailwindcss': '^3.4.17',
        'vite': '^6.0.6'
      }
    };
    await writeFile(join(clientDir, 'package.json'), JSON.stringify(clientPkg, null, 2));

    // === Client vite.config.js ===
    await writeFile(join(clientDir, 'vite.config.js'), `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: ${uiPort || 3000},
    proxy: {
      '/api': {
        target: 'http://localhost:${apiPort || 3001}',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:${apiPort || 3001}',
        changeOrigin: true,
        ws: true
      }
    }
  }
});
`);

    // === Client tailwind.config.js ===
    await writeFile(join(clientDir, 'tailwind.config.js'), `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'app-bg': '#0f0f0f',
        'app-card': '#1a1a1a',
        'app-border': '#2a2a2a',
        'app-accent': '#3b82f6',
        'app-success': '#22c55e',
        'app-warning': '#f59e0b',
        'app-error': '#ef4444'
      }
    },
  },
  plugins: [],
}
`);

    // === Client postcss.config.js ===
    await writeFile(join(clientDir, 'postcss.config.js'), `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`);

    // === Client index.html ===
    await writeFile(join(clientDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`);

    // === Client src files ===
    const clientSrcDir = join(clientDir, 'src');
    await ensureDir(clientSrcDir);

    await writeFile(join(clientSrcDir, 'main.jsx'), `import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <Toaster position="bottom-right" />
    </BrowserRouter>
  </React.StrictMode>
);
`);

    await writeFile(join(clientSrcDir, 'App.jsx'), `import { Routes, Route, Link } from 'react-router-dom';
import { Menu, X, Home, Brain, Info } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import AIProviders from './pages/AIProviders';

function HomePage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Welcome to ${name}</h1>
      <p className="text-gray-400">Built with PortOS Stack</p>
    </div>
  );
}

function About() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">About</h1>
      <p className="text-gray-400">Express + React + Vite + Tailwind + AI Provider Integration</p>
    </div>
  );
}

export default function App() {
  const [navOpen, setNavOpen] = useState(true);
  const location = useLocation();

  return (
    <div className="flex min-h-screen bg-app-bg text-white">
      {/* Collapsible sidebar */}
      <nav className={\`\${navOpen ? 'w-48' : 'w-12'} bg-app-card border-r border-app-border transition-all duration-200 flex flex-col\`}>
        <button
          onClick={() => setNavOpen(!navOpen)}
          className="p-3 hover:bg-app-border"
        >
          {navOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <div className="flex flex-col gap-1 p-2">
          <Link to="/" className={\`flex items-center gap-2 p-2 rounded hover:bg-app-border \${location.pathname === '/' ? 'bg-app-accent/20 text-app-accent' : ''}\`}>
            <Home size={18} />
            {navOpen && <span>Home</span>}
          </Link>
          <Link to="/providers" className={\`flex items-center gap-2 p-2 rounded hover:bg-app-border \${location.pathname === '/providers' ? 'bg-app-accent/20 text-app-accent' : ''}\`}>
            <Brain size={18} />
            {navOpen && <span>AI Providers</span>}
          </Link>
          <Link to="/about" className={\`flex items-center gap-2 p-2 rounded hover:bg-app-border \${location.pathname === '/about' ? 'bg-app-accent/20 text-app-accent' : ''}\`}>
            <Info size={18} />
            {navOpen && <span>About</span>}
          </Link>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/providers" element={<AIProviders />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </main>
    </div>
  );
}
`);

    await writeFile(join(clientSrcDir, 'index.css'), `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
`);

    // === Client pages ===
    const pagesDir = join(clientSrcDir, 'pages');
    await ensureDir(pagesDir);

    // AIProviders page - uses shared component from ai-toolkit
    await writeFile(join(pagesDir, 'AIProviders.jsx'), `import { AIProviders } from 'portos-ai-toolkit/client';
import toast from 'react-hot-toast';

export default function AIProvidersPage() {
  return <AIProviders onError={toast.error} colorPrefix="app" />;
}
`);

    addStep('Create client', 'done');

    // === Server package.json ===
    const serverPkg = {
      name: `${dirName}-server`,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        'dev': 'node --watch index.js',
        'start': 'node index.js',
        'test': 'vitest run',
        'test:watch': 'vitest'
      },
      dependencies: {
        'cors': '^2.8.5',
        'express': '^4.21.2',
        'portos-ai-toolkit': '^0.1.0',
        'socket.io': '^4.8.3',
        'zod': '^3.24.1'
      },
      devDependencies: {
        'vitest': '^2.1.8'
      }
    };
    await writeFile(join(serverDir, 'package.json'), JSON.stringify(serverPkg, null, 2));

    // === Server index.js ===
    await writeFile(join(serverDir, 'index.js'), `import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAIToolkit } from 'portos-ai-toolkit/server';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || ${apiPort || 3001};

app.use(cors());
app.use(express.json());

// Initialize AI Toolkit with routes for providers, runs, and prompts
const aiToolkit = createAIToolkit({
  dataDir: './data',
  io
});
aiToolkit.mountRoutes(app);

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log(\`🔌 Client connected: \${socket.id}\`);
  socket.on('disconnect', () => {
    console.log(\`🔌 Client disconnected: \${socket.id}\`);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(\`🚀 Server running on port \${PORT}\`);
});
`);

    // === Server vitest.config.js ===
    await writeFile(join(serverDir, 'vitest.config.js'), `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node'
  }
});
`);

    addStep('Create server', 'done');

    // === Default Data (providers, etc.) ===
    // Data dir at project root (server runs with cwd at project root)
    const dataDir = join(repoPath, 'data');
    await ensureDir(dataDir);

    const defaultProviders = {
      activeProvider: 'claude-code',
      providers: {
        'claude-code': {
          id: 'claude-code',
          name: 'Claude Code CLI',
          type: 'cli',
          command: 'claude',
          args: ['--print'],
          models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101'],
          defaultModel: 'claude-sonnet-4-5-20250929',
          lightModel: 'claude-haiku-4-5-20251001',
          mediumModel: 'claude-sonnet-4-5-20250929',
          heavyModel: 'claude-opus-4-5-20251101',
          timeout: 300000,
          enabled: true,
          envVars: {}
        },
        'codex': {
          id: 'codex',
          name: 'Codex CLI',
          type: 'cli',
          command: 'codex',
          args: [],
          models: ['gpt-5', 'gpt-5-codex'],
          defaultModel: 'gpt-5-codex',
          lightModel: 'gpt-5',
          mediumModel: 'gpt-5-codex',
          heavyModel: 'gpt-5-codex',
          timeout: 300000,
          enabled: true,
          envVars: {}
        },
        'lm-studio': {
          id: 'lm-studio',
          name: 'LM Studio (Local)',
          type: 'api',
          endpoint: 'http://localhost:1234/v1',
          apiKey: 'lm-studio',
          models: [],
          defaultModel: null,
          timeout: 300000,
          enabled: false,
          envVars: {}
        },
        'ollama': {
          id: 'ollama',
          name: 'Ollama (Local)',
          type: 'api',
          endpoint: 'http://localhost:11434/v1',
          apiKey: '',
          models: [],
          defaultModel: null,
          timeout: 300000,
          enabled: false,
          envVars: {}
        }
      }
    };
    await writeFile(join(dataDir, 'providers.json'), JSON.stringify(defaultProviders, null, 2));
    addStep('Create default data', 'done');

    // === GitHub Actions CI ===
    await writeFile(join(workflowsDir, 'ci.yml'), `name: CI

on:
  pull_request:
    branches: [main, dev]
  push:
    branches: [dev]

permissions:
  contents: write

jobs:
  test:
    runs-on: ubuntu-latest
    if: "!contains(github.event.head_commit.message, '[skip ci]')"

    strategy:
      matrix:
        node-version: [20.x]

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'

      - name: Install root dependencies
        run: npm ci

      - name: Install client dependencies
        working-directory: ./client
        run: npm ci

      - name: Install server dependencies
        working-directory: ./server
        run: npm ci

      - name: Run server tests
        working-directory: ./server
        run: npm test

      - name: Build client
        working-directory: ./client
        run: npm run build

  bump-build:
    runs-on: ubuntu-latest
    needs: [test]
    if: github.event_name == 'push' && github.ref == 'refs/heads/dev' && !contains(github.event.head_commit.message, '[skip ci]')

    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Bump patch version
        run: |
          CURRENT_VERSION=\$(node -p "require('./package.json').version")
          MAJOR=\$(echo \$CURRENT_VERSION | cut -d. -f1)
          MINOR=\$(echo \$CURRENT_VERSION | cut -d. -f2)
          PATCH=\$(echo \$CURRENT_VERSION | cut -d. -f3)
          NEW_PATCH=\$((PATCH + 1))
          NEW_VERSION="\$MAJOR.\$MINOR.\$NEW_PATCH"
          npm version \$NEW_VERSION --no-git-tag-version
          cd client && npm version \$NEW_VERSION --no-git-tag-version && cd ..
          cd server && npm version \$NEW_VERSION --no-git-tag-version && cd ..
          git add package.json package-lock.json client/package.json server/package.json
          git commit -m "build: bump version to \$NEW_VERSION [skip ci]"
          git push
`);

    // === GitHub Actions Release ===
    await writeFile(join(workflowsDir, 'release.yml'), `name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    if: "!contains(github.event.head_commit.message, '[skip ci]')"

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Use Node.js 20.x
        uses: actions/setup-node@v4
        with:
          node-version: 20.x

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Get version from package.json
        id: package-version
        run: echo "version=\$(node -p \\"require('./package.json').version\\")" >> \$GITHUB_OUTPUT

      - name: Check if tag exists
        id: tag-check
        run: |
          if git rev-parse "v\${{ steps.package-version.outputs.version }}" >/dev/null 2>&1; then
            echo "exists=true" >> \$GITHUB_OUTPUT
          else
            echo "exists=false" >> \$GITHUB_OUTPUT
          fi

      - name: Generate changelog
        id: changelog
        if: steps.tag-check.outputs.exists == 'false'
        run: |
          PREV_TAG=\$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
          CHANGELOG=\$(git log \$PREV_TAG..HEAD --pretty=format:"- %s" --no-merges | grep -v "\\[skip ci\\]" | head -50)
          echo "changelog<<EOF" >> \$GITHUB_OUTPUT
          echo "\$CHANGELOG" >> \$GITHUB_OUTPUT
          echo "EOF" >> \$GITHUB_OUTPUT

      - name: Create Release
        if: steps.tag-check.outputs.exists == 'false'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v\${{ steps.package-version.outputs.version }}
          name: v\${{ steps.package-version.outputs.version }}
          body: |
            ## Changes

            \${{ steps.changelog.outputs.changelog }}
          draft: false
          prerelease: false
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}

      - name: Prep dev branch for next release
        if: steps.tag-check.outputs.exists == 'false'
        run: |
          CURRENT_VERSION=\${{ steps.package-version.outputs.version }}
          MAJOR=\$(echo \$CURRENT_VERSION | cut -d. -f1)
          MINOR=\$(echo \$CURRENT_VERSION | cut -d. -f2)
          NEW_MINOR=\$((MINOR + 1))
          NEW_VERSION="\$MAJOR.\$NEW_MINOR.0"
          git fetch origin dev
          git checkout dev
          npm version \$NEW_VERSION --no-git-tag-version
          cd client && npm version \$NEW_VERSION --no-git-tag-version && cd ..
          cd server && npm version \$NEW_VERSION --no-git-tag-version && cd ..
          git add package.json package-lock.json client/package.json server/package.json
          git commit -m "build: prep v\$NEW_VERSION for next release [skip ci]"
          git push origin dev
`);

    addStep('Create GitHub Actions', 'done');

    // === CLAUDE.md ===
    await writeFile(join(repoPath, 'CLAUDE.md'), `# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

\`\`\`bash
# Install all dependencies
npm run install:all

# Development (both server and client)
npm run dev

# Run tests
cd server && npm test

# Production
pm2 start ecosystem.config.cjs
\`\`\`

## Architecture

${name} is a monorepo with Express.js server (port ${apiPort || 3001}) and React/Vite client (port ${uiPort || 3000}). PM2 manages app lifecycles.

### Server (\`server/\`)
- **index.js**: Express server with Socket.IO and AI toolkit integration

### Client (\`client/src/\`)
- **App.jsx**: Main component with routing and collapsible nav
- **main.jsx**: React entry point

### AI Provider Integration

This project includes \`portos-ai-toolkit\` for AI provider management. The server exposes:
- \`GET/POST /api/providers\` - Manage AI providers (CLI or API-based)
- \`GET/POST /api/runs\` - Execute and track AI runs
- \`GET/POST /api/prompts\` - Manage prompt templates

Provider data is stored in \`./data/providers.json\`.

## Code Conventions

- **No try/catch** - errors bubble to centralized middleware
- **Functional programming** - no classes, use hooks in React
- **Single-line logging** - use emoji prefixes

## Git Workflow

- **dev**: Active development (auto-bumps patch on CI pass)
- **main**: Production releases only
`);

    // === README.md ===
    await writeFile(join(repoPath, 'README.md'), `# ${name}

Built with PortOS Stack.

## Quick Start

\`\`\`bash
npm run install:all
npm run dev
\`\`\`

## Architecture

- **Client**: React + Vite + Tailwind (port ${uiPort || 3000})
- **Server**: Express + Socket.IO (port ${apiPort || 3001})
- **AI**: portos-ai-toolkit for provider management
- **PM2**: Process management
- **CI/CD**: GitHub Actions

## API Endpoints

- \`GET /api/health\` - Health check
- \`GET/POST /api/providers\` - AI provider management
- \`GET/POST /api/runs\` - AI execution runs
- \`GET/POST /api/prompts\` - Prompt templates

## Scripts

| Command | Description |
|---------|-------------|
| \`npm run dev\` | Start both client and server |
| \`npm run build\` | Build client for production |
| \`npm test\` | Run server tests |
`);

    addStep('Create documentation', 'done');
  }

  // Create .env file
  const envContent = [
    uiPort && `VITE_PORT=${uiPort}`,
    apiPort && `PORT=${apiPort}`
  ].filter(Boolean).join('\n');

  if (envContent) {
    await writeFile(join(repoPath, '.env'), envContent + '\n');
    addStep('Create .env', 'done');
  }

  // Create PM2 ecosystem file with proper PORTS constant pattern
  let ecosystemContent;

  if (template === 'portos-stack') {
    ecosystemContent = `// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: ${apiPort},    // Express API server
  UI: ${uiPort}       // Vite dev server (client)
};

module.exports = {
  PORTS, // Export for other configs to reference

  apps: [
    {
      name: '${dirName}-server',
      script: 'server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'development',
        PORT: PORTS.API,
        HOST: '0.0.0.0'
      },
      watch: false
    },
    {
      name: '${dirName}-ui',
      script: 'node_modules/.bin/vite',
      cwd: \`\${__dirname}/client\`,
      args: \`--host 0.0.0.0 --port \${PORTS.UI}\`,
      env: {
        NODE_ENV: 'development',
        VITE_PORT: PORTS.UI
      },
      watch: false
    }
  ]
};
`;
  } else if (template === 'vite-express') {
    ecosystemContent = `// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: ${apiPort},    // Express API server
  UI: ${uiPort}       // Vite dev server
};

module.exports = {
  PORTS,

  apps: [
    {
      name: '${dirName}-ui',
      script: 'npm',
      args: 'run dev',
      cwd: __dirname,
      env: {
        VITE_PORT: PORTS.UI
      }
    },
    {
      name: '${dirName}-api',
      script: 'server/index.js',
      cwd: __dirname,
      env: {
        PORT: PORTS.API
      }
    }
  ]
};
`;
  } else if (template === 'vite-react') {
    ecosystemContent = `// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  UI: ${uiPort}       // Vite dev server
};

module.exports = {
  PORTS,

  apps: [
    {
      name: '${dirName}',
      script: 'npm',
      args: 'run dev',
      cwd: __dirname,
      env: {
        VITE_PORT: PORTS.UI
      }
    }
  ]
};
`;
  } else if (template === 'express-api') {
    ecosystemContent = `// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: ${apiPort}     // Express API server
};

module.exports = {
  PORTS,

  apps: [
    {
      name: '${dirName}',
      script: 'index.js',
      cwd: __dirname,
      env: {
        PORT: PORTS.API
      }
    }
  ]
};
`;
  }

  if (ecosystemContent) {
    await writeFile(join(repoPath, 'ecosystem.config.cjs'), ecosystemContent);
    addStep('Create PM2 config', 'done');
  }

  // Run npm install (skip for iOS — no npm)
  if (template !== 'ios-native') {
    const installCmd = template === 'portos-stack' ? 'npm run install:all' : 'npm install';
    const { stderr: installErr } = await execAsync(installCmd, { cwd: repoPath, windowsHide: true })
      .catch(err => ({ stderr: err.message }));

    if (installErr && !installErr.includes('npm warn')) {
      addStep('npm install', 'error', installErr);
    } else {
      addStep('npm install', 'done');
    }
  }

  // Initialize git
  await execAsync('git init', { cwd: repoPath, windowsHide: true });

  // Create .gitignore
  let gitignoreContent;
  if (template === 'ios-native') {
    gitignoreContent = `# Build output
build/
DerivedData/

# Environment files
.env

# OS files
.DS_Store

# IDE
*.swp
*.swo
xcuserdata/
*.xcworkspace
`;
  } else if (template === 'portos-stack') {
    gitignoreContent = `# Dependencies
node_modules/

# Build output
dist/
build/

# Environment files
.env
.env.local
.env.*.local

# Logs
logs/
*.log
npm-debug.log*

# OS files
.DS_Store
Thumbs.db

# IDE
.idea/
.vscode/
*.swp
*.swo

# PM2
.pm2/
`;
  } else {
    gitignoreContent = 'node_modules\n.env\ndist\n';
  }

  await writeFile(join(repoPath, '.gitignore'), gitignoreContent);
  await execAsync('git add -A', { cwd: repoPath, windowsHide: true });
  await execAsync('git commit -m "Initial commit"', { cwd: repoPath, windowsHide: true });
  addStep('Initialize git', 'done');

  // Create GitHub repo if requested
  if (createGitHubRepo) {
    // Security: Use spawn with array args to prevent shell injection from githubOrg/dirName
    const repoName = githubOrg ? `${githubOrg}/${dirName}` : dirName;
    const ghArgs = ['repo', 'create', repoName, '--source=.', '--push', '--private'];

    const { stderr: ghErr } = await new Promise((resolve) => {
      const child = spawn('gh', ghArgs, { cwd: repoPath, shell: false, windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });
      child.on('close', () => resolve({ stderr }));
      child.on('error', (err) => resolve({ stderr: err.message }));
    });

    if (ghErr && !ghErr.includes('Created repository')) {
      addStep('Create GitHub repo', 'error', ghErr);
    } else {
      addStep('Create GitHub repo', 'done');
    }
  }

  // Register in PortOS
  const templateToType = {
    'portos-stack': 'portos-stack',
    'vite-react': 'vite',
    'vite-express': 'vite+express',
    'express-api': 'single-node-server',
    'ios-native': 'ios-native'
  };

  let pm2Names;
  let startCmds;
  let buildCmd;

  if (template === 'portos-stack') {
    pm2Names = [`${dirName}-server`, `${dirName}-ui`];
    startCmds = ['npm run dev'];
  } else if (template === 'vite-express') {
    pm2Names = [`${dirName}-ui`, `${dirName}-api`];
    startCmds = ['npm run dev:all'];
  } else if (template === 'ios-native') {
    pm2Names = [];
    startCmds = [`open ${name.replace(/[^a-zA-Z0-9_]/g, '_')}.xcodeproj`];
    buildCmd = `xcodebuild build -project ${name.replace(/[^a-zA-Z0-9_]/g, '_')}.xcodeproj -scheme ${name.replace(/[^a-zA-Z0-9_]/g, '_')} -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO`;
  } else {
    pm2Names = [dirName];
    startCmds = ['npm run dev'];
  }

  const app = await createApp({
    name,
    repoPath,
    type: templateToType[template] || 'unknown',
    uiPort: uiPort || null,
    apiPort: apiPort || null,
    buildCommand: buildCmd,
    startCommands: startCmds,
    pm2ProcessNames: pm2Names,
    envFile: '.env'
  });

  addStep('Register in PortOS', 'done');

  res.json({
    success: true,
    app,
    repoPath,
    steps
  });
}

// POST /api/scaffold - Create a new app from template
router.post('/', asyncHandler(scaffoldApp));

export default router;
