package com.filemonitor;

import com.sun.jna.platform.win32.User32;
import com.sun.jna.platform.win32.WinDef.HWND;
import com.sun.jna.ptr.IntByReference;
import java.util.Optional;

public class ProcessTracker {
    public static class ProcessInfo {
        public final int pid;
        public final String name;
        public final String path;

        public ProcessInfo(int pid, String name, String path) {
            this.pid = pid;
            this.name = name;
            this.path = path;
        }
    }

    public static ProcessInfo getForegroundProcess() {
        try {
            HWND hwnd = User32.INSTANCE.GetForegroundWindow();
            if (hwnd == null) {
                return new ProcessInfo(-1, "unknown", "");
            }
            IntByReference pidRef = new IntByReference();
            User32.INSTANCE.GetWindowThreadProcessId(hwnd, pidRef);
            int pid = pidRef.getValue();
            if (pid <= 0) {
                return new ProcessInfo(-1, "unknown", "");
            }

            Optional<ProcessHandle> handleOpt = ProcessHandle.of(pid);
            if (handleOpt.isPresent()) {
                ProcessHandle.Info info = handleOpt.get().info();
                String path = info.command().orElse("");
                String name = path.substring(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
                if (name.isEmpty()) {
                    name = "Process-" + pid;
                }
                return new ProcessInfo(pid, name, path);
            }
            return new ProcessInfo(pid, "Process-" + pid, "");
        } catch (Exception e) {
            return new ProcessInfo(-1, "unknown", "");
        }
    }
}
