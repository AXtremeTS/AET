#define UNICODE
#define _UNICODE
#define INITGUID
#include <windows.h>
#include <evntrace.h>
#include <evntcons.h>
#include <tdh.h>
#include <iostream>
#include <string>
#include <map>
#include <vector>
#include <Psapi.h>
#include <tlhelp32.h>
#include <chrono>
#include <iomanip>
#include <sstream>
#include <mutex>
#include <set>
#include <cwctype>
#include <algorithm>

#pragma comment(lib, "tdh.lib")
#pragma comment(lib, "advapi32.lib")

#define KERNEL_LOGGER_NAME L"NT Kernel Logger"

#ifndef EVENT_TRACE_FLAG_FILE_IO_INIT
#define EVENT_TRACE_FLAG_FILE_IO_INIT 0x04000000
#endif

// ETW GUIDs
const GUID FileIoGuid = { 0x90cbdc39, 0x4a3e, 0x11d1, { 0x84, 0xf4, 0x00, 0x00, 0xf8, 0x04, 0x64, 0xe3 } };
const GUID ProcessGuid = { 0x3d6fa8d0, 0xfe05, 0x11d0, { 0x9d, 0xda, 0x00, 0xc0, 0x4f, 0xd7, 0xba, 0x7c } };

struct ProcessInfo {
    std::string name;
    std::string exe;
    HANDLE hProcess = NULL;
    uint64_t exitTime = 0;
};

std::map<ULONG64, std::wstring> g_fileObjectMap;
std::map<DWORD, ProcessInfo> g_procInfoMap;
std::mutex g_procMutex;
std::map<std::wstring, uint64_t> g_dedupCache;

std::set<std::wstring> g_watchTargets;
std::mutex g_watchMutex;

std::map<std::wstring, std::wstring> g_deviceMap;
bool g_globalMode = true;
bool g_ignoreSystemApps = true;

void InitializeDeviceMap() {
    wchar_t drive[] = L"A:";
    wchar_t devicePath[MAX_PATH];
    for (char c = 'A'; c <= 'Z'; c++) {
        drive[0] = c;
        if (QueryDosDeviceW(drive, devicePath, MAX_PATH) != 0) {
            g_deviceMap[devicePath] = drive;
        }
    }
}

std::wstring DevicePathToDrivePath(const std::wstring& devicePath) {
    for (const auto& pair : g_deviceMap) {
        if (devicePath.compare(0, pair.first.length(), pair.first) == 0) {
            return pair.second + devicePath.substr(pair.first.length());
        }
    }
    return devicePath;
}

bool CaseInsensitiveStartsWith(const std::wstring& str, const std::wstring& prefix) {
    if (str.length() < prefix.length()) return false;
    return std::equal(prefix.begin(), prefix.end(), str.begin(),
        [](wchar_t a, wchar_t b) {
            return std::towlower(a) == std::towlower(b);
        });
}

std::string GetTimestamp() {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()) % 1000;
    auto timer = std::chrono::system_clock::to_time_t(now);
    std::tm bt{};
    gmtime_s(&bt, &timer);
    std::ostringstream oss;
    oss << std::put_time(&bt, "%Y-%m-%dT%H:%M:%S") << '.' << std::setfill('0') << std::setw(3) << ms.count() << "Z";
    return oss.str();
}

std::string GetProcessNameFromToolhelp(DWORD pid) {
    std::string name = "";
    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnapshot != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe32;
        pe32.dwSize = sizeof(PROCESSENTRY32W);
        if (Process32FirstW(hSnapshot, &pe32)) {
            do {
                if (pe32.th32ProcessID == pid) {
                    std::wstring wname(pe32.szExeFile);
                    int size = WideCharToMultiByte(CP_UTF8, 0, wname.c_str(), -1, NULL, 0, NULL, NULL);
                    if (size > 0) {
                        std::string str(size, 0);
                        WideCharToMultiByte(CP_UTF8, 0, wname.c_str(), -1, &str[0], size, NULL, NULL);
                        if (!str.empty() && str.back() == '\0') {
                            str.pop_back();
                        }
                        name = str;
                    }
                    break;
                }
            } while (Process32NextW(hSnapshot, &pe32));
        }
        CloseHandle(hSnapshot);
    }
    return name;
}

