using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class ConPtyRunner
{
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const int STARTF_USESTDHANDLES = 0x00000100;
    private const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
    private const uint INFINITE = 0xFFFFFFFF;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out SafeFileHandle hReadPipe,
        out SafeFileHandle hWritePipe,
        ref SECURITY_ATTRIBUTES lpPipeAttributes,
        int nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(
        COORD size,
        SafeFileHandle hInput,
        SafeFileHandle hOutput,
        uint dwFlags,
        out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr lpAttributeList,
        int dwAttributeCount,
        int dwFlags,
        ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList,
        uint dwFlags,
        IntPtr Attribute,
        IntPtr lpValue,
        IntPtr cbSize,
        IntPtr lpPreviousValue,
        IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    private static string QuoteWindowsArg(string arg)
    {
        if (string.IsNullOrEmpty(arg)) return "\"\"";
        bool needsQuotes = false;
        for (int i = 0; i < arg.Length; i++)
        {
            char c = arg[i];
            if (char.IsWhiteSpace(c) || c == '"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes) return arg;

        var sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < arg.Length; i++)
        {
            char c = arg[i];
            if (c == '\\')
            {
                backslashes++;
            }
            else if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
            }
            else
            {
                if (backslashes > 0)
                {
                    sb.Append('\\', backslashes);
                    backslashes = 0;
                }
                sb.Append(c);
            }
        }
        if (backslashes > 0)
        {
            sb.Append('\\', backslashes * 2);
        }
        sb.Append('"');
        return sb.ToString();
    }

    private static int Main(string[] args)
    {
        short cols = 120;
        short rows = 30;
        string cwd = Environment.CurrentDirectory;
        bool forwardStdin = false;
        var cmdParts = new List<string>();

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--")
            {
                for (int j = i + 1; j < args.Length; j++) cmdParts.Add(args[j]);
                break;
            }
            else if (a == "--cols" && i + 1 < args.Length)
            {
                short parsed;
                if (short.TryParse(args[++i], out parsed) && parsed >= 20 && parsed <= 1000) cols = parsed;
            }
            else if (a == "--rows" && i + 1 < args.Length)
            {
                short parsed;
                if (short.TryParse(args[++i], out parsed) && parsed >= 5 && parsed <= 500) rows = parsed;
            }
            else if (a == "--cwd" && i + 1 < args.Length)
            {
                cwd = args[++i];
            }
            else if (a == "--forward-stdin")
            {
                forwardStdin = true;
            }
        }

        if (cmdParts.Count == 0)
        {
            Console.Error.WriteLine("Usage: conpty-runner.exe [--cols N] [--rows N] [--cwd DIR] [--forward-stdin] -- <exe> [args...]");
            return 2;
        }

        var cmdLineBuilder = new StringBuilder();
        for (int i = 0; i < cmdParts.Count; i++)
        {
            if (i > 0) cmdLineBuilder.Append(' ');
            cmdLineBuilder.Append(QuoteWindowsArg(cmdParts[i]));
        }

        var sa = new SECURITY_ATTRIBUTES
        {
            nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
            bInheritHandle = 0,
            lpSecurityDescriptor = IntPtr.Zero
        };

        SafeFileHandle inputReadSide = null;
        SafeFileHandle inputWriteSide = null;
        SafeFileHandle outputReadSide = null;
        SafeFileHandle outputWriteSide = null;
        IntPtr hPC = IntPtr.Zero;
        IntPtr attrList = IntPtr.Zero;
        IntPtr hJob = IntPtr.Zero;
        var procInfo = new PROCESS_INFORMATION();

        try
        {
            if (!CreatePipe(out inputReadSide, out inputWriteSide, ref sa, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe(input) failed");
            if (!CreatePipe(out outputReadSide, out outputWriteSide, ref sa, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe(output) failed");

            var size = new COORD { X = cols, Y = rows };
            int hr = CreatePseudoConsole(size, inputReadSide, outputWriteSide, 0, out hPC);
            if (hr != 0)
                throw new Win32Exception(hr, "CreatePseudoConsole failed");

            IntPtr attrSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
            attrList = Marshal.AllocHGlobal(attrSize);
            if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");

            if (!UpdateProcThreadAttribute(
                attrList,
                0,
                (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                hPC,
                (IntPtr)IntPtr.Size,
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute failed");
            }

            var startupInfo = new STARTUPINFOEX
            {
                StartupInfo = new STARTUPINFO
                {
                    cb = Marshal.SizeOf(typeof(STARTUPINFOEX)),
                    dwFlags = STARTF_USESTDHANDLES,
                    hStdInput = IntPtr.Zero,
                    hStdOutput = IntPtr.Zero,
                    hStdError = IntPtr.Zero
                },
                lpAttributeList = attrList
            };

            bool created = CreateProcessW(
                null,
                cmdLineBuilder,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                IntPtr.Zero,
                cwd,
                ref startupInfo,
                out procInfo);

            if (!created)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");

            // Attach child process to a Kill-on-Close Job Object for clean teardown.
            hJob = CreateJobObjectW(IntPtr.Zero, null);
            if (hJob != IntPtr.Zero)
            {
                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    hJob,
                    JobObjectExtendedLimitInformation,
                    ref info,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
                AssignProcessToJobObject(hJob, procInfo.hProcess);
            }

            // Close the child-owned pipe ends immediately so outputReadSide reaches EOF when hPC closes.
            inputReadSide.Dispose();
            inputReadSide = null;
            outputWriteSide.Dispose();
            outputWriteSide = null;

            var stdoutStream = Console.OpenStandardOutput();
            var outputThread = new Thread(() =>
            {
                try
                {
                    using (var reader = new FileStream(outputReadSide, FileAccess.Read, 4096, false))
                    {
                        byte[] buf = new byte[4096];
                        int n;
                        while ((n = reader.Read(buf, 0, buf.Length)) > 0)
                        {
                            stdoutStream.Write(buf, 0, n);
                            stdoutStream.Flush();
                        }
                    }
                }
                catch
                {
                    // Pipe closed during shutdown.
                }
            });
            outputThread.IsBackground = true;
            outputThread.Start();

            if (forwardStdin)
            {
                var stdinThread = new Thread(() =>
                {
                    try
                    {
                        var stdinStream = Console.OpenStandardInput();
                        using (var writer = new FileStream(inputWriteSide, FileAccess.Write, 4096, false))
                        {
                            byte[] buf = new byte[4096];
                            int n;
                            while ((n = stdinStream.Read(buf, 0, buf.Length)) > 0)
                            {
                                writer.Write(buf, 0, n);
                                writer.Flush();
                            }
                        }
                    }
                    catch
                    {
                        // Stdin or PTY closed.
                    }
                });
                stdinThread.IsBackground = true;
                stdinThread.Start();
            }

            WaitForSingleObject(procInfo.hProcess, INFINITE);
            uint exitCode = 0;
            GetExitCodeProcess(procInfo.hProcess, out exitCode);

            if (hPC != IntPtr.Zero)
            {
                ClosePseudoConsole(hPC);
                hPC = IntPtr.Zero;
            }

            outputThread.Join(3000);
            return unchecked((int)exitCode);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("conpty-runner error: " + ex.Message);
            return 1;
        }
        finally
        {
            if (hPC != IntPtr.Zero) ClosePseudoConsole(hPC);
            if (attrList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attrList);
                Marshal.FreeHGlobal(attrList);
            }
            if (procInfo.hThread != IntPtr.Zero) CloseHandle(procInfo.hThread);
            if (procInfo.hProcess != IntPtr.Zero) CloseHandle(procInfo.hProcess);
            if (hJob != IntPtr.Zero) CloseHandle(hJob);
            if (inputReadSide != null) inputReadSide.Dispose();
            if (inputWriteSide != null) inputWriteSide.Dispose();
            if (outputReadSide != null) outputReadSide.Dispose();
            if (outputWriteSide != null) outputWriteSide.Dispose();
        }
    }
}
