using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// The job handle, root process handle and creation time stay private. Job-list
// assignment is atomic with CreateProcess: no helper can escape before capture.
public static class WindowsGitSupervisor
{
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
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
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    static void Require(bool success) { if (!success) throw new InvalidOperationException(); }
    static string Quote(string argument) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in argument) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static readonly object outputLock = new object();
    static readonly ConcurrentDictionary<string, ManualResetEventSlim> jobs = new ConcurrentDictionary<string, ManualResetEventSlim>();
    static void Emit(object value) {
        lock (outputLock) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); }
    }
    static bool Pump(string id, string channel, SafeFileHandle handle) {
        try {
            using (var stream = new FileStream(handle, FileAccess.Read, 16384, false)) {
                var buffer = new byte[16384];
                int count;
                while ((count = stream.Read(buffer, 0, buffer.Length)) > 0)
                    Emit(new { kind = "data", id, channel, data = Convert.ToBase64String(buffer, 0, count) });
                return true;
            }
        } catch { return false; }
    }
    static void ClosePipe(SafeFileHandle handle) {
        if (handle == null) return;
        // P/Invoke pins this exact handle during cancellation. A pump can
        // dispose it concurrently; never address its recycled numeric value.
        try { CancelIoEx(handle, IntPtr.Zero); } catch (ObjectDisposedException) { }
        handle.Dispose();
    }
    static void Run(Dictionary<string, object> request, string id, ManualResetEventSlim cancel) {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero, errorRead = IntPtr.Zero, environment = IntPtr.Zero;
        var process = new ProcessInfo();
        bool launched = false, settled = false, initialized = false;
        SafeFileHandle stdoutPipe = null, stderrPipe = null;
        Task<bool> stdout = null, stderr = null;
        string reason = "launch-failed";
        uint exitCode = 1;
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; breakaway is never enabled.
            Require(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)));
            var security = new Security { Length = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Require(input != new IntPtr(-1));
            Require(CreatePipe(out outputRead, out output, ref security, 0));
            Require(CreatePipe(out errorRead, out error, ref security, 0));
            Require(SetHandleInformation(outputRead, 1, 0));
            Require(SetHandleInformation(errorRead, 1, 0));
            stdoutPipe = new SafeFileHandle(outputRead, true); outputRead = IntPtr.Zero;
            stderrPipe = new SafeFileHandle(errorRead, true); errorRead = IntPtr.Zero;
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
            initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
            jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupEx();
            startup.Startup.Size = Marshal.SizeOf(startup); startup.Attributes = attributes;
            startup.Startup.Flags = 0x100; startup.Startup.Input = input; startup.Startup.Output = output; startup.Startup.Error = error;
            string executable = (string)request["executable"];
            var command = new StringBuilder(Quote(executable));
            foreach (object argument in (IEnumerable)request["args"]) command.Append(' ').Append(Quote((string)argument));
            var env = (Dictionary<string, object>)request["env"];
            var keys = new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
            var block = new StringBuilder();
            foreach (string key in keys) block.Append(key).Append('=').Append((string)env[key]).Append('\0');
            block.Append('\0');
            environment = Marshal.StringToHGlobalUni(block.ToString());
            Require(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080400, environment, (string)request["cwd"], ref startup, out process));
            launched = true;
            CloseHandle(output); output = IntPtr.Zero; CloseHandle(error); error = IntPtr.Zero;
            stdout = Task.Factory.StartNew(() => Pump(id, "stdout", stdoutPipe), TaskCreationOptions.LongRunning);
            stderr = Task.Factory.StartNew(() => Pump(id, "stderr", stderrPipe), TaskCreationOptions.LongRunning);
            long created, exited, kernel, user;
            Require(GetProcessTimes(process.Process, out created, out exited, out kernel, out user));
            // Retaining the native handle binds this evidence to this process,
            // even after its PID is recycled. No PID-addressed kills are used.
            Require(created > 0);
            Stopwatch cancellation = null;
            reason = "inspection-failed";
            while (true) {
                Accounting accounting;
                Require(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.Active == 0 && stdout.IsCompleted && stderr.IsCompleted) {
                    reason = "pipes-unconfirmed";
                    Require(stdout.Result && stderr.Result);
                    Require(WaitForSingleObject(process.Process, 0) == 0);
                    Require(GetExitCodeProcess(process.Process, out exitCode));
                    settled = true; reason = "settled"; break;
                }
                if (cancellation == null && cancel.IsSet) {
                    reason = "termination-unconfirmed";
                    Require(TerminateJobObject(job, 1));
                    cancellation = Stopwatch.StartNew();
                }
                if (cancellation != null && cancellation.ElapsedMilliseconds >= 3000) break;
                Thread.Sleep(10);
            }
        } catch { /* Only bounded state crosses the process boundary. */ }
        finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
            ClosePipe(stdoutPipe); ClosePipe(stderrPipe);
            if (outputRead != IntPtr.Zero) CloseHandle(outputRead);
            if (errorRead != IntPtr.Zero) CloseHandle(errorRead);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            foreach (IntPtr memory in new[] { attributes, handles, jobs, environment }) if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
        }
        try {
            Emit(new { kind = "done", id, settled = settled || !launched, launched, exitCode, reason });
        } catch { /* Owner loss closes every job handle when this process exits. */ }
        ManualResetEventSlim ignored;
        WindowsGitSupervisor.jobs.TryRemove(id, out ignored);
    }
    public static int Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Emit(new { kind = "ready" });
        try {
            string line;
            while ((line = Console.ReadLine()) != null) {
                var request = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Deserialize<Dictionary<string, object>>(line);
                string id = (string)request["id"];
                if ((string)request["action"] == "cancel") {
                    ManualResetEventSlim existing;
                    if (jobs.TryGetValue(id, out existing)) existing.Set();
                } else if ((string)request["action"] == "start") {
                    var cancel = new ManualResetEventSlim();
                    Require(jobs.TryAdd(id, cancel));
                    Task.Run(() => Run(request, id, cancel));
                } else throw new InvalidOperationException();
            }
        } catch { /* Invalid control or EOF cancels the exact owned jobs. */ }
        foreach (var pair in jobs) pair.Value.Set();
        var deadline = Stopwatch.StartNew();
        while (!jobs.IsEmpty && deadline.ElapsedMilliseconds < 4000) Thread.Sleep(10);
        return jobs.IsEmpty ? 0 : 1;
    }
}
