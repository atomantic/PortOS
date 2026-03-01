# Troubleshooting Guide

Common issues and solutions when running PortOS.

## Startup Issues

### Port Already in Use

**Symptom**: Server fails to start with `EADDRINUSE` error.

**Solution**:
```bash
# Find what's using the port
lsof -i :5554
lsof -i :5555

# Kill the process or choose different ports in ecosystem.config.cjs
```

### PM2 Process Not Starting

**Symptom**: `pm2 start ecosystem.config.cjs` shows process but status is `errored`.

**Solution**:
```bash
# Check PM2 logs for errors
pm2 logs portos-server --lines 100

# Common causes:
# - Missing dependencies: npm run install:all
# - Missing data directory: mkdir -p data
# - Port conflict: check EADDRINUSE errors
```

### Missing Data Directory

**Symptom**: Server crashes with `ENOENT` errors about files in `data/`.

**Solution**:
```bash
# Copy sample data files
cp -r data.sample/* data/
```

## Connection Issues

### Cannot Access from Other Devices

**Symptom**: PortOS works on localhost but not from phone/tablet.

**Causes and Solutions**:

1. **Tailscale not connected**: Ensure both devices are on same Tailscale network
2. **Firewall blocking**: Check local firewall allows ports 5554-5555
3. **Server bound to localhost**: PortOS should bind to 0.0.0.0 (default)

```bash
# Verify server is listening on all interfaces
netstat -an | grep 5555
# Should show: *.5555 or 0.0.0.0:5555
```

### WebSocket Disconnections

**Symptom**: Real-time features (logs, CoS updates) stop working.

**Solution**:
- Check browser console for WebSocket errors
- Verify server is running: `pm2 status`
- Restart server: `pm2 restart ecosystem.config.cjs`

## AI Provider Issues

### Claude Code CLI Not Found

**Symptom**: DevTools runs fail with "command not found".

**Solution**:
```bash
# Install Claude Code globally
npm install -g @anthropic-ai/claude-code

# Verify installation
which claude
claude --version
```

### API Key Errors

**Symptom**: AI runs fail with authentication errors.

**Solution**:
1. Check provider configuration in PortOS Settings
2. Verify API key is valid and has credits
3. For Claude: ensure `ANTHROPIC_API_KEY` is set

### Model Not Found

**Symptom**: Error "model: xyz not found" or similar.

**Solution**:
- Verify model name matches provider's available models
- Check provider documentation for correct model identifiers
- Common models:
  - Claude: `claude-sonnet-4-20250514`, `claude-opus-4-5-20251101`
  - OpenAI: `gpt-4`, `gpt-4-turbo`
  - Ollama: Model must be pulled first (`ollama pull llama3`)

## Chief of Staff Issues

### CoS Not Running

**Symptom**: CoS page shows "Stopped" status.

**Solution**:
1. Click "Start" button in CoS UI
2. Or enable `alwaysOn: true` in CoS config
3. Check server logs for startup errors

### Agents Not Spawning

**Symptom**: Tasks stay in "pending" status, no agents start.

**Solution**:
```bash
# Check CoS runner is running
pm2 status | grep portos-cos

# Check runner logs
pm2 logs portos-cos --lines 100

# Verify Claude CLI is available
which claude
```

### Tasks Not Being Picked Up

**Symptom**: Added tasks to TASKS.md but CoS ignores them.

**Solution**:
1. Verify task format matches expected syntax:
   ```markdown
   ## Pending
   - [ ] #task-001 | HIGH | Task description
   ```
2. Check file path in CoS config matches your TASKS.md location
3. Trigger manual evaluation via UI

### Memory System Not Working

**Symptom**: Memory search returns no results, embeddings fail.

**Solution**:
1. Ensure LM Studio is running on port 1234
2. Load an embedding model in LM Studio (e.g., `nomic-embed-text`)
3. Check memory embeddings status: `GET /api/memory/embeddings/status`

## PM2 Issues

### Process Keeps Restarting

**Symptom**: PM2 shows high restart count, app unstable.

**Solution**:
```bash
# Check for crash reason
pm2 logs portos-server --lines 200

# Common causes:
# - Unhandled exceptions (check error handling)
# - Memory limit exceeded (increase max_memory_restart)
# - Missing environment variables
```

### Cannot Stop Processes

**Symptom**: `pm2 stop` doesn't work or processes restart.

**Solution**:
```bash
# Stop specific ecosystem
pm2 stop ecosystem.config.cjs

# Never use these (affects all PM2 apps):
# pm2 kill        ← Don't use
# pm2 delete all  ← Don't use
```

### Old Code Running After Changes

**Symptom**: Code changes don't take effect.

**Solution**:
```bash
# Restart to pick up changes
pm2 restart ecosystem.config.cjs

# For frontend changes, Vite hot-reload should work
# For server changes, PM2 watch mode can help (if enabled)
```

## Database/Data Issues

### Lost App Registrations

**Symptom**: Apps disappear after restart.

**Causes**:
- `data/apps.json` was deleted or corrupted
- File permissions prevent writing

**Solution**:
```bash
# Check file exists and is valid JSON
cat data/apps.json | jq .

# If corrupted, restore from backup or recreate
```

### History Not Persisting

**Symptom**: Action history clears on restart.

**Solution**:
- Check `data/history.json` exists and is writable
- Verify disk space available

## Performance Issues

### Slow UI Loading

**Causes and Solutions**:
1. **Large log files**: Clear old logs with `pm2 flush`
2. **Many apps**: Pagination added in recent versions
3. **Network latency**: Use local access when possible

### High Memory Usage

**Solution**:
```bash
# Check PM2 memory usage
pm2 monit

# Set memory limits in ecosystem.config.cjs
max_memory_restart: '500M'
```

### Agent Runs Timeout

**Symptom**: AI runs hit timeout before completing.

**Solution**:
- Increase timeout in provider settings
- Break large tasks into smaller chunks
- Check network connectivity to AI provider

## Development Issues

### Hot Reload Not Working

**Symptom**: Frontend changes require manual refresh.

**Solution**:
- Check Vite is running: `pm2 logs portos-client`
- Ensure file watchers aren't exhausted: `fs.inotify.max_user_watches`

### Tests Failing

**Solution**:
```bash
cd server
npm test

# For specific test file
npm test -- taskParser.test.js

# Watch mode for development
npm run test:watch
```

## Getting Help

1. **Check logs**: `pm2 logs` shows all process output
2. **Browser console**: F12 → Console for frontend errors
3. **Server logs**: Look for emoji prefixes (❌ errors, ⚠️ warnings)
4. **GitHub Issues**: Report bugs at https://github.com/atomantic/PortOS/issues