ProcessInfo GetProcInfo(DWORD pid) {
    if (pid == 0) return { "System Idle Process", "", NULL, 0 };
    if (pid == 4) return { "System", "", NULL, 0 };

    std::lock_guard<std::mutex> lock(g_procMutex);
    if (g_procInfoMap.count(pid)) {
        return g_procInfoMap[pid];
    }

    ProcessInfo info = { "Unknown", "", NULL, 0 };
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (hProcess) {
        char name[MAX_PATH];
        DWORD size = MAX_PATH;
        if (QueryFullProcessImageNameA(hProcess, 0, name, &size)) {
            info.exe = name;
            size_t pos = info.exe.find_last_of("\\/");
            info.name = (pos != std::string::npos) ? info.exe.substr(pos + 1) : info.exe;
            info.hProcess = hProcess;
        } else {
            CloseHandle(hProcess);
        }
    }
    
    // Fallback using Toolhelp32 snapshot if OpenProcess/QueryImage fails (works for protected/elevated apps)
    if (info.name == "Unknown") {
        std::string toolhelpName = GetProcessNameFromToolhelp(pid);
        if (!toolhelpName.empty()) {
            info.name = toolhelpName;
        } else {
            info.name = "PID " + std::to_string(pid);
        }
    }
    
    // Unconditionally cache the result (even if "Unknown" or "PID xxxx") to avoid spamming snapshots
    if (info.hProcess == NULL) {
        info.exitTime = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()
        ).count();
    }
    g_procInfoMap[pid] = info;
    return info;
}

void ReplaceAll(std::string& str, const std::string& from, const std::string& to) {
    size_t start_pos = 0;
    while((start_pos = str.find(from, start_pos)) != std::string::npos) {
        str.replace(start_pos, from.length(), to);
        start_pos += to.length();
    }
}

std::string EscapeJsonString(const std::wstring& wstr) {
    if (wstr.empty()) return "";
    int size = WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), -1, NULL, 0, NULL, NULL);
    std::string str(size, 0);
    WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), -1, &str[0], size, NULL, NULL);
    if (!str.empty() && str.back() == '\0') str.pop_back();

    ReplaceAll(str, "\\", "\\\\");
    ReplaceAll(str, "\"", "\\\"");
    return str;
}

std::wstring GetPropertyString(PEVENT_RECORD pEvent, const wchar_t* propName) {
    PROPERTY_DATA_DESCRIPTOR desc;
    desc.PropertyName = (ULONGLONG)propName;
    desc.ArrayIndex = ULONG_MAX;
    DWORD propSize = 0;
    if (TdhGetPropertySize(pEvent, 0, NULL, 1, &desc, &propSize) == ERROR_SUCCESS) {
        std::vector<BYTE> buffer(propSize);
        if (TdhGetProperty(pEvent, 0, NULL, 1, &desc, propSize, buffer.data()) == ERROR_SUCCESS) {
            return std::wstring((wchar_t*)buffer.data());
        }
    }
    return L"";
}

ULONG64 GetPropertyPointer(PEVENT_RECORD pEvent, const wchar_t* propName) {
    PROPERTY_DATA_DESCRIPTOR desc;
    desc.PropertyName = (ULONGLONG)propName;
    desc.ArrayIndex = ULONG_MAX;
    DWORD propSize = 0;
    if (TdhGetPropertySize(pEvent, 0, NULL, 1, &desc, &propSize) == ERROR_SUCCESS) {
        if (propSize == 8) {
            ULONG64 val;
            if (TdhGetProperty(pEvent, 0, NULL, 1, &desc, propSize, (PBYTE)&val) == ERROR_SUCCESS) return val;
        } else if (propSize == 4) {
            ULONG32 val;
            if (TdhGetProperty(pEvent, 0, NULL, 1, &desc, propSize, (PBYTE)&val) == ERROR_SUCCESS) return val;
        }
    }
    return 0;
}

