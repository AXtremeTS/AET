package com.filemonitor;

import java.io.File;
import java.io.IOException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

public class Main {
    private static final ObjectMapper mapper = new ObjectMapper();

    private static void logSystem(String message) {
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

    public static void main(String[] args) {
        if (args.length < 2) {
            System.err.println("Usage: java -jar monitor-core.jar <watch-directory> <database-path>");
            System.exit(1);
        }

        String watchDir = args[0];
        String dbPath = args[1];

        // Create watch directory if it doesn't exist
        File dir = new File(watchDir);
        if (!dir.exists()) {
            boolean created = dir.mkdirs();
            if (created) {
                logSystem("Created watch directory: " + watchDir);
            }
        }

        logSystem("Initializing SQLite Database connection at: " + dbPath);
        DatabaseManager dbManager = new DatabaseManager(dbPath);

        logSystem("Starting watcher service for directory: " + watchDir);
        try {
            FileWatcher watcher = new FileWatcher(watchDir, dbManager);
            Thread watcherThread = new Thread(watcher);
            watcherThread.setDaemon(true);
            watcherThread.start();
            
            logSystem("Watcher active. Listening for file changes...");

            // Keep the main thread alive
            while (true) {
                Thread.sleep(1000);
            }
        } catch (IOException e) {
            System.err.println("Failed to start file watcher: " + e.getMessage());
            System.exit(1);
        } catch (InterruptedException e) {
            logSystem("Monitor system shutting down.");
        }
    }
}

