using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

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
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
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
    static IntPtr DuplicateStandard(int kind) {
        IntPtr handle;
        Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out handle, 0, true, 2));
        return handle;
    }

    public static int Main(string[] argv) {
        var json = new JavaScriptSerializer();
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        var process = new ProcessInfo();
        bool launched = false, settled = false, initialized = false;
        string reason = "launch-failed";
        uint exitCode = 1;
        try {
            Console.InputEncoding = new UTF8Encoding(false);
            var args = json.Deserialize<string[]>(Console.ReadLine());
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; breakaway is never enabled.
            Require(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)));
            var security = new Security { Length = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Require(input != new IntPtr(-1));
            output = DuplicateStandard(-11); error = DuplicateStandard(-12);
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
            var command = new StringBuilder(Quote(args[0]));
            for (int index = 1; index < args.Length; index++) command.Append(' ').Append(Quote(args[index]));
            Require(CreateProcess(args[0], command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, null, ref startup, out process));
            launched = true;
            long created, exited, kernel, user;
            Require(GetProcessTimes(process.Process, out created, out exited, out kernel, out user));
            // Retaining the native handle binds this evidence to this process,
            // even after its PID is recycled. No PID-addressed kills are used.
            Require(created > 0);
            var cancel = Task.Run(() => Console.ReadLine());
            Stopwatch cancellation = null;
            reason = "inspection-failed";
            while (true) {
                Accounting accounting;
                Require(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.Active == 0) {
                    Require(WaitForSingleObject(process.Process, 0) == 0);
                    Require(GetExitCodeProcess(process.Process, out exitCode));
                    settled = true; reason = "settled"; break;
                }
                // EOF is cancellation too: losing the owning Node process must
                // never leave a running Git tree behind.
                if (cancellation == null && cancel.IsCompleted) {
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
            if (initialized) DeleteProcThreadAttributeList(attributes);
            foreach (IntPtr memory in new[] { attributes, handles, jobs }) if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
        }
        try {
            File.WriteAllText(argv[0], json.Serialize(new { settled = settled || !launched, launched, exitCode, reason }));
        } catch { return 1; }
        return settled ? 0 : 1;
    }
}