void EmitFileEvent(PEVENT_RECORD pEvent, ULONG64 fileObj, const std::string& op) {
    if (fileObj == 0 || g_fileObjectMap.find(fileObj) == g_fileObjectMap.end()) {
        return;
    }
    
    std::wstring fileName = g_fileObjectMap[fileObj];
    if (fileName.empty()) return;
    
    std::wstring drivePath = DevicePathToDrivePath(fileName);
    
    bool matches = false;
    {
        std::lock_guard<std::mutex> lock(g_watchMutex);
        if (g_globalMode) {
            matches = true;
        } else if (g_watchTargets.empty()) {
            matches = false;
        } else {
            for (const auto& target : g_watchTargets) {
                if (CaseInsensitiveStartsWith(drivePath, target)) {
                    matches = true;
                    break;
                }
            }
        }
    }

    if (matches) {
        DWORD pid = pEvent->EventHeader.ProcessId;
        
        std::wstring dedupKey = std::to_wstring(pid) + L"|" + drivePath + L"|" + std::wstring(op.begin(), op.end());
        uint64_t currentMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        
        if (g_dedupCache.count(dedupKey) && (currentMs - g_dedupCache[dedupKey]) < 100) {
            return; // Skip duplicate event
        }
        g_dedupCache[dedupKey] = currentMs;
        
        // Periodic cleanup to prevent memory leak
        if (g_dedupCache.size() > 10000) {
            g_dedupCache.clear();
        }

        ProcessInfo pInfo = GetProcInfo(pid);
        
        // EXCLUDE OUR APP FROM MONITOR
        std::string lowerName = pInfo.name;
        std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(), ::tolower);
        if (lowerName == "main.exe" || lowerName == "app.exe" || lowerName == "file-monitor.exe" || lowerName == "afm.exe" || lowerName == "msedgewebview2.exe") {
            return;
        }

        if (g_ignoreSystemApps) {
            if (lowerName == "svchost.exe" || lowerName == "system" || lowerName == "registry" || 
                lowerName == "csrss.exe" || lowerName == "lsass.exe" || lowerName == "smss.exe" || 
                lowerName == "services.exe" || lowerName == "explorer.exe") {
                return;
            }
        }
        
        std::string escapedExePath = pInfo.exe;
        ReplaceAll(escapedExePath, "\\", "\\\\");
        ReplaceAll(escapedExePath, "\"", "\\\"");
        std::string escapedPath = EscapeJsonString(drivePath);
        
        std::cout << "{\"event_type\":\"FILE_CHANGE\",\"data\":{"
                  << "\"timestamp\":\"" << GetTimestamp() << "\","
                  << "\"pid\":" << pid << ","
                  << "\"process_name\":\"" << pInfo.name << "\","
                  << "\"executable_path\":\"" << escapedExePath << "\","
                  << "\"file_path\":\"" << escapedPath << "\","
                  << "\"operation_type\":\"" << op << "\"}}\n";
        std::cout.flush();
    }
}

