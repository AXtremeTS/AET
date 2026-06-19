import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Window } from '@tauri-apps/api/window';

export default function Dashboard() {
  // Navigation State
  const [activeTab, setActiveTab] = useState('console'); // 'console' | 'watcher' | 'device' | 'processes' | 'shell'
  const [watcherMode, setWatcherMode] = useState('realtime'); // 'realtime' | 'all'

  // Application Data States
  const [paths, setPaths] = useState({ watch_dir: 'Loading...', db_path: 'Loading...' });
  const [globalMode, setGlobalMode] = useState(true);
  const [ignoreSystemApps, setIgnoreSystemApps] = useState(true);
  const [closeToTray, setCloseToTray] = useState(() => {
    const saved = localStorage.getItem('closeToTray');
    return saved !== null ? saved === 'true' : false;
  });
  const [autoCollapse, setAutoCollapse] = useState(() => {
    const saved = localStorage.getItem('autoCollapse');
    return saved !== null ? saved === 'true' : true;
  });
  const [autoClearEnabled, setAutoClearEnabled] = useState(() => {
    const saved = localStorage.getItem('autoClearEnabled');
    return saved !== null ? saved === 'true' : false;
  });
  const [autoClearSize, setAutoClearSize] = useState(() => {
    const saved = localStorage.getItem('autoClearSize');
    return saved !== null ? Number(saved) : 50;
  });
  const [autoClearUnit, setAutoClearUnit] = useState(() => {
    const saved = localStorage.getItem('autoClearUnit');
    return saved !== null ? saved : 'MB';
  });
  const [fileEvents, setFileEvents] = useState([]);
  const [allFilesHistory, setAllFilesHistory] = useState([]);
  const [monitoredApps, setMonitoredApps] = useState([]);
  const [systemLogs, setSystemLogs] = useState([]);
  const [watchTargets, setWatchTargets] = useState([]);
  const [newTargetPath, setNewTargetPath] = useState('');
  const [standardPaths, setStandardPaths] = useState({ desktop: '', documents: '', downloads: '' });
  const [dbSizeMb, setDbSizeMb] = useState(0);
  const [targetError, setTargetError] = useState('');
  const [hoveredPath, setHoveredPath] = useState(null);
  const [hoverPosition, setHoverPosition] = useState({ x: 0, y: 0 });
  const [selectedFile, setSelectedFile] = useState(null);
  const [runningProcesses, setRunningProcesses] = useState([]);
  const [procSearchQuery, setProcSearchQuery] = useState('');

  // System Hardware Metrics State
  const [metrics, setMetrics] = useState({
    cpu_usage: 0,
    ram_used_gb: 0,
    ram_total_gb: 0,
    ram_usage_percent: 0,
    disks: []
  });

  const [selectedDiskIndex, setSelectedDiskIndex] = useState(0);
  const [resourcePanel, setResourcePanel] = useState(null); // 'cpu' | 'ram' | null
  const [renderedPanel, setRenderedPanel] = useState(null); // 'cpu' | 'ram' | null
  const [showGraph, setShowGraph] = useState(false);
  const [cpuHistory, setCpuHistory] = useState(Array(30).fill(0));
  const [ramHistory, setRamHistory] = useState(Array(30).fill(0));

  // Helper to compute SVG paths for history graphs
  const generateGraphPaths = (history) => {
    if (!history || history.length === 0) return { linePath: '', areaPath: '', points: [] };
    const width = 300;
    const height = 100;
    const points = history.map((val, idx) => {
      const x = idx * (width / (history.length - 1));
      const clamped = Math.max(0, Math.min(100, val));
      const y = height - (clamped * 0.7 + 15); // scaled/offset so that dots don't clip
      return { x, y };
    });

    // Generate smooth bezier curve path (spline)
    const smoothing = 0.18;
    let linePath = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;

      const cp1x = p1.x + (p2.x - p0.x) * smoothing;
      const cp1y = p1.y + (p2.y - p0.y) * smoothing;
      const cp2x = p2.x - (p3.x - p1.x) * smoothing;
      const cp2y = p2.y - (p3.y - p1.y) * smoothing;

      linePath += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }

    const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} 100 L ${points[0].x.toFixed(1)} 100 Z`;

    return { linePath, areaPath, points };
  };

  useEffect(() => {
    if (resourcePanel) {
      setRenderedPanel(resourcePanel);
    } else {
      const timer = setTimeout(() => {
        setRenderedPanel(null);
      }, 450); // wait for slide-out transition
      return () => clearTimeout(timer);
    }
  }, [resourcePanel]);

  // Update metrics history
  useEffect(() => {
    if (metrics) {
      setCpuHistory(prev => [...prev.slice(1), metrics.cpu_usage]);
      setRamHistory(prev => [...prev.slice(1), metrics.ram_usage_percent]);
    }
  }, [metrics]);

  // Automatically slide up the graph from behind with a small delay after the panel opens
  useEffect(() => {
    if (resourcePanel) {
      const timer = setTimeout(() => {
        setShowGraph(true);
      }, 250);
      return () => clearTimeout(timer);
    } else {
      setShowGraph(false);
    }
  }, [resourcePanel]);

  // DB Shell States
  const [shellInput, setShellInput] = useState('');
  const [shellHistory, setShellHistory] = useState([
    { type: 'sys', text: 'AKIFILEMONITOR SQL TERMINAL v1.0.0' },
    { type: 'sys', text: 'Type HELP for list of commands.' },
    { type: 'sys', text: '' }
  ]);
  const consoleContainerRef = useRef(null);

  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false);

  const togglePause = () => {
    playSfx('click');
    const nextVal = !isPaused;
    setIsPaused(nextVal);
    isPausedRef.current = nextVal;
  };

  // Sound Effects Utility
  const lastScrollSoundTime = useRef(0);
  const playScrollSfx = () => {
    const now = Date.now();
    if (now - lastScrollSoundTime.current > 120) {
      lastScrollSoundTime.current = now;
      const audio = new Audio('/sfx/scroll.mp3');
      audio.volume = 0.05;
      audio.play().catch(() => {});
    }
  };

  const playSfx = (type) => {
    let file = '';
    if (type === 'click') file = '/sfx/enter_click.mp3';
    else if (type === 'scroll') {
      playScrollSfx();
      return;
    }
    
    if (file) {
      const audio = new Audio(file);
      audio.volume = 0.12; 
      audio.play().catch(() => {});
    }
  };

  // Search/Filter states for logs
  const [searchQuery, setSearchQuery] = useState('');
  const [tagStates, setTagStates] = useState({ CREATE: 0, MODIFY: 0, DELETE: 0 }); // 0: off, 1: include, -1: exclude
  const [showTagsMenu, setShowTagsMenu] = useState(false);
  const [procSortBy, setProcSortBy] = useState('usage');
  const [showProcSortMenu, setShowProcSortMenu] = useState(false);
  const [collapsedNodes, setCollapsedNodes] = useState(new Set());
  const [expandedNodes, setExpandedNodes] = useState(new Set());

  // SQL Autocomplete State
  const sqlSuggestions = [
    'SELECT * FROM file_events ORDER BY timestamp DESC LIMIT 50;',
    'SELECT * FROM monitored_apps;',
    'SELECT * FROM watch_targets;',
    'DELETE FROM file_events;',
    'CLEAR DATABASE',
    'HELP',
    'CLEAR'
  ];
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);

  // Fetch global mode setting from Rust
  const fetchGlobalMode = async () => {
    try {
      const mode = await invoke('get_global_mode');
      setGlobalMode(mode);
      const ignoreSys = await invoke('get_ignore_system_apps');
      setIgnoreSystemApps(ignoreSys);
    } catch (err) {
      console.error('Failed to fetch config:', err);
    }
  };

  // Toggle global mode setting
  const handleToggleGlobalMode = async (enabled) => {
    try {
      await invoke('set_global_mode', { global: enabled });
      setGlobalMode(enabled);
      setShellHistory(prev => [...prev, { type: 'sys', text: `Global Mode: ${enabled ? 'ON' : 'OFF'}` }]);
    } catch (err) {
      console.error(err);
    }
  };

  const handleToggleIgnoreSystem = async (enabled) => {
    try {
      await invoke('set_ignore_system_apps', { ignore: enabled });
      setIgnoreSystemApps(enabled);
      setShellHistory(prev => [...prev, { type: 'sys', text: `Ignore System Apps: ${enabled ? 'ON' : 'OFF'}` }]);
    } catch (err) {
      console.error(err);
    }
  };

  // Close to tray hook
  useEffect(() => {
    const setupCloseHook = async () => {
      try {
        const appWindow = new Window('main');
        const unlisten = await appWindow.onCloseRequested(async (event) => {
          if (closeToTray) {
            event.preventDefault();
            await appWindow.hide();
          } else {
            event.preventDefault();
            await invoke('exit_app');
          }
        });
        return unlisten;
      } catch (e) {
        console.error('Tray Hook error:', e);
      }
    };
    
    let unlistenFn;
    setupCloseHook().then(fn => { unlistenFn = fn; });
    
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [closeToTray]);

  // Fetch file paths & configurations
  const fetchPaths = async () => {
    try {
      const res = await invoke('get_paths_info');
      setPaths(res);
    } catch (err) {
      console.error('Failed to query paths:', err);
    }
  };

  // Fetch dynamic watch targets from Rust
  const fetchWatchTargets = async () => {
    try {
      const res = await invoke('get_watch_targets');
      setWatchTargets(res);
    } catch (err) {
      console.error('Failed to get watch targets:', err);
    }
  };

  // Fetch standard system paths on startup
  const fetchStandardPaths = async () => {
    try {
      const res = await invoke('get_standard_paths');
      setStandardPaths(res);
    } catch (err) {
      console.error('Failed to get standard paths:', err);
    }
  };

  // Add watch target
  const handleAddWatchTarget = async (pathToAdd) => {
    setTargetError('');
    if (!pathToAdd || !pathToAdd.trim()) {
      setTargetError('Path cannot be empty');
      return;
    }
    try {
      await invoke('add_watch_target', { path: pathToAdd.trim() });
      setNewTargetPath('');
      fetchWatchTargets();
    } catch (err) {
      setTargetError(err.toString());
    }
  };

  // Remove watch target
  const handleRemoveWatchTarget = async (pathToRemove) => {
    try {
      await invoke('remove_watch_target', { path: pathToRemove });
      fetchWatchTargets();
    } catch (err) {
      console.error('Failed to remove watch target:', err);
    }
  };

  // Fetch all active system running processes
  const fetchRunningProcesses = async () => {
    try {
      const res = await invoke('get_running_processes');
      setRunningProcesses(res);
    } catch (err) {
      console.error('Failed to query running processes:', err);
    }
  };

  // Sync databases
  const refreshData = async () => {
    try {
      const events = await invoke('get_file_events');
      setFileEvents(events);
      const apps = await invoke('get_monitored_apps');
      setMonitoredApps(apps);
      const targets = await invoke('get_watch_targets');
      setWatchTargets(targets);
      fetchRunningProcesses();
      fetchGlobalMode();
      
      const size = await invoke('get_db_size');
      setDbSizeMb(size);
    } catch (err) {
      console.error('Failed to sync tables:', err);
    }
  };

  // Fetch hardware metrics
  const fetchMetrics = async () => {
    try {
      const res = await invoke('get_system_metrics');
      setMetrics(res);
    } catch (err) {
      console.error('Failed to fetch metrics:', err);
    }
  };

  const handleClearLogs = async () => {
    try {
      await invoke('clear_logs');
      setFileEvents([]);
      setMonitoredApps([]);
      setSystemLogs([]);
      setShellHistory(prev => [...prev, { type: 'sys', text: 'Database tables cleared successfully.' }]);
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  };

  // Build retro ASCII progress bar
  const renderBlockBar = (percentage) => {
    const barsCount = 20; 
    const fullBlocks = Math.floor(percentage / (100 / barsCount));
    const hasPartial = (percentage % (100 / barsCount)) > 0 && fullBlocks < barsCount;
    const emptyBlocks = barsCount - fullBlocks - (hasPartial ? 1 : 0);

    const blocks = [];
    for (let i = 0; i < fullBlocks; i++) {
      blocks.push('full');
    }
    if (hasPartial) {
      blocks.push('partial');
    }
    for (let i = 0; i < emptyBlocks; i++) {
      blocks.push('empty');
    }

    return (
      <span style={{ 
        display: 'inline-flex', 
        alignItems: 'center', 
        fontFamily: '"JetBrains Mono", monospace',
        userSelect: 'none'
      }}>
        {/* Percentage label */}
        <span style={{ 
          color: 'var(--color-on-canvas)', 
          fontWeight: 'bold', 
          width: '32px', 
          textAlign: 'right', 
          marginRight: '8px', 
          fontSize: '13px' 
        }}>
          {percentage.toFixed(0)}%
        </span>

        {/* Bar container */}
        <span style={{ 
          display: 'inline-flex', 
          alignItems: 'center', 
          height: '16px' // height of the brackets container
        }}>
          {/* Left Bracket */}
          <span style={{ 
            fontSize: '16px', 
            color: 'var(--color-mute)', 
            marginRight: '2px',
            display: 'inline-flex',
            alignItems: 'center',
            height: '16px',
            lineHeight: 1
          }}>[</span>
          
          {/* Blocks container */}
          <span style={{ 
            display: 'inline-flex', 
            alignItems: 'center', 
            gap: '0px', 
            height: '11px',
            verticalAlign: 'middle'
          }}>
            {blocks.map((type, idx) => {
              const style = {
                display: 'inline-block',
                width: '8px',
                height: '11px',
                flexShrink: 0
              };

              if (type === 'full') {
                style.backgroundColor = 'var(--color-on-canvas)';
              } else if (type === 'partial') {
                // 50% medium shade checkerboard pattern mask
                style.backgroundColor = 'var(--color-mute)';
                const mask = `url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPSc0JyBoZWlnaHQ9JzQnPjxyZWN0IHdpZHRoPScyJyBoZWlnaHQ9JzInIGZpbGw9J2JsYWNrJy8+PHJlY3QgeD0nMicgeT0nMicgd2lkdGg9JzInIGhlaWdodD0nMicgZmlsbD0nYmxhY2snLz48L3N2Zz4=")`;
                style.WebkitMaskImage = mask;
                style.WebkitMaskRepeat = 'repeat';
                style.maskImage = mask;
                style.maskRepeat = 'repeat';
              } else {
                // 25% light shade diagonal pattern mask
                style.backgroundColor = 'var(--color-mute)';
                const mask = `url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScyJyBoZWlnaHQ9JzInPjxyZWN0IHdpZHRoPScxJyBoZWlnaHQ9JzEnIGZpbGw9J2JsYWNrJy8+PC9zdmc+")`;
                style.WebkitMaskImage = mask;
                style.WebkitMaskRepeat = 'repeat';
                style.maskImage = mask;
                style.maskRepeat = 'repeat';
              }

              return (
                <span key={idx} style={style} />
              );
            })}
          </span>

          {/* Right Bracket */}
          <span style={{ 
            fontSize: '16px', 
            color: 'var(--color-mute)', 
            marginLeft: '2px',
            display: 'inline-flex',
            alignItems: 'center',
            height: '16px',
            lineHeight: 1
          }}>]</span>
        </span>
      </span>
    );
  };

  // Handle SQL Command Terminal execution
  const handleShellCommand = async (e) => {
    e.preventDefault();
    const cmd = shellInput.trim();
    if (!cmd) return;

    const newHistory = [...shellHistory, { type: 'cmd', text: `> ${cmd}` }];
    setShellInput('');

    const lowerCmd = cmd.toLowerCase();

    if (lowerCmd === 'help') {
      newHistory.push({ type: 'sys', text: 'Available commands:' });
      newHistory.push({ type: 'sys', text: '  HELP                              - Displays this menu.' });
      newHistory.push({ type: 'sys', text: '  SELECT * FROM file_events         - Lists all file watcher events.' });
      newHistory.push({ type: 'sys', text: '  SELECT * FROM monitored_apps      - Lists all captured applications.' });
      newHistory.push({ type: 'sys', text: '  CLEAR DATABASE                    - Flushes all SQL tables.' });
      newHistory.push({ type: 'sys', text: '  CLEAR                             - Clears the console logs.' });
      newHistory.push({ type: 'sys', text: '  SYS_INFO                          - Query app directories.' });
    } else if (lowerCmd === 'clear') {
      setShellHistory([]);
      return;
    } else if (lowerCmd === 'clear database') {
      handleClearLogs();
      return;
    } else if (lowerCmd.includes('select * from file_events')) {
      try {
        const events = await invoke('get_file_events');
        if (events.length === 0) {
          newHistory.push({ type: 'sys', text: 'Empty set (0.00 sec)' });
        } else {
          newHistory.push({ type: 'sys', text: `Found ${events.length} rows:` });
          newHistory.push({
            type: 'table',
            headers: ['TIME', 'OP', 'PID', 'APP', 'FILE'],
            rows: events.map(e => [
              new Date(e.timestamp).toLocaleTimeString(),
              e.operation_type,
              e.pid ? String(e.pid) : 'unknown',
              e.process_name || 'unknown',
              e.file_path
            ])
          });
        }
      } catch (err) {
        newHistory.push({ type: 'err', text: `SQL Error: ${err.toString()}` });
      }
    } else if (lowerCmd.includes('select * from monitored_apps')) {
      try {
        const apps = await invoke('get_monitored_apps');
        if (apps.length === 0) {
          newHistory.push({ type: 'sys', text: 'Empty set (0.00 sec)' });
        } else {
          newHistory.push({ type: 'sys', text: `Found ${apps.length} rows:` });
          newHistory.push({
            type: 'table',
            headers: ['PID', 'PROCESS NAME', 'FIRST SEEN', 'LAST ACTIVE'],
            rows: apps.map(a => [
              String(a.pid),
              a.process_name,
              new Date(a.first_seen).toLocaleTimeString(),
              new Date(a.last_seen).toLocaleTimeString()
            ])
          });
        }
      } catch (err) {
        newHistory.push({ type: 'err', text: `SQL Error: ${err.toString()}` });
      }
    } else if (lowerCmd === 'sys_info') {
      newHistory.push({ type: 'sys', text: `Watch Path: ${paths.watch_dir}` });
      newHistory.push({ type: 'sys', text: `SQLite DB:  ${paths.db_path}` });
    } else {
      newHistory.push({ type: 'err', text: `Command not recognized: '${cmd}'. Type HELP for commands.` });
    }

    setShellHistory(newHistory);
  };

  useEffect(() => {
    if (consoleContainerRef.current) {
      consoleContainerRef.current.scrollTop = consoleContainerRef.current.scrollHeight;
    }
  }, [shellHistory]);

  useEffect(() => {
    fetchPaths();
    refreshData();
    fetchMetrics();
    fetchWatchTargets();
    fetchStandardPaths();
    fetchRunningProcesses();
    fetchGlobalMode();

    // Poll hardware metrics every 1.5s
    const metricsInterval = setInterval(async () => {
      fetchMetrics();
      try {
        const size = await invoke('get_db_size');
        setDbSizeMb(size);
        
        // AUTO CLEAR LOGIC
        const acEnabled = localStorage.getItem('autoClearEnabled') === 'true';
        if (acEnabled && size > 0) {
          const acSize = Number(localStorage.getItem('autoClearSize') || 50);
          const acUnit = localStorage.getItem('autoClearUnit') || 'MB';
          const thresholdMb = acUnit === 'GB' ? acSize * 1024 : acSize;
          if (size >= thresholdMb) {
             await invoke('clear_logs');
             refreshData(); // Refresh UI after clearing
          }
        }
      } catch(e) {}
    }, 1500);

    // Poll running processes every 5s
    const procInterval = setInterval(fetchRunningProcesses, 5000);

    // Watcher socket updates
    let unlisten;
    const setupListener = async () => {
      unlisten = await listen('java-log', (event) => {
        if (isPausedRef.current) return;
        const payload = event.payload;
        if (payload.event_type === 'FILE_CHANGE') {
          setFileEvents((prev) => [payload.data, ...prev].slice(0, 2500));
          setAllFilesHistory((prev) => {
            const existingIdx = prev.findIndex(e => 
              e.process_name === payload.data.process_name && 
              e.file_path === payload.data.file_path
            );
            const updatedEvent = {
              event_id: payload.data.event_id || Date.now(),
              timestamp: payload.data.timestamp,
              pid: payload.data.pid,
              process_name: payload.data.process_name,
              file_path: payload.data.file_path,
              operation_type: payload.data.operation_type
            };
            if (existingIdx > -1) {
              const next = [...prev];
              next.splice(existingIdx, 1);
              return [updatedEvent, ...next];
            } else {
              return [updatedEvent, ...prev];
            }
          });
        } else if (payload.event_type === 'SYSTEM') {
          setSystemLogs((prev) => [...prev, payload.data]);
        }
      });
    };
    setupListener();

    return () => {
      clearInterval(metricsInterval);
      clearInterval(procInterval);
      if (unlisten) {
        unlisten.then((f) => f());
      }
    };
  }, []);

  useEffect(() => {
    if (watcherMode === 'all') {
      invoke('get_all_unique_files').then(setAllFilesHistory).catch(console.error);
    }
  }, [watcherMode]);

  // Filter lists
  const baseEvents = watcherMode === 'all' ? allFilesHistory : fileEvents;
  const filteredEvents = baseEvents.filter(e => {
    const matchesSearch = e.file_path.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          (e.process_name && e.process_name.toLowerCase().includes(searchQuery.toLowerCase()));
    const includes = Object.keys(tagStates).filter(k => tagStates[k] === 1);
    const excludes = Object.keys(tagStates).filter(k => tagStates[k] === -1);
    const isOpMatch = () => {
      if (excludes.includes(e.operation_type)) return false;
      if (includes.length > 0 && !includes.includes(e.operation_type)) return false;
      return true;
    };
    return matchesSearch && isOpMatch();
  });

  const filteredRunningProcesses = runningProcesses.filter(p => 
    p.name.toLowerCase().includes(procSearchQuery.toLowerCase()) || 
    p.exe.toLowerCase().includes(procSearchQuery.toLowerCase())
  );

  const getAggregatedEvents = () => {
    const seenProcs = new Set();
    const result = [];
    for (const evt of fileEvents) {
      const proc = evt.process_name || 'unknown';
      if (!seenProcs.has(proc)) {
        seenProcs.add(proc);
        result.push(evt);
        if (result.length >= 100) break;
      }
    }
    return result;
  };

  // Helper to find icon by process name from running processes or DB registry
  const getIconForProcess = (procName) => {
    if (!procName) return null;
    const cleanName = procName.replace(/\s+\[INACTIVE\]$/i, '').trim().toLowerCase();
    
    // 1. Try running processes
    const running = runningProcesses.find(p => p.name.toLowerCase() === cleanName);
    if (running && running.icon_base64) {
      return running.icon_base64;
    }
    
    // 2. Try monitored apps history
    const monitored = monitoredApps.find(app => app.process_name.toLowerCase() === cleanName);
    if (monitored && monitored.icon_base64) {
      return monitored.icon_base64;
    }
    
    return null;
  };

  // Tree building & formatting helpers
  const parseFilePath = (filePath) => {
    const norm = filePath.replace(/\\/g, '/');
    const lastIndex = norm.lastIndexOf('/');
    if (lastIndex === -1) {
      return { folder: '/', file: filePath };
    }
    const folder = norm.substring(0, lastIndex);
    const file = norm.substring(lastIndex + 1);
    return { folder, file };
  };

  const getRelativeFolder = (absoluteFolder, watchDir) => {
    const normWatch = watchDir.replace(/\\/g, '/');
    const normFolder = absoluteFolder.replace(/\\/g, '/');
    if (normFolder === normWatch) {
      return '.';
    }
    if (normFolder.startsWith(normWatch)) {
      let rel = normFolder.substring(normWatch.length);
      if (!rel.startsWith('/')) {
        rel = '/' + rel;
      }
      return rel;
    }
    return absoluteFolder;
  };

  const buildTree = (events, watchDir) => {
    const tree = {};
    const activePids = new Set(runningProcesses.map(p => p.pid));

    events.forEach(evt => {
      let proc = evt.process_name || 'unknown';

      const { folder: absFolder, file } = parseFilePath(evt.file_path);
      const relFolder = getRelativeFolder(absFolder, watchDir);

      if (!tree[proc]) {
        tree[proc] = {};
      }
      if (!tree[proc][relFolder]) {
        tree[proc][relFolder] = {};
      }
      
      let displayFile = file;
      if (!displayFile || displayFile.trim() === '') {
        displayFile = '<Directory>';
      }

      if (!tree[proc][relFolder][displayFile]) {
        tree[proc][relFolder][displayFile] = {
          events: [],
          latestTimestamp: evt.timestamp,
          latestOperation: evt.operation_type,
          rawPath: evt.file_path
        };
      } else {
        if (new Date(evt.timestamp) > new Date(tree[proc][relFolder][displayFile].latestTimestamp)) {
          tree[proc][relFolder][displayFile].latestTimestamp = evt.timestamp;
          tree[proc][relFolder][displayFile].latestOperation = evt.operation_type;
        }
      }
      tree[proc][relFolder][displayFile].events.push(evt);
    });
    return tree;
  };

  const handleToggleAutoCollapse = (enabled) => {
    setAutoCollapse(enabled);
    localStorage.setItem('autoCollapse', enabled);
    if (enabled) {
      setExpandedNodes(new Set()); // Collapse everything initially when turned on
    } else {
      setCollapsedNodes(new Set()); // Expand everything initially when turned off
    }
  };

  const toggleNode = (key) => {
    playSfx('click');
    if (autoCollapse) {
      setExpandedNodes(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    } else {
      setCollapsedNodes(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }
  };

  const expandAll = (tree) => {
    if (autoCollapse) {
      const newSet = new Set();
      Object.keys(tree).forEach(proc => {
        newSet.add(`proc:${proc}`);
        Object.keys(tree[proc]).forEach(folder => {
          newSet.add(`folder:${proc}:${folder}`);
        });
      });
      setExpandedNodes(newSet);
    } else {
      setCollapsedNodes(new Set());
    }
  };

  const collapseAll = (tree) => {
    if (autoCollapse) {
      setExpandedNodes(new Set());
    } else {
      const newSet = new Set();
      Object.keys(tree).forEach(proc => {
        newSet.add(`proc:${proc}`);
        Object.keys(tree[proc]).forEach(folder => {
          newSet.add(`folder:${proc}:${folder}`);
        });
      });
      setCollapsedNodes(newSet);
    }
  };

  const renderBranchLines = (types) => {
    return (
      <div style={{ display: 'flex', alignSelf: 'stretch', flexShrink: 0 }}>
        {types.map((type, idx) => {
          if (!type) {
            return <div key={idx} style={{ width: '24px', alignSelf: 'stretch', flexShrink: 0 }} />;
          }
          return (
            <div key={idx} style={{ width: '24px', position: 'relative', alignSelf: 'stretch', flexShrink: 0 }}>
              {/* Vertical line part */}
              {(type === 'vertical' || type === 't-branch') && (
                <div style={{
                  position: 'absolute',
                  left: '11px',
                  top: 0,
                  bottom: 0,
                  width: '2px',
                  backgroundColor: 'var(--color-hairline-strong)',
                  opacity: 0.7
                }} />
              )}
              {type === 'l-branch' && (
                <div style={{
                  position: 'absolute',
                  left: '11px',
                  top: 0,
                  height: 'calc(50% + 1px)',
                  width: '2px',
                  backgroundColor: 'var(--color-hairline-strong)',
                  opacity: 0.7
                }} />
              )}
              {/* Horizontal line part */}
              {(type === 't-branch' || type === 'l-branch') && (
                <div style={{
                  position: 'absolute',
                  left: '11px',
                  top: 'calc(50% - 1px)',
                  width: '13px',
                  height: '2px',
                  backgroundColor: 'var(--color-hairline-strong)',
                  opacity: 0.7
                }} />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderTree = (tree) => {
    // Sort processes alphabetically to prevent jumping order
    const procs = Object.keys(tree).sort((a, b) => {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });

    const elements = [];

    procs.forEach((proc, procIdx) => {
      const procKey = `proc:${proc}`;
      const isProcCollapsed = autoCollapse ? !expandedNodes.has(procKey) : collapsedNodes.has(procKey);
      const toggleChar = isProcCollapsed ? '[+]' : '[−]';
      const icon = getIconForProcess(proc);
      
      elements.push(
        <div 
          key={procKey} 
          className="scroll-fade-scale"
          style={{ display: 'flex', alignItems: 'stretch', cursor: 'pointer', paddingLeft: '12px', fontSize: '13px' }}
          onClick={() => toggleNode(procKey)}
        >
          {/* Toggle button container */}
          <div style={{ position: 'relative', width: '24px', display: 'flex', justifyContent: 'center', alignItems: 'center', flexShrink: 0 }}>
            {!isProcCollapsed && (
              <div style={{
                position: 'absolute',
                left: '11px',
                top: '50%',
                bottom: 0,
                width: '2px',
                backgroundColor: 'var(--color-hairline-strong)',
                opacity: 0.7
              }} />
            )}
            <span className="text-mute" style={{ fontFamily: 'monospace', fontWeight: 'bold', position: 'relative', zIndex: 1 }}>{toggleChar}</span>
          </div>
          {/* Process name & icon */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '4px 0', gap: '6px' }}>
            <span className="text-accent" style={{ fontWeight: '700', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>[P]</span>
              {icon && (
                <img 
                  src={`data:image/png;base64,${icon}`} 
                  alt="" 
                  style={{ width: '14px', height: '14px', objectFit: 'contain' }} 
                />
              )}
              <span>{proc}</span>
            </span>
          </div>
        </div>
      );

      if (isProcCollapsed) return;

      const folders = Object.keys(tree[proc]).sort();
      folders.forEach((folder, folderIdx) => {
        const folderKey = `folder:${proc}:${folder}`;
        const isFolderCollapsed = autoCollapse ? !expandedNodes.has(folderKey) : collapsedNodes.has(folderKey);
        const folderToggleChar = isFolderCollapsed ? '[+]' : '[−]';
        const isLastFolder = folderIdx === folders.length - 1;
        
        elements.push(
          <div 
            key={folderKey} 
            className="scroll-fade-scale"
            style={{ display: 'flex', alignItems: 'stretch', cursor: 'pointer', paddingLeft: '12px', fontSize: '13px' }}
            onClick={() => toggleNode(folderKey)}
          >
            {renderBranchLines([isLastFolder ? 'l-branch' : 't-branch'])}
            {/* Toggle container */}
            <div style={{ position: 'relative', width: '24px', display: 'flex', justifyContent: 'center', alignItems: 'center', flexShrink: 0 }}>
              {!isFolderCollapsed && (
                <div style={{
                  position: 'absolute',
                  left: '11px',
                  top: '50%',
                  bottom: 0,
                  width: '2px',
                  backgroundColor: 'var(--color-hairline-strong)',
                  opacity: 0.7
                }} />
              )}
              <span className="text-mute" style={{ fontFamily: 'monospace', fontWeight: 'bold', position: 'relative', zIndex: 1 }}>{folderToggleChar}</span>
            </div>
            {/* Folder name */}
            <div style={{ display: 'flex', alignItems: 'center', padding: '4px 0' }}>
              <span style={{ color: '#ff9f0a', fontWeight: '500' }}>[F] {folder}</span>
            </div>
          </div>
        );

        if (isFolderCollapsed) return;

        const files = Object.keys(tree[proc][folder]).sort((a, b) => {
           return new Date(tree[proc][folder][b].latestTimestamp) - new Date(tree[proc][folder][a].latestTimestamp);
        });

        files.forEach((fileName, fileIdx) => {
          const fileData = tree[proc][folder][fileName];
          const isLastFile = fileIdx === files.length - 1;
          const evtCount = fileData.events.length;
          const countBadge = evtCount > 1 ? ` (x${evtCount})` : '';
          
          elements.push(
            <div 
              key={`${proc}:${folder}:${fileName}`} 
              className="scroll-fade-scale"
              style={{ display: 'flex', alignItems: 'stretch', paddingLeft: '12px', fontSize: '13px' }}
            >
              {renderBranchLines([
                isLastFolder ? null : 'vertical',
                isLastFile ? 'l-branch' : 't-branch'
              ])}
              {/* File details */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '4px 0', flexWrap: 'wrap', gap: '8px' }}>
                <span style={{ fontWeight: 'bold' }} className={
                  fileData.latestOperation === 'CREATE' ? 'text-success' :
                  fileData.latestOperation === 'DELETE' ? 'text-danger' : 'text-warning'
                }>
                  [{fileData.latestOperation}]
                </span>
                <span 
                  className="hover-file"
                  style={{ fontWeight: '500', cursor: 'pointer', borderBottom: '1px dashed transparent', transition: 'border-color 0.1s' }}
                  onMouseEnter={(e) => {
                    setHoveredPath(fileData.rawPath);
                    setHoverPosition({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseMove={(e) => {
                    setHoverPosition({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseLeave={() => {
                    setHoveredPath(null);
                  }}
                  onClick={(e) => {
                    playSfx('click');
                    e.stopPropagation();
                    setSelectedFile({ path: fileData.rawPath, x: e.clientX, y: e.clientY });
                  }}
                >
                  {fileName}
                  <span className="text-accent" style={{ fontStyle: 'italic', marginLeft: '4px' }}>{countBadge}</span>
                </span>
                <span className="text-mute" style={{ fontSize: '11px' }}>
                  ({new Date(fileData.latestTimestamp).toLocaleTimeString()})
                </span>
              </div>
            </div>
          );
        });
      });
    });

    return elements;
  };

  return (
    <div className="app-wrapper">
      {/* Left Sidebar Panel */}
      <div className="sidebar-panel">
        {/* Massive AKI branding header */}
        <div className="sidebar-logo-container">
          <div style={{ fontFamily: '"FFFFORWA", "Black Ops One", Impact, sans-serif', lineHeight: '1', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
            <span style={{ fontSize: '28px', color: 'var(--color-on-canvas)' }}>AKI</span>
            <span style={{ fontSize: '10px', color: 'var(--color-mute)', letterSpacing: '1px' }}>EVENT TRACKER</span>
          </div>
        </div>

        {/* Sidebar Tabs */}
        <div className="sidebar-menu">
          <button 
            className={`sidebar-item ${activeTab === 'console' ? 'active' : ''}`}
            onClick={() => { playSfx('click'); setActiveTab('console'); }}
          >
            <span>[0] Dashboard</span>
            <span className="text-mute">&gt;</span>
          </button>
          <button 
            className={`sidebar-item ${activeTab === 'watcher' ? 'active' : ''}`}
            onClick={() => { playSfx('click'); setActiveTab('watcher'); }}
          >
            <span>[1] Watcher</span>
            <span className="text-mute">&gt;</span>
          </button>
          <button 
            className={`sidebar-item ${activeTab === 'device' ? 'active' : ''}`}
            onClick={() => { playSfx('click'); setActiveTab('device'); }}
          >
            <span>[2] Config</span>
            <span className="text-mute">&gt;</span>
          </button>
          <button 
            className={`sidebar-item ${activeTab === 'processes' ? 'active' : ''}`}
            onClick={() => { playSfx('click'); setActiveTab('processes'); }}
          >
            <span>[3] Registry</span>
            <span className="text-mute">&gt;</span>
          </button>
          <button 
            className={`sidebar-item ${activeTab === 'shell' ? 'active' : ''}`}
            onClick={() => { playSfx('click'); setActiveTab('shell'); }}
          >
            <span>[4] SQL Shell</span>
            <span className="text-mute">&gt;</span>
          </button>
        </div>

        {/* Static Bottom Context */}
        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--color-hairline)', paddingTop: '12px', fontSize: '11px' }}>
          <div className="text-mute">System Status:</div>
          <div className="text-success">[+] Watcher Active</div>
          <div className="text-mute" style={{ marginTop: '4px' }}>Sidecar PID: Auto</div>
        </div>
      </div>

      {/* Right Workspace Panel */}
      <div className="workspace-panel">
        
        {/* Hardware Status Monitors on Top (Visible on Console or metrics page) */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          padding: '4px 0 16px 0',
          borderBottom: '1px solid var(--color-hairline)',
          gap: '12px'
        }}>
          {/* CPU Meter */}
          <div className="resource-meter resource-meter-hover" style={{ flex: 1 }} onClick={() => { playSfx('click'); setResourcePanel('cpu'); }}>
            <div className="progress-text-row">
              <span style={{ fontWeight: '700', color: 'var(--color-on-canvas)' }}>
                <span style={{ color: 'var(--color-mute)' }}>[</span>
                <span style={{ color: 'var(--color-success)' }}>+</span>
                <span style={{ color: 'var(--color-mute)' }}>]</span> CPU Activity
              </span>
              <span style={{ color: 'var(--color-success)', fontWeight: 'bold' }}>{metrics.cpu_usage.toFixed(1)}%</span>
            </div>
            <div className="bar-container">{renderBlockBar(metrics.cpu_usage)}</div>
          </div>

          <span style={{ 
            color: 'var(--color-hairline-strong)', 
            fontSize: '24px', 
            userSelect: 'none', 
            padding: '0 8px',
            fontFamily: '"JetBrains Mono", monospace'
          }}>|</span>

          {/* RAM Meter */}
          <div className="resource-meter resource-meter-hover" style={{ flex: 1 }} onClick={() => { playSfx('click'); setResourcePanel('ram'); }}>
            <div className="progress-text-row">
              <span style={{ fontWeight: '700', color: 'var(--color-on-canvas)' }}>
                <span style={{ color: 'var(--color-mute)' }}>[</span>
                <span style={{ color: 'var(--color-accent)' }}>+</span>
                <span style={{ color: 'var(--color-mute)' }}>]</span> RAM Memory
              </span>
              <span style={{ color: 'var(--color-accent)', fontWeight: 'bold' }}>{metrics.ram_used_gb.toFixed(2)} / {metrics.ram_total_gb.toFixed(1)} GB</span>
            </div>
            <div className="bar-container">{renderBlockBar(metrics.ram_usage_percent)}</div>
          </div>

          <span style={{ 
            color: 'var(--color-hairline-strong)', 
            fontSize: '24px', 
            userSelect: 'none', 
            padding: '0 8px',
            fontFamily: '"JetBrains Mono", monospace'
          }}>|</span>

          {/* Disk Meter */}
          <div 
            className="resource-meter resource-meter-hover" 
            style={{ flex: 1 }}
            onClick={() => {
              playSfx('click');
              if (metrics.disks.length > 0) {
                setSelectedDiskIndex((prev) => (prev + 1) % metrics.disks.length);
              }
            }}
          >
            <div className="progress-text-row">
              <span style={{ fontWeight: '700', color: 'var(--color-on-canvas)' }}>
                <span style={{ color: 'var(--color-mute)' }}>[</span>
                <span style={{ color: 'var(--color-warning)' }}>+</span>
                <span style={{ color: 'var(--color-mute)' }}>]</span> Disk {metrics.disks[selectedDiskIndex]?.name ? `(${metrics.disks[selectedDiskIndex].name})` : 'Storage'}
              </span>
              <span style={{ color: 'var(--color-warning)', fontWeight: 'bold' }}>
                {metrics.disks[selectedDiskIndex] ? `${metrics.disks[selectedDiskIndex].used_gb.toFixed(1)} / ${metrics.disks[selectedDiskIndex].total_gb.toFixed(0)} GB` : '0 / 0 GB'}
              </span>
            </div>
            <div className="bar-container">
              {renderBlockBar(metrics.disks[selectedDiskIndex]?.usage_percent || 0)}
            </div>
          </div>
        </div>

        {/* Real-time Hardware Metrics Graph Box */}
        <div 
          className="section-border" 
          style={{ 
            position: 'absolute',
            top: '76px',
            bottom: 'calc(50% + 12px)',
            left: '50%',
            width: '92%',
            maxWidth: '650px',
            backgroundColor: 'var(--color-canvas)',
            zIndex: 90,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '12px 16px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4)', 
            borderRadius: 'var(--rounded-sm)',
            border: '1px solid var(--color-hairline-strong)', 
            transition: 'transform 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.15), opacity 0.3s ease',
            transform: (resourcePanel && showGraph) ? 'translate(-50%, 0)' : 'translate(-50%, 150%)',
            opacity: (resourcePanel && showGraph) ? 1 : 0,
            pointerEvents: (resourcePanel && showGraph) ? 'auto' : 'none',
            overflow: 'hidden'
          }}
        >
          {renderedPanel && (
            <>
              {/* Graph Titlebar */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-hairline-strong)', paddingBottom: '4px', fontSize: '12px' }}>
                <span style={{ fontWeight: '700', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ color: 'var(--color-mute)' }}>[</span>
                  <span style={{ color: renderedPanel === 'cpu' ? 'var(--color-success)' : 'var(--color-accent)' }}>~</span>
                  <span style={{ color: 'var(--color-mute)' }}>]</span> 
                  {renderedPanel === 'cpu' ? 'CPU Activity History' : 'RAM Usage History'}
                </span>
                <span className="text-mute" style={{ fontFamily: 'monospace' }}>
                  Rolling 45s feed (1.5s poll)
                </span>
              </div>

              {/* Graph SVG Workspace */}
              <div style={{ flex: 1, position: 'relative', marginTop: '4px', display: 'flex', flexDirection: 'column' }}>
                {(() => {
                  const history = renderedPanel === 'cpu' ? cpuHistory : ramHistory;
                  const color = renderedPanel === 'cpu' ? 'var(--color-success)' : 'var(--color-accent)';
                  const gradId = renderedPanel === 'cpu' ? 'cpu-grad' : 'ram-grad';
                  const { linePath, areaPath, points } = generateGraphPaths(history);

                  return (
                    <>
                      <svg 
                        width="100%" 
                        height="100%" 
                        viewBox="0 0 300 100" 
                        preserveAspectRatio="none"
                        style={{ color: color, overflow: 'visible' }}
                      >
                        <defs>
                          <pattern id="cpu-dots" width="5" height="5" patternUnits="userSpaceOnUse">
                            <circle cx="2.5" cy="2.5" r="0.8" fill="var(--color-success)" opacity="0.35" />
                          </pattern>
                          <pattern id="ram-dots" width="5" height="5" patternUnits="userSpaceOnUse">
                            <circle cx="2.5" cy="2.5" r="0.8" fill="var(--color-accent)" opacity="0.35" />
                          </pattern>
                        </defs>

                        {/* Grid Lines */}
                        <line x1="0" y1="20" x2="300" y2="20" stroke="var(--color-hairline)" strokeDasharray="1,4" strokeWidth="1" />
                        <line x1="0" y1="40" x2="300" y2="40" stroke="var(--color-hairline)" strokeDasharray="1,4" strokeWidth="1" />
                        <line x1="0" y1="60" x2="300" y2="60" stroke="var(--color-hairline)" strokeDasharray="1,4" strokeWidth="1" />
                        <line x1="0" y1="80" x2="300" y2="80" stroke="var(--color-hairline)" strokeDasharray="1,4" strokeWidth="1" />

                        {/* Filled Area */}
                        {areaPath && (
                          <path d={areaPath} fill={`url(#${renderedPanel === 'cpu' ? 'cpu-dots' : 'ram-dots'})`} />
                        )}

                        {/* Stroke Line (Smooth Spline) */}
                        {linePath && (
                          <path 
                            d={linePath} 
                            fill="none" 
                            stroke="currentColor" 
                            strokeWidth="3.2" 
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        )}

                        {/* Data TUI-style Dots */}
                        {points.map((p, idx) => (
                          <circle 
                            key={idx} 
                            cx={p.x} 
                            cy={p.y} 
                            r="3.5" 
                            fill="var(--color-canvas)" 
                            stroke="currentColor" 
                            strokeWidth="2.2"
                          />
                        ))}
                      </svg>
                      
                      {/* Graph X-Axis Labels */}
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        padding: '6px 4px 0 4px', 
                        fontSize: '9px', 
                        color: 'var(--color-mute)', 
                        fontFamily: 'monospace',
                        borderTop: '1px solid var(--color-hairline)',
                        marginTop: '6px',
                        userSelect: 'none'
                      }}>
                        <span>-45s</span>
                        <span>-30s</span>
                        <span>-15s</span>
                        <span>NOW</span>
                      </div>
                    </>
                  );
                })()}
              </div>
            </>
          )}
        </div>

        {/* Task Manager Drawer Overlay */}
        <div 
          className="task-manager-drawer" 
          style={{ 
            transform: resourcePanel ? 'translateY(0)' : 'translateY(100%)',
            transition: resourcePanel 
              ? 'transform 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.15)' // slide up + professional bounce
              : 'transform 0.35s cubic-bezier(0.25, 1, 0.5, 1)' // slide down smoothly
          }}
        >
          {renderedPanel && (
            <>
              <div className="drawer-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 'bold' }}>
                  {renderedPanel === 'cpu' ? '[+] PROCESS MONITOR - SORT BY CPU' : '[+] PROCESS MONITOR - SORT BY RAM'}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ position: 'relative' }}>
                    <button
                      className="btn-tui"
                      onClick={() => { playSfx('click'); setShowProcSortMenu(!showProcSortMenu); }}
                      style={{ padding: '2px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                        <line x1="7" y1="7" x2="7.01" y2="7"></line>
                      </svg>
                      SORT
                    </button>
                    {showProcSortMenu && (
                      <div className="tags-dropdown" style={{
                        position: 'absolute',
                        top: '100%',
                        left: '50%',
                        marginTop: '8px',
                        backgroundColor: 'var(--color-surface-elevated)',
                        border: '1px solid var(--color-hairline)',
                        borderRadius: '4px',
                        padding: '8px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        zIndex: 100,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                        minWidth: '120px'
                      }}>
                        <button
                          className="btn-tui"
                          onClick={() => {
                            playSfx('click');
                            setProcSortBy('name');
                          }}
                          style={{
                            padding: '4px 8px',
                            fontSize: '11px',
                            borderColor: procSortBy === 'name' ? 'var(--color-success)' : 'var(--color-hairline-strong)',
                            color: procSortBy === 'name' ? 'var(--color-success)' : 'var(--color-mute)',
                            textAlign: 'left'
                          }}
                        >
                          {procSortBy === 'name' ? '[+] BY NAME' : '[ ] BY NAME'}
                        </button>
                        <button
                          className="btn-tui"
                          onClick={() => {
                            playSfx('click');
                            setProcSortBy('usage');
                          }}
                          style={{
                            padding: '4px 8px',
                            fontSize: '11px',
                            borderColor: procSortBy === 'usage' ? 'var(--color-success)' : 'var(--color-hairline-strong)',
                            color: procSortBy === 'usage' ? 'var(--color-success)' : 'var(--color-mute)',
                            textAlign: 'left'
                          }}
                        >
                          {procSortBy === 'usage' ? '[+] BY USAGE' : '[ ] BY USAGE'}
                        </button>
                      </div>
                    )}
                  </div>
                  <button 
                    className="btn-tui"
                    onClick={() => { playSfx('click'); setShowGraph(!showGraph); }}
                    style={{
                      padding: '2px 8px',
                      fontSize: '11px',
                      backgroundColor: showGraph ? 'var(--color-accent)' : 'transparent',
                      color: showGraph ? 'var(--color-on-canvas)' : 'var(--color-mute)',
                      border: '1px solid var(--color-hairline-strong)',
                      transition: 'all 0.2s ease',
                      textTransform: 'uppercase',
                      fontWeight: 'bold',
                      borderRadius: 'var(--rounded-sm)'
                    }}
                  >
                    {showGraph ? '[ HIDE GRAPH ]' : '[ SHOW GRAPH ]'}
                  </button>
                  <button className="titlebar-btn close" onClick={() => { playSfx('click'); setResourcePanel(null); }}>X</button>
                </div>
              </div>
              <div className="scroll-y" onScroll={playScrollSfx} style={{ padding: '8px' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '80px' }}>PID</th>
                      <th style={{ width: '40px' }}>Icon</th>
                      <th style={{ width: '180px' }}>Process Name</th>
                      <th>Executable Path</th>
                      <th style={{ width: '100px', textAlign: 'right', color: renderedPanel === 'ram' ? 'var(--color-accent)' : '' }}>Memory (MB)</th>
                      <th style={{ width: '80px', textAlign: 'right', color: renderedPanel === 'cpu' ? 'var(--color-success)' : '' }}>CPU (%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...runningProcesses]
                      .sort((a, b) => {
                        if (procSortBy === 'name') {
                          return a.name.localeCompare(b.name);
                        }
                        return renderedPanel === 'cpu' ? b.cpu_usage - a.cpu_usage : b.memory_mb - a.memory_mb;
                      })
                      .slice(0, 100) // Render top 100 to keep it snappy
                      .map((p, idx) => (
                      <tr key={idx}>
                        <td style={{ fontWeight: '700' }}>{p.pid}</td>
                        <td>
                          {p.icon_base64 ? (
                             <img src={`data:image/png;base64,${p.icon_base64}`} alt="icon" width="16" height="16" style={{ verticalAlign: 'middle' }} />
                          ) : (
                            <span className="text-mute" style={{ fontSize: '12px' }}>[?]</span>
                          )}
                        </td>
                        <td style={{ color: p.name.toLowerCase().includes('tauri') || p.name.toLowerCase().includes('java') ? 'var(--color-accent)' : 'var(--color-on-canvas)' }}>
                          {p.name}
                        </td>
                        <td className="text-mute" style={{ fontSize: '11px' }}>{p.exe || 'system helper'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 'bold' }} className="text-accent">{p.memory_mb} MB</td>
                        <td style={{ textAlign: 'right' }} className={p.cpu_usage > 5.0 ? 'text-warning' : 'text-success'}>
                          {p.cpu_usage.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Dynamic Panel Selection */}
        {activeTab === 'console' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, overflow: 'hidden' }}>
            <div className="section-border" style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-hairline-strong)', paddingBottom: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontWeight: '700' }}>[+] Live Watcher Feed (Latest Active Processes, Max 100)</span>
                  <button 
                    onClick={togglePause}
                    className="btn-tui"
                    style={{ 
                      padding: '2px 8px', 
                      fontSize: '11px', 
                      borderColor: isPaused ? 'var(--color-warning)' : 'var(--color-success)',
                      color: isPaused ? 'var(--color-warning)' : 'var(--color-success)'
                    }}
                  >
                    {isPaused ? '[▶ RESUME FEED]' : '[❚❚ PAUSE FEED]'}
                  </button>
                </div>
                <span className="text-mute">Click "Watcher Streams" for full tree</span>
              </div>
              <div className="scroll-y" onScroll={playScrollSfx}>
                {fileEvents.length === 0 ? (
                  <div className="text-mute" style={{ textAlign: 'center', padding: '32px' }}>
                    [-] No active events detected. Launch apps or modify files to stream events.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {/* Header Row */}
                    <div style={{ display: 'flex', borderBottom: '1px solid var(--color-hairline-strong)', padding: '6px 8px', fontWeight: 'bold', color: 'var(--color-mute)', fontSize: '11px' }}>
                      <div style={{ width: '100px', flexShrink: 0 }}>TIME</div>
                      <div style={{ width: '100px', flexShrink: 0 }}>OPERATION</div>
                      <div style={{ width: '180px', flexShrink: 0 }}>PROCESS</div>
                      <div style={{ flex: 1 }}>LAST TARGET FILE</div>
                    </div>
                    {/* Event Rows */}
                    {getAggregatedEvents().map((evt) => {
                      const procKey = evt.process_name || 'unknown';
                      return (
                        <div 
                          key={`${procKey}-${evt.timestamp}`}
                          className="scroll-fade-scale"
                          style={{ display: 'flex', alignItems: 'center', padding: '8px', borderBottom: '1px solid var(--color-hairline)' }}
                        >
                          <div className="entrance-item" style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                            <div style={{ width: '100px', flexShrink: 0, whiteSpace: 'nowrap' }} className="text-mute">
                              {new Date(evt.timestamp).toLocaleTimeString()}
                            </div>
                            <div style={{ width: '100px', flexShrink: 0, fontWeight: 'bold' }} className={
                              evt.operation_type === 'CREATE' ? 'text-success' :
                              evt.operation_type === 'DELETE' ? 'text-danger' : 'text-warning'
                            }>
                              [{evt.operation_type}]
                            </div>
                            <div style={{ width: '180px', flexShrink: 0, fontWeight: '700', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {getIconForProcess(evt.process_name) && (
                                <img 
                                  src={`data:image/png;base64,${getIconForProcess(evt.process_name)}`} 
                                  alt="" 
                                  style={{ width: '14px', height: '14px', objectFit: 'contain' }} 
                                />
                              )}
                              <span>{evt.process_name || 'unknown'}</span>
                            </div>
                            <div style={{ flex: 1, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', position: 'relative' }}>
                              <span
                                className="hover-file"
                                style={{ cursor: 'pointer', borderBottom: '1px dashed transparent', transition: 'border-color 0.1s' }}
                                onMouseEnter={(e) => {
                                  setHoveredPath(evt.file_path);
                                  setHoverPosition({ x: e.clientX, y: e.clientY });
                                }}
                                onMouseMove={(e) => {
                                  setHoverPosition({ x: e.clientX, y: e.clientY });
                                }}
                                onMouseLeave={() => {
                                  setHoveredPath(null);
                                }}
                                onClick={(e) => {
                                  playSfx('click');
                                  e.stopPropagation();
                                  setSelectedFile({ path: evt.file_path, x: e.clientX, y: e.clientY });
                                }}
                              >
                                {evt.file_path}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'watcher' && (
          <div className="section-border" style={{ flex: 1, overflow: 'hidden' }}>
            {/* Filter Tools */}
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', borderBottom: '1px solid var(--color-hairline)', paddingBottom: '12px' }}>
              <input 
                type="text" 
                placeholder="Search logs by path or app..."
                value={searchQuery}
                onClick={() => playSfx('click')}
                onChange={e => setSearchQuery(e.target.value)}
                style={{
                  background: 'var(--color-surface-elevated)',
                  border: '1px solid var(--color-hairline)',
                  borderRadius: '4px',
                  color: 'var(--color-on-canvas)',
                  padding: '6px 12px',
                  fontFamily: 'inherit',
                  fontSize: '12px',
                  flex: 1,
                  outline: 'none'
                }}
              />
              <div style={{ position: 'relative' }}>
                <button
                  className="btn-tui"
                  onClick={() => { playSfx('click'); setShowTagsMenu(!showTagsMenu); }}
                  style={{ padding: '4px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                    <line x1="7" y1="7" x2="7.01" y2="7"></line>
                  </svg>
                  TAGS
                </button>
                {showTagsMenu && (
                  <div className="tags-dropdown" style={{
                    position: 'absolute',
                    top: '100%',
                    left: '50%',
                    marginTop: '8px',
                    backgroundColor: 'var(--color-surface-elevated)',
                    border: '1px solid var(--color-hairline)',
                    borderRadius: '4px',
                    padding: '8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    zIndex: 100,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    minWidth: '120px'
                  }}>
                    {['CREATE', 'MODIFY', 'DELETE'].map(op => {
                      const state = tagStates[op];
                      let color = 'var(--color-mute)';
                      let border = 'var(--color-hairline-strong)';
                      let text = `[ ] ${op}`;
                      if (state === 1) {
                        color = 'var(--color-success)';
                        border = 'var(--color-success)';
                        text = `[+] ${op}`;
                      } else if (state === -1) {
                        color = 'var(--color-danger)';
                        border = 'var(--color-danger)';
                        text = `[-] ${op}`;
                      }
                      
                      return (
                        <button
                          key={op}
                          className="btn-tui"
                          onClick={() => {
                            playSfx('click');
                            setTagStates(prev => ({
                              ...prev,
                              [op]: prev[op] === 0 ? 1 : prev[op] === 1 ? -1 : 0
                            }));
                          }}
                          style={{
                            padding: '4px 8px',
                            fontSize: '11px',
                            borderColor: border,
                            color: color,
                            textAlign: 'left'
                          }}
                        >
                          {text}
                        </button>
                      );
                    })}
                    <div style={{ height: '1px', backgroundColor: 'var(--color-hairline)', margin: '2px 0' }} />
                    <button
                      className="btn-tui"
                      onClick={() => {
                        playSfx('click');
                        setTagStates({ CREATE: 0, MODIFY: 0, DELETE: 0 });
                      }}
                      style={{
                        padding: '4px 8px',
                        fontSize: '11px',
                        borderColor: Object.values(tagStates).every(v => v === 0) ? 'var(--color-success)' : 'var(--color-hairline-strong)',
                        color: Object.values(tagStates).every(v => v === 0) ? 'var(--color-success)' : 'var(--color-mute)',
                        textAlign: 'left'
                      }}
                    >
                      {Object.values(tagStates).every(v => v === 0) ? '[+] ALL' : '[ ] ALL'}
                    </button>
                  </div>
                )}
              </div>
              
              {/* Tree Controls */}
              <div style={{ display: 'flex', gap: '8px', padding: '0 4px' }}>
                <button 
                  className="btn-tui"
                  onClick={() => { playSfx('click'); expandAll(buildTree(filteredEvents, paths.watch_dir)); }}
                >
                  [+] Expand All
                </button>
                <button 
                  className="btn-tui"
                  onClick={() => { playSfx('click'); collapseAll(buildTree(filteredEvents, paths.watch_dir)); }}
                >
                  [-] Collapse All
                </button>
                <button 
                  className="btn-tui"
                  onClick={() => { playSfx('click'); handleToggleAutoCollapse(!autoCollapse); }}
                  style={{ marginLeft: 'auto', borderColor: autoCollapse ? 'var(--color-success)' : 'var(--color-hairline-strong)', color: autoCollapse ? 'var(--color-success)' : 'var(--color-on-canvas)' }}
                >
                  [{autoCollapse ? 'ON' : 'OFF'}] Auto Collapse
                </button>
              </div>
              
              <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span className="text-mute" style={{ fontSize: '11px', fontWeight: 'bold' }}>MODE:</span>
                <button 
                  onClick={() => { playSfx('click'); setWatcherMode('realtime'); }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: watcherMode === 'realtime' ? 'var(--color-success)' : 'var(--color-mute)',
                    fontFamily: 'inherit',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                  {watcherMode === 'realtime' ? '[REALTIME]' : 'REALTIME'}
                </button>
                <span className="text-mute">/</span>
                <button 
                  onClick={() => { playSfx('click'); setWatcherMode('all'); }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: watcherMode === 'all' ? 'var(--color-success)' : 'var(--color-mute)',
                    fontFamily: 'inherit',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                  {watcherMode === 'all' ? '[ALL]' : 'ALL'}
                </button>
              </div>
            </div>

            {/* Collapsible Tree Feed */}
            <div className="scroll-y" onScroll={playScrollSfx} style={{ padding: '8px 4px' }}>
              {filteredEvents.length === 0 ? (
                <div className="text-mute" style={{ textAlign: 'center', padding: '32px' }}>
                  [-] No matching records found in logs.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {renderTree(buildTree(filteredEvents, paths.watch_dir))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'device' && (
          <div className="section-border" style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>
              
              {/* Global Monitoring Mode Settings */}
              <div>
                <div style={{ fontWeight: '700', borderBottom: '1px solid var(--color-hairline-strong)', paddingBottom: '4px', marginBottom: '8px' }}>
                  [+] Application Configurations
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', padding: '12px', border: '1px solid var(--color-hairline)', borderRadius: '4px', background: 'rgba(0,0,0,0.1)' }}>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="checkbox"
                      id="closeToTrayToggle"
                      checked={closeToTray}
                      onChange={(e) => {
                        playSfx('click');
                        setCloseToTray(e.target.checked);
                        localStorage.setItem('closeToTray', e.target.checked);
                      }}
                      style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                    />
                    <label htmlFor="closeToTrayToggle" style={{ fontWeight: '700', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span>Minimize to System Tray on Close</span>
                      <span className="text-mute" style={{ fontWeight: 'normal', fontSize: '11px' }}>
                        When checked, closing the window will hide the app in your system tray instead of exiting.
                      </span>
                    </label>
                  </div>

                  <div style={{ width: '100%', height: '1px', background: 'var(--color-hairline)', margin: '4px 0' }} />

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="checkbox"
                      id="ignoreSysToggle"
                      checked={ignoreSystemApps}
                      onChange={(e) => {
                        playSfx('click');
                        handleToggleIgnoreSystem(e.target.checked);
                      }}
                      style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                    />
                    <label htmlFor="ignoreSysToggle" style={{ fontWeight: '700', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span>Ignore Background System Apps</span>
                      <span className="text-mute" style={{ fontWeight: 'normal', fontSize: '11px' }}>
                        Drops events from noisy Windows system processes like svchost.exe, registry, explorer.exe.
                      </span>
                    </label>
                  </div>

                  <div style={{ width: '100%', height: '1px', background: 'var(--color-hairline)', margin: '4px 0' }} />

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="checkbox"
                      id="globalModeToggle"
                      checked={globalMode}
                      onChange={(e) => {
                        playSfx('click');
                        handleToggleGlobalMode(e.target.checked);
                      }}
                      style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                    />
                    <label htmlFor="globalModeToggle" style={{ fontWeight: '700', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span>Global Monitoring Mode</span>
                      <span className="text-mute" style={{ fontWeight: 'normal', fontSize: '11px' }}>
                        {globalMode 
                          ? "Currently capturing all file events across the entire system." 
                          : "Filtering file events. Only directories registered in the watch list below will be monitored."}
                      </span>
                    </label>
                  </div>

                  <div style={{ width: '100%', height: '1px', background: 'var(--color-hairline)', margin: '4px 0' }} />

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="checkbox"
                      id="autoClearToggle"
                      checked={autoClearEnabled}
                      onChange={(e) => {
                        playSfx('click');
                        setAutoClearEnabled(e.target.checked);
                        localStorage.setItem('autoClearEnabled', e.target.checked);
                      }}
                      style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                    />
                    <label htmlFor="autoClearToggle" style={{ fontWeight: '700', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span>Auto-Clear Database Threshold</span>
                      <span className="text-mute" style={{ fontWeight: 'normal', fontSize: '11px' }}>
                        Automatically trigger VACUUM to wipe and shrink logs if the size exceeds this value.
                      </span>
                    </label>
                  </div>
                  
                  {autoClearEnabled && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '28px', marginTop: '-4px' }}>
                      <input 
                        type="number"
                        min="1"
                        value={autoClearSize}
                        onClick={() => playSfx('click')}
                        onChange={(e) => {
                          const val = Math.max(1, parseInt(e.target.value) || 1);
                          setAutoClearSize(val);
                          localStorage.setItem('autoClearSize', val);
                        }}
                        style={{
                          background: 'var(--color-surface-elevated)',
                          border: '1px solid var(--color-hairline-strong)',
                          borderRadius: '4px',
                          color: 'var(--color-on-canvas)',
                          padding: '4px 8px',
                          width: '80px',
                          fontFamily: 'inherit',
                          fontSize: '12px',
                          outline: 'none'
                        }}
                      />
                      <select
                        value={autoClearUnit}
                        onClick={() => playSfx('click')}
                        onChange={(e) => {
                          playSfx('click');
                          setAutoClearUnit(e.target.value);
                          localStorage.setItem('autoClearUnit', e.target.value);
                        }}
                        style={{
                          background: 'var(--color-surface-elevated)',
                          border: '1px solid var(--color-hairline-strong)',
                          borderRadius: '4px',
                          color: 'var(--color-on-canvas)',
                          padding: '4px 8px',
                          fontFamily: 'inherit',
                          fontSize: '12px',
                          outline: 'none',
                          cursor: 'pointer'
                        }}
                      >
                        <option value="MB">MB</option>
                        <option value="GB">GB</option>
                      </select>
                    </div>
                  )}

                  <div style={{ width: '100%', height: '1px', background: 'var(--color-hairline)', margin: '4px 0' }} />

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }}>
                    <button onClick={async () => { playSfx('click'); await invoke('exit_app'); }} className="btn-tui" style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}>
                      [x] Exit Application Completely
                    </button>
                    <span className="text-mute" style={{ fontSize: '11px' }}>Use this to fully terminate the background monitor service.</span>
                  </div>

                </div>
              </div>

              {/* Watch Target Manager */}
              <div>
                <div style={{ fontWeight: '700', borderBottom: '1px solid var(--color-hairline-strong)', paddingBottom: '4px', marginBottom: '8px' }}>
                  [+] Dynamic Watch Targets
                </div>
                
                {/* Manual Add Input */}
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  <input
                    type="text"
                    placeholder="Enter absolute directory path to watch..."
                    value={newTargetPath}
                    onClick={() => playSfx('click')}
                    onChange={(e) => setNewTargetPath(e.target.value)}
                    style={{
                      background: 'var(--color-surface-elevated)',
                      border: '1px solid var(--color-hairline-strong)',
                      borderRadius: '4px',
                      color: 'var(--color-on-canvas)',
                      padding: '6px 12px',
                      fontFamily: 'inherit',
                      fontSize: '12px',
                      flex: 1,
                      outline: 'none'
                    }}
                  />
                  <button 
                    onClick={() => { playSfx('click'); handleAddWatchTarget(newTargetPath); }} 
                    className="btn-tui"
                  >
                    [+] Watch Path
                  </button>
                </div>
                
                {targetError && (
                  <div className="text-danger" style={{ fontSize: '11px', marginBottom: '8px', fontWeight: 'bold' }}>
                    [-] Error: {targetError}
                  </div>
                )}

                {/* Quick Actions */}
                <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
                  {standardPaths.desktop && (
                    <button 
                      onClick={() => { playSfx('click'); handleAddWatchTarget(standardPaths.desktop); }} 
                      className="btn-tui"
                      style={{ fontSize: '11px', padding: '3px 8px' }}
                    >
                      [+] Watch Desktop
                    </button>
                  )}
                  {standardPaths.documents && (
                    <button 
                      onClick={() => { playSfx('click'); handleAddWatchTarget(standardPaths.documents); }} 
                      className="btn-tui"
                      style={{ fontSize: '11px', padding: '3px 8px' }}
                    >
                      [+] Watch Documents
                    </button>
                  )}
                  {standardPaths.downloads && (
                    <button 
                      onClick={() => { playSfx('click'); handleAddWatchTarget(standardPaths.downloads); }} 
                      className="btn-tui"
                      style={{ fontSize: '11px', padding: '3px 8px' }}
                    >
                      [+] Watch Downloads
                    </button>
                  )}
                </div>

                {/* Watched directories list */}
                <div className="scroll-y" onScroll={playScrollSfx} style={{ maxHeight: '160px', border: '1px solid var(--color-hairline)', padding: '8px', background: 'rgba(0,0,0,0.1)' }}>
                  {watchTargets.length === 0 ? (
                    <div className="text-mute">[-] No dynamic watch targets registered.</div>
                  ) : (
                    watchTargets.map((target, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--color-hairline)' }}>
                        <span style={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: '12px', color: '#ff9f0a' }}>
                          [{idx + 1}] {target}
                        </span>
                        <button 
                          onClick={() => { playSfx('click'); handleRemoveWatchTarget(target); }} 
                          className="btn-tui"
                          style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)', fontSize: '11px', padding: '1px 6px', marginLeft: '12px' }}
                        >
                          [x] Unwatch
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Data Storage Info Card */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
                <div className="card-elevated" style={{ fontSize: '11px' }}>
                  <span className="text-mute">[-] DB Location: </span>
                  <span style={{ color: '#007aff', wordBreak: 'break-all' }}>{paths.db_path}</span>
                </div>
              </div>

              {/* Wipe Cache & Manual Sync Controls */}
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <button onClick={() => { playSfx('click'); refreshData(); }} className="btn-tui">
                  [+] Manual DB Sync
                </button>
                <button onClick={async () => {
                  playSfx('click');
                  try {
                    if (window.showSaveFilePicker) {
                      const handle = await window.showSaveFilePicker({
                        suggestedName: `AET_export_${Date.now()}.json`,
                        types: [{
                          description: 'JSON Files',
                          accept: { 'application/json': ['.json'] },
                        }],
                      });
                      const writable = await handle.createWritable();
                      const events = await invoke('get_file_events');
                      const jsonStr = JSON.stringify(events, null, 2);
                      await writable.write(jsonStr);
                      await writable.close();
                      return;
                    }
                    
                    // Fallback if File System Access API is not available
                    const events = await invoke('get_file_events');
                    const jsonStr = JSON.stringify(events, null, 2);
                    const blob = new Blob([jsonStr], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `AET_export_${Date.now()}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (e) {
                    if (e.name !== 'AbortError') {
                      console.error("Export failed", e);
                    }
                  }
                }} className="btn-tui">
                  [+] Export DB to JSON
                </button>
                <button onClick={() => { playSfx('click'); handleClearLogs(); }} className="btn-tui" style={{ borderColor: '#ff3b30', color: '#ff3b30' }}>
                  [x] Wipe Database &amp; Clean Cache
                </button>
              </div>

              {/* Subprocess Diagnostics Stream */}
              <div>
                <div style={{ fontWeight: '700', borderBottom: '1px solid var(--color-hairline-strong)', paddingBottom: '4px', marginBottom: '6px' }}>
                  [+] Diagnostics Subprocess Logs
                </div>
                <div className="scroll-y" onScroll={playScrollSfx} style={{ maxHeight: '120px', background: 'rgba(0,0,0,0.2)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {systemLogs.length === 0 ? (
                    <div className="text-mute">[-] Diagnostic stream is quiet.</div>
                  ) : (
                    systemLogs.map((log, idx) => (
                      <div key={idx} style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                        <span className="text-mute">[{idx + 1}]</span> &gt; {log}
                      </div>
                    ))
                  )}
                </div>
              </div>

            </div>
          </div>
        )}

        {activeTab === 'processes' && (
          <div className="section-border" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            
            {/* Part 1: Logged File-activity Processes */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderBottom: '1px solid var(--color-hairline)', paddingBottom: '12px' }}>
              <div style={{ fontWeight: '700', paddingBottom: '6px' }}>
                [+] Logged File-Activity Registry (from DB logs)
              </div>
              <div className="scroll-y" onScroll={playScrollSfx} style={{ flex: 1 }}>
                {monitoredApps.length === 0 ? (
                   <div className="text-mute" style={{ textAlign: 'center', padding: '16px' }}>
                     [-] No active processes registered yet.
                   </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>PID</th>
                        <th>Icon</th>
                        <th>Process Name</th>
                        <th>Executable Path</th>
                        <th>First Logged</th>
                        <th>Last Logged</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monitoredApps.map((app, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: '700' }}>{app.pid}</td>
                          <td>
                            {app.icon_base64 ? (
                              <img src={`data:image/png;base64,${app.icon_base64}`} alt="icon" width="16" height="16" style={{ verticalAlign: 'middle' }} />
                            ) : (
                              <span className="text-mute" style={{ fontSize: '12px' }}>[?]</span>
                            )}
                          </td>
                          <td className="text-success">{app.process_name}</td>
                          <td>{app.executable_path}</td>
                          <td className="text-mute">{new Date(app.first_seen).toLocaleTimeString()}</td>
                          <td className="text-mute">{new Date(app.last_seen).toLocaleTimeString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Part 2: Active System Processes (Task Manager List) */}
            <div style={{ flex: 2, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '6px' }}>
                <span style={{ fontWeight: '700' }}>[+] Live System Processes ({runningProcesses.length} active)</span>
                
                {/* Process Search Input */}
                <input 
                  type="text" 
                  placeholder="Filter running processes..."
                  value={procSearchQuery}
                  onClick={() => playSfx('click')}
                  onChange={e => setProcSearchQuery(e.target.value)}
                  style={{
                    background: 'var(--color-surface-elevated)',
                    border: '1px solid var(--color-hairline)',
                    borderRadius: '4px',
                    color: 'var(--color-on-canvas)',
                    padding: '3px 8px',
                    fontFamily: 'inherit',
                    fontSize: '11px',
                    width: '200px',
                    outline: 'none'
                  }}
                />
              </div>
              <div className="scroll-y" onScroll={playScrollSfx} style={{ flex: 1 }}>
                {filteredRunningProcesses.length === 0 ? (
                  <div className="text-mute" style={{ textAlign: 'center', padding: '16px' }}>
                    [-] No matching processes found.
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: '80px' }}>PID</th>
                        <th style={{ width: '40px' }}>Icon</th>
                        <th style={{ width: '180px' }}>Process Name</th>
                        <th>Executable Path</th>
                        <th style={{ width: '100px', textAlign: 'right' }}>Memory (MB)</th>
                        <th style={{ width: '80px', textAlign: 'right' }}>CPU (%)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRunningProcesses.map((p, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: '700' }}>{p.pid}</td>
                          <td>
                            {p.icon_base64 ? (
                              <img src={`data:image/png;base64,${p.icon_base64}`} alt="icon" width="16" height="16" style={{ verticalAlign: 'middle' }} />
                            ) : (
                              <span className="text-mute" style={{ fontSize: '12px' }}>[?]</span>
                            )}
                          </td>
                          <td style={{ color: p.name.toLowerCase().includes('tauri') || p.name.toLowerCase().includes('java') ? 'var(--color-accent)' : 'var(--color-on-canvas)' }}>
                            {p.name}
                          </td>
                          <td className="text-mute" style={{ fontSize: '11px' }}>{p.exe || 'system helper'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 'bold' }} className="text-accent">{p.memory_mb} MB</td>
                          <td style={{ textAlign: 'right' }} className={p.cpu_usage > 5.0 ? 'text-warning' : 'text-success'}>
                            {p.cpu_usage.toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

          </div>
        )}

        {activeTab === 'shell' && (
          <div className="section-border" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px', borderBottom: '1px solid var(--color-hairline-strong)' }}>
              <span className="text-mute" style={{ fontWeight: 'bold', fontSize: '11px' }}>AKIFILEMONITOR SQL TERMINAL</span>
              <span className="text-accent" style={{ fontWeight: 'bold', fontSize: '11px' }}>LOCAL DB SIZE: {dbSizeMb.toFixed(2)} MB</span>
            </div>
            <div ref={consoleContainerRef} className="tui-console" style={{ flex: 1 }} onScroll={playScrollSfx}>
              {shellHistory.map((line, idx) => {
                if (line.type === 'cmd') {
                  return <div key={idx} style={{ color: '#fdfcfc' }}>{line.text}</div>;
                } else if (line.type === 'err') {
                  return <div key={idx} style={{ color: '#ff3b30' }}>{line.text}</div>;
                } else if (line.type === 'table') {
                  return (
                    <div key={idx} style={{ margin: '8px 0', border: '1px solid rgba(253,252,252,0.2)', padding: '8px' }}>
                      <table>
                        <thead>
                          <tr>
                            {line.headers.map((h, i) => <th key={i} style={{ color: '#9a9898' }}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {line.rows.map((row, i) => (
                            <tr key={i}>
                              {row.map((cell, cIdx) => <td key={cIdx} style={{ color: '#30d158' }}>{cell}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                } else {
                  return <div key={idx} style={{ color: '#30d158' }}>{line.text}</div>;
                }
              })}
            </div>

            {/* Autocomplete Menu */}
            {showAutocomplete && (
              <div style={{
                borderTop: '1px solid var(--color-hairline-strong)',
                background: 'var(--color-surface-elevated)',
                padding: '4px 8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                fontSize: '11px'
              }}>
                <div className="text-mute" style={{ marginBottom: '4px' }}>Options (Navigate with Alt+W/Alt+S or Arrows, Enter to select):</div>
                {sqlSuggestions.map((sug, idx) => (
                  <div key={idx} style={{
                    color: idx === autocompleteIndex ? '#fdfcfc' : '#9a9898',
                    background: idx === autocompleteIndex ? 'rgba(253,252,252,0.1)' : 'transparent',
                    padding: '2px 4px',
                    cursor: 'pointer',
                    transition: 'all 0.1s ease'
                  }} 
                  onMouseEnter={() => { setAutocompleteIndex(idx); }}
                  onClick={() => {
                    playSfx('click');
                    setShellInput(sug);
                    setShowAutocomplete(false);
                  }}>
                    {idx === autocompleteIndex ? '> ' : '  '}{sug}
                  </div>
                ))}
              </div>
            )}

            {/* Input prompt */}
            <form onSubmit={(e) => {
              if (showAutocomplete) {
                e.preventDefault();
                setShellInput(sqlSuggestions[autocompleteIndex]);
                setShowAutocomplete(false);
              } else {
                handleShellCommand(e);
              }
            }} className="tui-input-line" style={{ display: 'flex', alignItems: 'center' }}>
              <span className="text-success" style={{ fontWeight: '700', marginRight: '8px' }}>sql&gt;</span>
              <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
                <input 
                  type="text" 
                  value={shellInput}
                  onFocus={() => setShowAutocomplete(true)}
                  onBlur={() => setTimeout(() => setShowAutocomplete(false), 200)}
                  onClick={() => playSfx('click')}
                  onChange={e => {
                    setShellInput(e.target.value);
                    setShowAutocomplete(true);
                  }}
                  onKeyDown={(e) => {
                    if (showAutocomplete) {
                      if (e.key === 'ArrowDown' || (e.altKey && e.key.toLowerCase() === 's')) {
                        e.preventDefault();
                        setAutocompleteIndex(prev => Math.min(prev + 1, sqlSuggestions.length - 1));
                      } else if (e.key === 'ArrowUp' || (e.altKey && e.key.toLowerCase() === 'w')) {
                        e.preventDefault();
                        setAutocompleteIndex(prev => Math.max(prev - 1, 0));
                      } else if (e.key === 'Escape') {
                        setShowAutocomplete(false);
                      }
                    } else {
                      // Quick reopen
                      if ((e.altKey && e.key.toLowerCase() === 's') || e.key === 'ArrowDown') {
                         setShowAutocomplete(true);
                      }
                    }
                  }}
                  placeholder="Type HELP for list of actions or use Alt+W/S for options..."
                  className="tui-input"
                  style={{ flex: 1 }}
                  autoFocus
                />
                <span className="text-success cursor-blink" style={{ position: 'absolute', right: 0 }}>█</span>
              </div>
              <button 
                type="submit" 
                onClick={() => playSfx('click')}
                className="btn-tui" 
                style={{ marginLeft: '12px', padding: '4px 12px', fontSize: '11px', borderColor: 'var(--color-accent)', color: 'var(--color-accent)' }}
              >
                [RUN]
              </button>
            </form>
          </div>
        )}

      </div>

      {/* Absolute Path Tooltip on Hover */}
      {hoveredPath && (
        <div style={{
          position: 'fixed',
          left: hoverPosition.x + 15,
          top: hoverPosition.y + 15,
          background: 'rgba(15, 0, 0, 0.85)',
          backdropFilter: 'blur(8px)',
          border: '1px solid var(--color-hairline-strong)',
          borderRadius: '4px',
          padding: '6px 12px',
          color: '#fdfcfc',
          fontFamily: 'monospace',
          fontSize: '11px',
          zIndex: 9999,
          pointerEvents: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.8)'
        }}>
          <span style={{ color: 'var(--color-warning)', fontWeight: 'bold' }}>[Location]</span> {hoveredPath}
        </div>
      )}

      {/* TUI Action Popup on File Click */}
      {selectedFile && (
        <>
          <div 
            onClick={() => setSelectedFile(null)}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh',
              zIndex: 9998,
              background: 'transparent'
            }}
          />
          <div style={{
            position: 'fixed',
            left: Math.min(selectedFile.x, window.innerWidth - 220),
            top: Math.min(selectedFile.y, window.innerHeight - 120),
            background: 'rgba(26, 24, 24, 0.95)',
            backdropFilter: 'blur(12px)',
            border: '1px solid var(--color-hairline-strong)',
            borderRadius: '6px',
            padding: '8px',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            boxShadow: '0 12px 32px rgba(0,0,0,0.8)',
            fontFamily: 'monospace'
          }}>
            <div style={{ padding: '4px 8px', fontSize: '11px', borderBottom: '1px solid var(--color-hairline)', color: 'var(--color-mute)', marginBottom: '4px', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--color-on-canvas)' }}>{selectedFile.path.substring(Math.max(selectedFile.path.lastIndexOf('\\'), selectedFile.path.lastIndexOf('/')) + 1)}</span>
            </div>
            <button 
              className="btn-tui" 
              style={{ width: '100%', border: '1px solid transparent', textAlign: 'left', cursor: 'pointer', padding: '6px 12px', background: 'var(--color-surface-elevated)', transition: 'all 0.1s ease', color: 'var(--color-success)' }}
              onMouseOver={(e) => { e.currentTarget.style.border = '1px solid var(--color-success)'; }}
              onMouseOut={(e) => { e.currentTarget.style.border = '1px solid transparent'; }}
              onClick={async () => {
                playSfx('click');
                try {
                  await invoke('open_in_explorer', { path: selectedFile.path });
                } catch (err) {
                  console.error(err);
                }
                setSelectedFile(null);
              }}
            >
              [+] Open in Explorer
            </button>
            <button 
              className="btn-tui" 
              style={{ width: '100%', border: '1px solid transparent', textAlign: 'left', cursor: 'pointer', padding: '6px 12px', background: 'var(--color-surface-elevated)', transition: 'all 0.1s ease', color: 'var(--color-accent)' }}
              onMouseOver={(e) => { e.currentTarget.style.border = '1px solid var(--color-accent)'; }}
              onMouseOut={(e) => { e.currentTarget.style.border = '1px solid transparent'; }}
              onClick={async () => {
                playSfx('click');
                try {
                  await navigator.clipboard.writeText(selectedFile.path);
                } catch (err) {
                  console.error(err);
                }
                setSelectedFile(null);
              }}
            >
              [+] Copy Full Path
            </button>
            <button 
              className="btn-tui" 
              style={{ width: '100%', border: '1px solid transparent', color: 'var(--color-danger)', textAlign: 'left', cursor: 'pointer', padding: '6px 12px', background: 'var(--color-surface-elevated)', transition: 'all 0.1s ease' }}
              onMouseOver={(e) => { e.currentTarget.style.border = '1px solid var(--color-danger)'; }}
              onMouseOut={(e) => { e.currentTarget.style.border = '1px solid transparent'; }}
              onClick={() => { playSfx('click'); setSelectedFile(null); }}
            >
              [−] Close Menu
            </button>
          </div>
        </>
      )}

    </div>
  );
}
