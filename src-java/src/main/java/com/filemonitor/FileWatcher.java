package com.filemonitor;

import java.io.IOException;
import java.nio.file.*;
import static java.nio.file.StandardWatchEventKinds.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

public class FileWatcher implements Runnable {
    private final WatchService watchService;
    private final Path initialPath;
    private final DatabaseManager dbManager;
    private final java.util.Set<Path> registeredPaths = new java.util.HashSet<>();
    private final ObjectMapper mapper = new ObjectMapper();

    public FileWatcher(String pathStr, DatabaseManager dbManager) throws IOException {
        this.watchService = FileSystems.getDefault().newWatchService();
        this.initialPath = Paths.get(pathStr);
        this.dbManager = dbManager;
    }

    private void logSystem(String message) {
        try {
            ObjectNode node = mapper.createObjectNode();
            node.put("event_type", "SYSTEM");
            node.put("data", message);
            System.out.println(mapper.writeValueAsString(node));
            System.out.flush();
        } catch (Exception e) {
            System.err.println("Failed to log system message: " + e.getMessage());
        }
    }

    private void logFileChange(String timestamp, int pid, String processName, String filePath, String operation) {
        try {
            ObjectNode dataNode = mapper.createObjectNode();
            dataNode.put("timestamp", timestamp);
            dataNode.put("pid", pid);
            dataNode.put("process_name", processName);
            dataNode.put("file_path", filePath);
            dataNode.put("operation_type", operation);

            ObjectNode rootNode = mapper.createObjectNode();
            rootNode.put("event_type", "FILE_CHANGE");
            rootNode.set("data", dataNode);

            System.out.println(mapper.writeValueAsString(rootNode));
            System.out.flush();
        } catch (Exception e) {
            System.err.println("Failed to log file change: " + e.getMessage());
        }
    }

    private void registerRecursive(Path root) {
        try {
            if (!Files.exists(root) || !Files.isDirectory(root)) {
                return;
            }
            Files.walkFileTree(root, new SimpleFileVisitor<Path>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                    if (!registeredPaths.contains(dir)) {
                        try {
                            dir.register(watchService, ENTRY_CREATE, ENTRY_MODIFY, ENTRY_DELETE);
                            registeredPaths.add(dir);
                            logSystem("Registered new watch folder: " + dir.toAbsolutePath().toString());
                        } catch (IOException | SecurityException e) {
                            // Skip directories we don't have access to
                        }
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException exc) throws IOException {
                    // Skip files or directories that throw errors on visitation
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (Exception e) {
            logSystem("Error during recursive registration of " + root + ": " + e.getMessage());
        }
    }

    @Override
    public void run() {
        // Register initial path and all its subfolders
        registerRecursive(this.initialPath);

        try {
            while (!Thread.currentThread().isInterrupted()) {
                // Sync watch targets from database
                try {
                    java.util.List<String> targets = dbManager.getWatchTargets();
                    for (String tStr : targets) {
                        Path targetPath = Paths.get(tStr);
                        if (Files.exists(targetPath) && !registeredPaths.contains(targetPath)) {
                            registerRecursive(targetPath);
                        }
                    }
                } catch (Exception e) {
                    System.err.println("Error syncing watch targets: " + e.getMessage());
                }

                // Poll watch service with a timeout (1000ms) to allow loop continuation
                WatchKey key = watchService.poll(1000, java.util.concurrent.TimeUnit.MILLISECONDS);
                if (key == null) {
                    continue;
                }

                // Get the parent folder this key belongs to
                Path dir = (Path) key.watchable();

                for (WatchEvent<?> event : key.pollEvents()) {
                    WatchEvent.Kind<?> kind = event.kind();
                    if (kind == OVERFLOW) {
                        continue;
                    }

                    Path file = (Path) event.context();
                    Path resolvedPath = dir.resolve(file);
                    
                    String operation = "MODIFY";
                    if (kind == ENTRY_CREATE) {
                        operation = "CREATE";
                        // If a new directory was created, register it and its subdirectories
                        if (Files.isDirectory(resolvedPath, LinkOption.NOFOLLOW_LINKS)) {
                            registerRecursive(resolvedPath);
                        }
                    } else if (kind == ENTRY_DELETE) {
                        operation = "DELETE";
                    }

                    // Retrieve current foreground window process
                    ProcessTracker.ProcessInfo proc = ProcessTracker.getForegroundProcess();
                    
                    // Log process details if valid
                    if (proc.pid > 0) {
                        dbManager.insertProcess(proc.pid, proc.name, proc.path);
                    }
                    
                    // Write to database
                    dbManager.insertFileEvent(
                        resolvedPath.toAbsolutePath().toString(),
                        operation,
                        proc.pid
                    );
                    
                    // Format and print JSON to stdout
                    logFileChange(
                        Instant.now().toString(),
                        proc.pid,
                        proc.name,
                        resolvedPath.toAbsolutePath().toString(),
                        operation
                    );
                }
                key.reset();
            }
        } catch (InterruptedException e) {
            System.err.println("File watcher thread was interrupted.");
        }
    }
}