void WINAPI EventRecordCallback(PEVENT_RECORD pEvent) {
    if (IsEqualGUID(pEvent->EventHeader.ProviderId, ProcessGuid)) {
        UCHAR opcode = pEvent->EventHeader.EventDescriptor.Opcode;
        // Process_Start (1) or Process_DCStart (3)
        if (opcode == 1 || opcode == 3) {
            DWORD targetPid = GetPropertyPointer(pEvent, L"ProcessId");
            if (targetPid != 0) {
                std::lock_guard<std::mutex> lock(g_procMutex);
                if (g_procInfoMap.count(targetPid)) {
                    if (g_procInfoMap[targetPid].hProcess) {
                        CloseHandle(g_procInfoMap[targetPid].hProcess);
                    }
                    g_procInfoMap.erase(targetPid); // Invalidate cache
                }

                // Immediately resolve and cache process details to prevent lag on first file I/O
                ProcessInfo info = { "Unknown", "", NULL, 0 };
                HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, targetPid);
                if (hProcess) {
                    char name[MAX_PATH];
                    DWORD size = MAX_PATH;
                    if (QueryFullProcessImageNameA(hProcess, 0, name, &size)) {
                        info.exe = name;
                        size_t pos = info.exe.find_last_of("\\/");
                        info.name = (pos != std::string::npos) ? info.exe.substr(pos + 1) : info.exe;
                        info.hProcess = hProcess;
                    } else {
                        CloseHandle(hProcess);
                    }
                }
                
                if (info.name == "Unknown") {
                    std::string toolhelpName = GetProcessNameFromToolhelp(targetPid);
                    if (!toolhelpName.empty()) {
                        info.name = toolhelpName;
                    } else {
                        info.name = "PID " + std::to_string(targetPid);
                    }
                }
                
                if (info.hProcess == NULL) {
                    info.exitTime = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::system_clock::now().time_since_epoch()
                    ).count();
                }
                
                g_procInfoMap[targetPid] = info;
            }
        }
        // Process_End (2) or Process_DCEnd (4)
        else if (opcode == 2 || opcode == 4) {
            DWORD targetPid = GetPropertyPointer(pEvent, L"ProcessId");
            if (targetPid != 0) {
                std::lock_guard<std::mutex> lock(g_procMutex);
                if (g_procInfoMap.count(targetPid)) {
                    g_procInfoMap[targetPid].exitTime = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::system_clock::now().time_since_epoch()
                    ).count();
                }
            }
        }
    }
    else if (IsEqualGUID(pEvent->EventHeader.ProviderId, FileIoGuid)) {
        UCHAR opcode = pEvent->EventHeader.EventDescriptor.Opcode;
        
        if (opcode == 0) { // FileIo_Name
            ULONG64 fileObj = GetPropertyPointer(pEvent, L"FileObject");
            std::wstring fileName = GetPropertyString(pEvent, L"FileName");
            if (fileObj != 0 && !fileName.empty()) {
                g_fileObjectMap[fileObj] = fileName;
            }
        } 
        else if (opcode == 64) { // FileIo_Create
            ULONG64 fileObj = GetPropertyPointer(pEvent, L"FileObject");
            std::wstring openPath = GetPropertyString(pEvent, L"OpenPath");
            if (fileObj != 0 && !openPath.empty()) {
                g_fileObjectMap[fileObj] = openPath;
            }
            EmitFileEvent(pEvent, fileObj, "CREATE");
        }
        else if (opcode == 67) { // FileIo_Read
            ULONG64 fileObj = GetPropertyPointer(pEvent, L"FileObject");
            EmitFileEvent(pEvent, fileObj, "READ");
        }
        else if (opcode == 68) { // FileIo_Write
            ULONG64 fileObj = GetPropertyPointer(pEvent, L"FileObject");
            EmitFileEvent(pEvent, fileObj, "MODIFY");
        }
        else if (opcode == 66) { // FileIo_Close
            ULONG64 fileObj = GetPropertyPointer(pEvent, L"FileObject");
            if (fileObj != 0) {
                g_fileObjectMap.erase(fileObj);
            }
        }
    }
}

