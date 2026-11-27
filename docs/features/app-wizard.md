# App Wizard

The wizard supports two modes for registering apps in PortOS.

## Mode 1: Register Existing App

For apps already running on the system (any path, any user):

### Steps

1. **Basic Info**: Name, description, icon
2. **Location**: Repo path (file picker or manual entry)
3. **Ports**: UI port, API port (can auto-detect from running processes)
4. **Process Config**:
   - Start command(s)
   - PM2 process name(s)
   - Env file location
5. **Confirm & Register**

### Features

- Detect running processes on specified ports
- Validate repo path exists
- Optional: import existing PM2 process into registry
- No scaffolding, no git operations

## Mode 2: Create New App

Scaffold a new project from template:

### Steps

1. **Basic Info**: Name, description
2. **Template**: Select template (portos-stack, vite-express, vite-react, express-api, ios-native, xcode-multiplatform)
3. **Location**: Parent directory for new repo
4. **Ports**: Allocate from available range
5. **Git Setup**:
   - Initialize git
   - Create GitHub repo (optional, via `gh` CLI)
6. **Confirm & Create**

### Actions on create

- Copy template files
- Configure .env with ports
- Run `npm install`
- Initialize git + first commit
- Create GitHub repo (if selected)
- Generate PM2 ecosystem config
- Register in PortOS
- Start with PM2

## Update a managed app

**Update app** fetches the configured `portos.runtimeBranch` or origin's default branch. PortOS attempts a fast-forward first, then a rebase with autostash. Commit work to create a recovery point and preserve untracked files separately before updating. Submodule updates follow the revisions pinned by the parent repository. Branch, pull, or autostash conflicts stop the update before its lifecycle commands and restart. Review the reported conflict and any CoS resolution task before retrying.

After a successful pull, PortOS runs the first available lifecycle in this order.

1. **Update Command** in **Apps → Edit → Commands**.
2. The package script `portos:update` for Node or Bun apps.
3. The repository's executable `update.sh` or Windows `update.ps1`.

Use that lifecycle to install dependencies, run migrations, or build the app. PortOS then restarts the app's configured PM2 processes. For the PortOS app itself, its conventional script follows the [detached self-update flow](../SELF_UPDATE.md#every-portos-update-goes-through-the-detached-launcher).

## API Endpoints

| Route | Description |
|-------|-------------|
| POST /api/apps | Register existing app |
| POST /api/scaffold | Create new app from template |
| GET /api/scaffold/templates | List available templates |
| GET /api/scaffold/directories | Browse directories for the location picker (host control — operator session, or a local connection when no password is set) |
| POST /api/scaffold/templates/create | Create an app from a template (user-friendly wrapper around POST /api/scaffold) |

The wizard detects an existing repo over the `detect:start` Socket.IO event (`server/sockets/apps.js`, streamed by `server/services/streamingDetect.js`); there is no REST detection or standardization route. Standardizing an app likewise runs over the `app:standardize` and `standardize:start` socket events.

## Related Features

- [PM2 Configuration](../PM2.md)
- [Port Allocation](../PORTS.md)
- Scaffold templates — `GET /api/scaffold/templates` (`server/routes/scaffold.js`)
