import { useState, useEffect } from 'react';
import { Save, Eye, EyeOff, Trash2, Send } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import {
  getSettings, getTelegramStatus, updateTelegramConfig,
  deleteTelegramConfig, testTelegram, updateTelegramForwardTypes, updateTelegramMethod
} from '../../services/api';

const NOTIFICATION_TYPES = [
  { key: 'memory_approval', label: 'Memory Approvals' },
  { key: 'task_approval', label: 'Task Approvals' },
  { key: 'code_review', label: 'Code Reviews' },
  { key: 'health_issue', label: 'Health Issues' },
  { key: 'briefing_ready', label: 'Briefings' },
  { key: 'autobiography_prompt', label: 'Autobiography Prompts' },
  { key: 'plan_question', label: 'Plan Questions' }
];

export function TelegramTab() {
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState('manual');
  const [switching, setSwitching] = useState(false);
  const [tgToken, setTgToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [tgShowToken, setTgShowToken] = useState(false);
  const [tgStatus, setTgStatus] = useState(null);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgTesting, setTgTesting] = useState(false);
  const [tgDisconnecting, setTgDisconnecting] = useState(false);
  const [tgForwardTypes, setTgForwardTypes] = useState([]);

  useEffect(() => {
    Promise.all([
      getSettings(),
      getTelegramStatus().catch(() => null)
    ]).then(([settings, status]) => {
      if (status) {
        setTgStatus(status);
        setMethod(status.method || 'manual');
        setTgChatId(settings?.telegram?.chatId || '');
        setTgForwardTypes(status.forwardTypes || []);
      }
    }).catch(() => toast.error('Failed to load Telegram settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleMethodChange = async (newMethod) => {
    setSwitching(true);
    try {
      const status = await updateTelegramMethod(newMethod);
      setMethod(newMethod);
      setTgStatus(status);
      toast.success(newMethod === 'mcp-bridge'
        ? 'Switched to Claude MCP Bridge'
        : 'Switched to Manual Bot');
    } catch (err) {
      toast.error(err.message || 'Failed to switch method');
    } finally {
      setSwitching(false);
    }
  };

  const handleTelegramSave = async () => {
    if (!tgToken && !tgStatus?.hasToken) {
      toast.error('Bot token is required');
      return;
    }
    setTgSaving(true);
    try {
      const status = await updateTelegramConfig({ token: tgToken, chatId: tgChatId });
      setTgStatus(status);
      toast.success(tgChatId
        ? 'Telegram connected — check your chat for a test message'
        : 'Bot connected — now message your bot /start to get your Chat ID');
    } catch (err) {
      toast.error(err.message || 'Failed to configure Telegram');
    } finally {
      setTgSaving(false);
    }
  };

  const handleTelegramTest = async () => {
    setTgTesting(true);
    try {
      await testTelegram();
      toast.success('Test message sent');
    } catch (err) {
      toast.error(err.message || 'Failed to send test message');
    } finally {
      setTgTesting(false);
    }
  };

  const handleTelegramDisconnect = async () => {
    setTgDisconnecting(true);
    try {
      await deleteTelegramConfig();
      setTgStatus(null);
      setTgToken('');
      setTgChatId('');
      setTgForwardTypes([]);
      toast.success('Telegram disconnected');
    } catch (err) {
      toast.error(err.message || 'Failed to disconnect');
    } finally {
      setTgDisconnecting(false);
    }
  };

  const toggleForwardType = (type) => {
    const updated = tgForwardTypes.includes(type)
      ? tgForwardTypes.filter(t => t !== type)
      : [...tgForwardTypes, type];
    setTgForwardTypes(updated);
    updateTelegramForwardTypes(updated).catch(() => toast.error('Failed to update forward types'));
  };

  if (loading) {
    return <BrailleSpinner text="Loading Telegram settings" />;
  }

  return (
    <div className="space-y-4">
      {/* Method Selector */}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <label className="block text-sm text-gray-400">Integration Method</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => method !== 'manual' && handleMethodChange('manual')}
            disabled={switching}
            className={`p-4 rounded-lg border text-left transition-colors ${
              method === 'manual'
                ? 'border-port-accent bg-port-accent/10'
                : 'border-port-border bg-port-bg hover:border-port-accent/50'
            }`}
          >
            <div className="text-sm font-medium text-white">Manual Bot</div>
            <div className="text-xs text-gray-500 mt-1">
              Self-hosted polling bot with /status, /goals, /checkin commands. Requires bot token and chat ID.
            </div>
          </button>
          <button
            onClick={() => method !== 'mcp-bridge' && handleMethodChange('mcp-bridge')}
            disabled={switching}
            className={`p-4 rounded-lg border text-left transition-colors ${
              method === 'mcp-bridge'
                ? 'border-port-accent bg-port-accent/10'
                : 'border-port-border bg-port-bg hover:border-port-accent/50'
            }`}
          >
            <div className="text-sm font-medium text-white">Claude MCP Bridge</div>
            <div className="text-xs text-gray-500 mt-1">
              Uses Claude Code&apos;s Telegram plugin. Natural language inbound, PortOS notifications outbound.
            </div>
          </button>
        </div>
        {switching && <BrailleSpinner text="Switching..." />}
      </div>

      {/* Method-specific config */}
      {method === 'manual' ? (
        <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5">
          {(tgStatus?.connected || (tgStatus && !tgStatus.connected && tgStatus.hasToken)) && (
            <div className="text-sm">
              {tgStatus?.connected && (
                <span className="flex items-center gap-2 text-port-success break-all">
                  <span className="w-2 h-2 rounded-full bg-port-success shrink-0" />
                  @{tgStatus.botUsername}
                </span>
              )}
              {tgStatus && !tgStatus.connected && tgStatus.hasToken && (
                <span className="flex items-center gap-2 text-port-error">
                  <span className="w-2 h-2 rounded-full bg-port-error shrink-0" />
                  Disconnected
                </span>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-sm text-gray-400">Bot Token</label>
            <div className="flex gap-2">
              <input
                type={tgShowToken ? 'text' : 'password'}
                value={tgToken}
                onChange={e => setTgToken(e.target.value)}
                className="flex-1 min-w-0 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                placeholder={tgStatus?.hasToken ? '••••••••••• (configured)' : 'Paste bot token from @BotFather'}
              />
              <button
                onClick={() => setTgShowToken(!tgShowToken)}
                aria-label={tgShowToken ? 'Hide bot token' : 'Show bot token'}
                className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] px-3 py-2 bg-port-border hover:bg-port-border/70 text-white rounded-lg transition-colors shrink-0"
              >
                {tgShowToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-sm text-gray-400">Chat ID</label>
            <input
              type="text"
              value={tgChatId}
              onChange={e => setTgChatId(e.target.value)}
              className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
              placeholder="Message your bot /start to get your chat ID"
            />
          </div>

          <p className="text-xs text-gray-500">
            1. Message <code>@BotFather</code> on Telegram, send <code>/newbot</code>, copy the token, paste above, click Save.
            2. Message your bot <code>/start</code> — it will reply with your Chat ID.
            3. Paste the Chat ID above and click Save & Test.
          </p>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <button
              onClick={handleTelegramSave}
              disabled={tgSaving || (!tgToken && !tgStatus?.hasToken)}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {tgSaving ? <BrailleSpinner /> : <Save size={16} />}
              {tgStatus?.connected && tgChatId ? 'Save & Test' : 'Save'}
            </button>
            {tgStatus?.connected && (
              <button
                onClick={handleTelegramTest}
                disabled={tgTesting}
                className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {tgTesting ? <BrailleSpinner /> : <Send size={16} />}
                Send Test
              </button>
            )}
            {(tgStatus?.hasToken || tgStatus?.hasChatId) && (
              <button
                onClick={handleTelegramDisconnect}
                disabled={tgDisconnecting}
                className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-error/20 hover:bg-port-error/30 text-port-error text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {tgDisconnecting ? <BrailleSpinner /> : <Trash2 size={16} />}
                Disconnect
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="text-sm">
              {tgStatus?.connected ? (
                <span className="flex items-center gap-2 text-port-success">
                  <span className="w-2 h-2 rounded-full bg-port-success" />
                  @{tgStatus.botUsername} → {tgStatus.chatId}
                </span>
              ) : (
                <span className="flex items-center gap-2 text-port-warning">
                  <span className="w-2 h-2 rounded-full bg-port-warning" />
                  Not connected
                </span>
              )}
            </div>
          </div>

          <div className="text-xs text-gray-500 space-y-2">
            <p>
              The MCP Bridge reads config from Claude Code&apos;s Telegram plugin at <code>~/.claude/channels/telegram/</code>.
              Bot token comes from <code>.env</code>, chat ID from the first entry in <code>access.json</code> allowlist.
            </p>
            <p>
              <b>Outbound:</b> PortOS sends notifications via direct Telegram Bot API calls (no polling conflict).
            </p>
            <p>
              <b>Inbound:</b> Messages are handled by Claude Code via the MCP plugin — natural language instead of rigid commands.
            </p>
            {!tgStatus?.connected && (
              <p className="text-port-warning">
                Set up the Claude Code Telegram plugin first: run <code>/telegram:configure</code> in Claude Code, then <code>/telegram:access pair &lt;code&gt;</code> to approve your chat.
              </p>
            )}
          </div>

          {tgStatus?.connected && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleTelegramTest}
                disabled={tgTesting}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {tgTesting ? <BrailleSpinner /> : <Send size={16} />}
                Send Test
              </button>
            </div>
          )}
        </div>
      )}

      {/* Forward types (shared between both methods) */}
      {tgStatus?.connected && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-2">
          <label className="block text-sm text-gray-400">Forward Notification Types</label>
          <p className="text-xs text-gray-500">When all are unchecked, all types are forwarded</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {NOTIFICATION_TYPES.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tgForwardTypes.includes(key)}
                  onChange={() => toggleForwardType(key)}
                  className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default TelegramTab;