DWORD WINAPI CacheCleanupThread(LPVOID lpParam) {
    while (true) {
        Sleep(2000); // Check for exited processes every 2 seconds
        
        uint64_t currentMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()
        ).count();
        
        std::vector<DWORD> pidsToRemove;
        {
            std::lock_guard<std::mutex> lock(g_procMutex);
            for (auto& pair : g_procInfoMap) {
                DWORD pid = pair.first;
                auto& info = pair.second;
                
                if (info.hProcess) {
                    DWORD exitCode = 0;
                    if (GetExitCodeProcess(info.hProcess, &exitCode) && exitCode != STILL_ACTIVE) {
                        if (info.exitTime == 0) {
                            info.exitTime = currentMs;
                        }
                    }
                    
                    // Keep process in cache for 5 seconds after exit to allow late events to resolve
                    if (info.exitTime != 0 && (currentMs - info.exitTime) > 5000) {
                        pidsToRemove.push_back(pid);
                    }
                } else {
                    // Fallback entries (no handle held). Keep in cache for 5 seconds to throttle snapshot spam
                    if (info.exitTime == 0) {
                        info.exitTime = currentMs;
                    }
                    if (currentMs - info.exitTime > 5000) {
                        pidsToRemove.push_back(pid);
                    }
                }
            }
            
            for (DWORD pid : pidsToRemove) {
                if (g_procInfoMap[pid].hProcess) {
                    CloseHandle(g_procInfoMap[pid].hProcess);
                }
                g_procInfoMap.erase(pid);
            }
        }
    }
    return 0;
}

DWORD WINAPI ParseStdinThread(LPVOID lpParam) {
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        if (line == "EXIT") {
            break;
        }
        else if (line == "GLOBAL:1") {
            std::lock_guard<std::mutex> lock(g_watchMutex);
            g_globalMode = true;
            continue;
        }
        else if (line == "GLOBAL:0") {
            std::lock_guard<std::mutex> lock(g_watchMutex);
            g_globalMode = false;
            continue;
        }
        else if (line == "IGNORE_SYS:1") {
            std::lock_guard<std::mutex> lock(g_watchMutex);
            g_ignoreSystemApps = true;
            continue;
        }
        else if (line == "IGNORE_SYS:0") {
            std::lock_guard<std::mutex> lock(g_watchMutex);
            g_ignoreSystemApps = false;
            continue;
        }
        else if (line == "CLEAR") {
            std::lock_guard<std::mutex> lock(g_watchMutex);
            g_watchTargets.clear();
            continue;
        }

        if (line.rfind("ADD:", 0) == 0) {
            std::string pathStr = line.substr(4);
            int size = MultiByteToWideChar(CP_UTF8, 0, pathStr.c_str(), -1, NULL, 0);
            std::wstring target(size, 0);
            MultiByteToWideChar(CP_UTF8, 0, pathStr.c_str(), -1, &target[0], size);
            if (!target.empty() && target.back() == L'\0') target.pop_back();

            std::lock_guard<std::mutex> lock(g_watchMutex);
            g_watchTargets.insert(target);
            continue;
        }

        if (line.rfind("REMOVE:", 0) == 0) {
            std::string pathStr = line.substr(7);
            int size = MultiByteToWideChar(CP_UTF8, 0, pathStr.c_str(), -1, NULL, 0);
            std::wstring target(size, 0);
            MultiByteToWideChar(CP_UTF8, 0, pathStr.c_str(), -1, &target[0], size);
            if (!target.empty() && target.back() == L'\0') target.pop_back();

            std::lock_guard<std::mutex> lock(g_watchMutex);
            g_watchTargets.erase(target);
            continue;
        }
    }
    return 0;
}

