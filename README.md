# Port OS

A self-hosted App OS portal for your dev machine. Manage all your local development apps from a single dashboard — accessible from anywhere via [Tailscale](https://tailscale.com).

Think Umbrel, but for your active git repos and dev environments. Access your dev apps from your phone, tablet, or any device on your Tailscale network.

## Features

- **App Dashboard**: Grid of app tiles with status, ports, and quick actions (start/stop/restart)
- **App Management**: Register existing projects or scaffold new ones from templates
- **AI Auto-Detection**: Point to a directory and let AI analyze your project to configure it
- **Log Viewer**: Real-time log streaming from PM2 processes via Socket.IO
- **Dev Tools**: Process monitor, action history, and command runner
- **AI Providers**: Run prompts via Claude Code CLI, Codex, Gemini CLI, LM Studio, or Ollama
- **Mobile Ready**: Responsive design with collapsible sidebar for on-the-go access

## Quick Start

```bash
# Install dependencies
npm run install:all

# Start with PM2 (recommended)
pm2 start ecosystem.config.cjs

# Or start in dev mode
npm run dev
```

Access PortOS:
- **Local**: http://localhost:5555
- **Tailscale**: http://[your-tailscale-ip]:5555

## Network Access

PortOS binds to `0.0.0.0` to allow access from your Tailscale network. This means you can:

- Access your dev dashboard from your phone while on the go
- Manage apps running on your home dev machine from anywhere
- View logs and restart services remotely

**Security Note**: PortOS is designed for private Tailscale networks. Do not expose ports 5554/5555 to the public internet.

## Project Structure

```
PortOS/
├── client/           # React + Vite frontend (port 5555)
├── server/           # Express.js API (port 5554)
├── data/             # Runtime data (gitignored)
├── data.sample/      # Sample configurations
├── docs/             # Documentation
└── ecosystem.config.cjs  # PM2 configuration
```

## Documentation

- [Contributing Guide](./docs/CONTRIBUTING.md) - Development setup, code guidelines
- [Versioning & Releases](./docs/VERSIONING.md) - Version format, release process

## PM2 Commands

```bash
# Start PortOS
pm2 start ecosystem.config.cjs

# View status
pm2 status

# View logs
pm2 logs portos-server
pm2 logs portos-client

# Restart
pm2 restart portos-server portos-client

# Stop
pm2 stop portos-server portos-client

# Save process list (survives reboot)
pm2 save
```

## API Endpoints

### Apps
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/apps | List all registered apps |
| POST | /api/apps | Register new app |
| GET | /api/apps/:id | Get app details |
| PUT | /api/apps/:id | Update app |
| DELETE | /api/apps/:id | Delete app |
| POST | /api/apps/:id/start | Start app via PM2 |
| POST | /api/apps/:id/stop | Stop app |
| POST | /api/apps/:id/restart | Restart app |

### AI & Detection
| Method | Route | Description |
|--------|-------|-------------|
| POST | /api/detect/repo | Validate path and detect project type |
| POST | /api/detect/ai | AI-powered app configuration detection |
| GET | /api/providers | List AI providers |
| POST | /api/runs | Execute AI prompt |

### Dev Tools
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/logs/:process | Stream logs via SSE |
| GET | /api/history | Action history |
| POST | /api/commands/execute | Run shell command |
| GET | /api/commands/processes | List PM2 processes |

## Configuration

### Apps
Apps are stored in `data/apps.json`. Each app entry includes:
- `name`: Display name
- `repoPath`: Path to project directory
- `uiPort` / `apiPort`: Port numbers
- `startCommands`: Commands to start the app
- `pm2ProcessNames`: PM2 process identifiers

### AI Providers
Providers are stored in `data/providers.json`. Supported types:
- **CLI**: Claude Code, Codex, Gemini CLI
- **API**: LM Studio, Ollama (OpenAI-compatible endpoints)

## Security

- Binds to `0.0.0.0` for Tailscale network access
- Command runner uses an allowlist (npm, git, pm2, etc.)
- No shell interpolation — commands use spawn with arg arrays
- Designed for private networks only

## License

MIT
