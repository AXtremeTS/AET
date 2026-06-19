package com.filemonitor;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;

public class DatabaseManager {
    private final String dbUrl;

    public DatabaseManager(String dbPath) {
        this.dbUrl = "jdbc:sqlite:" + dbPath;
        initializeDatabase();
    }

    private void initializeDatabase() {
        try (Connection conn = DriverManager.getConnection(dbUrl);
             Statement stmt = conn.createStatement()) {
            
            // Create monitored_apps table
            stmt.execute("CREATE TABLE IF NOT EXISTS monitored_apps (" +
                         "pid INTEGER PRIMARY KEY, " +
                         "process_name TEXT NOT NULL, " +
                         "executable_path TEXT, " +
                         "first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
                         "last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");

            // Create file_events table
            stmt.execute("CREATE TABLE IF NOT EXISTS file_events (" +
                         "event_id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                         "timestamp TEXT NOT NULL, " +
                         "pid INTEGER, " +
                         "file_path TEXT NOT NULL, " +
                         "operation_type TEXT NOT NULL, " +
                         "FOREIGN KEY(pid) REFERENCES monitored_apps(pid) ON DELETE SET NULL)");

            // Create Indexes
            stmt.execute("CREATE INDEX IF NOT EXISTS idx_file_events_timestamp ON file_events(timestamp)");
            stmt.execute("CREATE INDEX IF NOT EXISTS idx_file_events_path ON file_events(file_path)");

            // Create watch_targets table
            stmt.execute("CREATE TABLE IF NOT EXISTS watch_targets (" +
                         "path TEXT PRIMARY KEY, " +
                         "added_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");

        } catch (SQLException e) {
            System.err.println("Failed to initialize database: " + e.getMessage());
        }
    }

    public synchronized void insertProcess(int pid, String name, String path) {
        String sql = "INSERT OR REPLACE INTO monitored_apps(pid, process_name, executable_path, last_seen) VALUES(?, ?, ?, ?)";
        try (Connection conn = DriverManager.getConnection(dbUrl);
             PreparedStatement pstmt = conn.prepareStatement(sql)) {
            pstmt.setInt(1, pid);
            pstmt.setString(2, name);
            pstmt.setString(3, path);
            pstmt.setString(4, Instant.now().toString());
            pstmt.executeUpdate();
        } catch (SQLException e) {
            System.err.println("Database process write error: " + e.getMessage());
        }
    }

    public synchronized void insertFileEvent(String filePath, String opType, int pid) {
        String sql = "INSERT INTO file_events(timestamp, pid, file_path, operation_type) VALUES(?, ?, ?, ?)";
        try (Connection conn = DriverManager.getConnection(dbUrl);
             PreparedStatement pstmt = conn.prepareStatement(sql)) {
            pstmt.setString(1, Instant.now().toString());
            if (pid > 0) {
                pstmt.setInt(2, pid);
            } else {
                pstmt.setNull(2, java.sql.Types.INTEGER);
            }
            pstmt.setString(3, filePath);
            pstmt.setString(4, opType);
            pstmt.executeUpdate();
        } catch (SQLException e) {
            System.err.println("Database file event write error: " + e.getMessage());
        }
    }

    public synchronized java.util.List<String> getWatchTargets() {
        java.util.List<String> list = new java.util.ArrayList<>();
        String sql = "SELECT path FROM watch_targets";
        try (Connection conn = DriverManager.getConnection(dbUrl);
             Statement stmt = conn.createStatement();
             java.sql.ResultSet rs = stmt.executeQuery(sql)) {
            while (rs.next()) {
                list.add(rs.getString("path"));
            }
        } catch (SQLException e) {
            System.err.println("Database watch target query error: " + e.getMessage());
        }
        return list;
    }
}