int main(int argc, char* argv[]) {
    std::cout << "{\"event_type\":\"SYSTEM\",\"data\":\"ETW Monitor Started\"}\n";
    std::cout.flush();

    InitializeDeviceMap();

    CreateThread(NULL, 0, ParseStdinThread, NULL, 0, NULL);
    CreateThread(NULL, 0, CacheCleanupThread, NULL, 0, NULL);

    ULONG bufferSize = sizeof(EVENT_TRACE_PROPERTIES) + sizeof(KERNEL_LOGGER_NAMEW) + MAX_PATH * sizeof(WCHAR);
    PEVENT_TRACE_PROPERTIES pProperties = (PEVENT_TRACE_PROPERTIES)malloc(bufferSize);
    if (!pProperties) return 1;

    ZeroMemory(pProperties, bufferSize);
    pProperties->Wnode.BufferSize = bufferSize;
    pProperties->Wnode.Flags = WNODE_FLAG_TRACED_GUID;
    pProperties->Wnode.ClientContext = 1; // QPC
    pProperties->Wnode.Guid = SystemTraceControlGuid;
    pProperties->EnableFlags = EVENT_TRACE_FLAG_FILE_IO | EVENT_TRACE_FLAG_FILE_IO_INIT | EVENT_TRACE_FLAG_PROCESS;
    pProperties->LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
    pProperties->LoggerNameOffset = sizeof(EVENT_TRACE_PROPERTIES);
    memcpy((char*)pProperties + pProperties->LoggerNameOffset, KERNEL_LOGGER_NAMEW, sizeof(KERNEL_LOGGER_NAMEW));

    TRACEHANDLE hSession = 0;
    ULONG status = StartTraceW(&hSession, KERNEL_LOGGER_NAMEW, pProperties);
    if (status == ERROR_ALREADY_EXISTS) {
        // Reset properties structure and stop the existing trace session first
        ZeroMemory(pProperties, bufferSize);
        pProperties->Wnode.BufferSize = bufferSize;
        pProperties->Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        pProperties->Wnode.ClientContext = 1;
        pProperties->Wnode.Guid = SystemTraceControlGuid;
        pProperties->LoggerNameOffset = sizeof(EVENT_TRACE_PROPERTIES);
        memcpy((char*)pProperties + pProperties->LoggerNameOffset, KERNEL_LOGGER_NAMEW, sizeof(KERNEL_LOGGER_NAMEW));

        status = ControlTraceW(0, KERNEL_LOGGER_NAMEW, pProperties, EVENT_TRACE_CONTROL_STOP);

        // Re-initialize properties to start clean
        ZeroMemory(pProperties, bufferSize);
        pProperties->Wnode.BufferSize = bufferSize;
        pProperties->Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        pProperties->Wnode.ClientContext = 1;
        pProperties->Wnode.Guid = SystemTraceControlGuid;
        pProperties->EnableFlags = EVENT_TRACE_FLAG_FILE_IO | EVENT_TRACE_FLAG_FILE_IO_INIT | EVENT_TRACE_FLAG_PROCESS;
        pProperties->LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
        pProperties->LoggerNameOffset = sizeof(EVENT_TRACE_PROPERTIES);
        memcpy((char*)pProperties + pProperties->LoggerNameOffset, KERNEL_LOGGER_NAMEW, sizeof(KERNEL_LOGGER_NAMEW));

        status = StartTraceW(&hSession, KERNEL_LOGGER_NAMEW, pProperties);
    }

    if (status != ERROR_SUCCESS) {
        std::cerr << "{\"event_type\":\"SYSTEM\",\"data\":\"Failed to start NT Kernel Logger. Error: " << status << ". Are you running as Administrator?\"}\n";
        free(pProperties);
        return 1;
    }

    EVENT_TRACE_LOGFILEW logFile = { 0 };
    logFile.LoggerName = (LPWSTR)KERNEL_LOGGER_NAMEW;
    logFile.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
    logFile.EventRecordCallback = EventRecordCallback;

    TRACEHANDLE hTrace = OpenTraceW(&logFile);
    if (hTrace == (TRACEHANDLE)INVALID_HANDLE_VALUE) {
        std::cerr << "{\"event_type\":\"SYSTEM\",\"data\":\"OpenTrace failed\"}\n";
        return 1;
    }

    std::cout << "{\"event_type\":\"SYSTEM\",\"data\":\"ETW Trace Processing Started\"}\n";
    std::cout.flush();

    ProcessTrace(&hTrace, 1, 0, 0);

    CloseTrace(hTrace);
    free(pProperties);
    return 0;
}
