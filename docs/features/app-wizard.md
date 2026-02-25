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
2. **Template**: Select template (vite+express, node-server, static)
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

## API Endpoints

| Route | Description |
|-------|-------------|
| POST /api/apps | Register existing app |
| POST /api/scaffold | Create new app from template |
| GET /api/scaffold/templates | List available templates |
| POST /api/detect/ports | Detect process on port |
| POST /api/detect/repo | Validate repo path, detect type |

## Related Features

- [PM2 Configuration](../PM2.md)
- [Port Allocation](../PORTS.md)
- [Templates System](#m7-app-templates)
