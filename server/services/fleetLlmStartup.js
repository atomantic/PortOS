import { join } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { commandOutput } from '../lib/commandExists.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';

export async function installFleetHostLoginTask() {
  if (process.platform !== 'win32') return { success: true };
  const saved = await runStreamingCommand(process.execPath, [join(PATHS.root, 'node_modules/pm2/bin/pm2'), 'save'], undefined, { timeoutMs: 15000 });
  if (!saved.success) return saved;
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = join(PATHS.root, 'scripts', 'resume-fleet-host.js');
  // The hidden launcher avoids opening a terminal at each interactive login.
  const launch = `& ${quote(process.execPath)} ${quote(script)}`;
  const argument = '-NoProfile -WindowStyle Hidden -EncodedCommand ' + Buffer.from(launch, 'utf16le').toString('base64');
  const command = `$ErrorActionPreference='Stop'; $taskUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(argument)} -WorkingDirectory ${quote(PATHS.root)}; $trigger=New-ScheduledTaskTrigger -AtLogOn -User $taskUser; $principal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited; $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); Register-ScheduledTask -TaskName 'PortOS Dedicated Model Host' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`;
  return runStreamingCommand('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], undefined, { timeoutMs: 30000 });
}

export async function isFleetHostLoginTaskInstalled() {
  if (process.platform !== 'win32') return null;
  return Boolean(await commandOutput('schtasks.exe', ['/Query', '/TN', 'PortOS Dedicated Model Host', '/FO', 'CSV', '/NH'], { timeoutMs: 5000 }));
}
