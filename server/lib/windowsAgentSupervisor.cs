using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// The job handle, root process handle and creation time stay private. Job-list
// assignment is atomic with CreateProcess: no helper can escape before capture.
public static class WindowsAgentSupervisor
{
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int Size; public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public int Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr Minimum, Maximum;
        public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint PageFaults, Total, Active, Terminated;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, int size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    static void Require(bool success) { if (!success) throw new InvalidOperationException(); }
    static string Quote(string argument) {
        // Match Node's non-verbatim argv construction. The shared shim adapter
        // deliberately leaves caret-escaped cmd arguments unquoted, and bypasses
        // cmd entirely for arguments its parser cannot carry (including quotes).
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return argument;
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in argument) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);

    delegate bool ConsoleControl(uint kind);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(ConsoleControl handler, bool add);
    static int stopRequested;
    // Keep the delegate rooted. The child receives its own console event while
    // the supervisor survives Ctrl+C/Break to settle the entire owned Job.
    static readonly ConsoleControl consoleControl = kind => {
        if (kind != 0 && kind != 1) return false;
        Interlocked.Exchange(ref stopRequested, 1);
        return true;
    };

    static void WriteReceipt(string path, object receipt) {
        // A reader can observe either no receipt or the complete immutable proof.
        string temporary = path + ".pending";
        using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(receipt));
            file.Write(bytes, 0, bytes.Length);
            file.Flush(true);
        }
        File.Move(temporary, path);
    }
    public static int Main(string[] args) {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero;
        var inherited = new IntPtr[3];
        var process = new ProcessInfo();
        bool initialized = false;
        try {
            Require(args.Length == 1);
            var request = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(args[0]));
            string directory = Path.GetDirectoryName(args[0]);
            if ((bool)request["pty"]) Require(SetConsoleCtrlHandler(consoleControl, true));
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no descendant breakaway.
            Require(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)));
            for (int i = 0; i < 3; i++) {
                Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10 - i), GetCurrentProcess(), out inherited[i], 0, true, 2));
            }
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
            initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            for (int i = 0; i < 3; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, inherited[i]);
            jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupEx();
            startup.Startup.Size = Marshal.SizeOf(startup); startup.Attributes = attributes;
            startup.Startup.Flags = 0x100;
            startup.Startup.Input = inherited[0]; startup.Startup.Output = inherited[1]; startup.Startup.Error = inherited[2];
            string executable = (string)request["command"];
            Require(executable.IndexOf('\0') < 0 && ((string)request["cwd"]).IndexOf('\0') < 0);
            var arguments = new List<string>();
            foreach (object argument in (IEnumerable)request["args"]) {
                Require(((string)argument).IndexOf('\0') < 0);
                arguments.Add((string)argument);
            }
            var command = new StringBuilder(Quote(executable));
            if (Path.GetFileName(executable).Equals("cmd.exe", StringComparison.OrdinalIgnoreCase)
                && arguments.Count >= 2 && arguments[0].Equals("/c", StringComparison.OrdinalIgnoreCase)) {
                // The shared shim adapter already escaped these tokens for cmd.
                // /s consumes ONE outer quote pair; preserve the inner path/argv
                // quotes verbatim instead of applying CRT escaping to the body.
                command.Append(" /d /s /c \"");
                for (int i = 1; i < arguments.Count; i++) {
                    if (i > 1) command.Append(' ');
                    Require(arguments[i].IndexOf('"') < 0);
                    command.Append(Quote(arguments[i]));
                }
                command.Append('"');
            } else {
                foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            }
            // Inherit the caller's already composed environment and console/PTY.
            Require(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, (bool)request["pty"] ? 0x00080000u : 0x08080000u, IntPtr.Zero, (string)request["cwd"], ref startup, out process));
            long created, exited, kernel, user;
            Require(GetProcessTimes(process.Process, out created, out exited, out kernel, out user));
            Require(created > 0);
            WriteReceipt(Path.Combine(directory, "started.json"), new { owner = request["owner"], pid = process.Pid, created = created.ToString() });
            bool cancelling = false;
            while (true) {
                Accounting accounting;
                Require(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.Active == 0) {
                    Require(WaitForSingleObject(process.Process, 0) == 0);
                    uint code;
                    Require(GetExitCodeProcess(process.Process, out code));
                    WriteReceipt(Path.Combine(directory, "settled.json"), new { version = 1, owner = request["owner"], pid = process.Pid,
                        created = created.ToString(), settledAt = DateTime.UtcNow.ToString("o"), active = 0, exitCode = code });
                    return unchecked((int)code);
                }
                // Cancellation addresses the retained Job handle, never a PID.
                // The supervisor survives long enough to verify the job is empty.
                if (!cancelling && (Interlocked.CompareExchange(ref stopRequested, 0, 0) != 0 || File.Exists(Path.Combine(directory, "cancel")))) {
                    Require(TerminateJobObject(job, 1)); cancelling = true;
                }
                Thread.Sleep(25);
            }
        } catch { return 1; } // No exception paths or command text leave this boundary.
        finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            foreach (IntPtr handle in inherited) if (handle != IntPtr.Zero) CloseHandle(handle);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            foreach (IntPtr memory in new[] { attributes, handles, jobs }) if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
        }
    }
}
