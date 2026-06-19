# AKI Event Tracker (AET)

A lightweight, secure desktop file and process activity monitor. The system leverages Tauri (Rust) for secure, system-level execution, React for the user interface, Java (JVM) as a background processing sidecar for system-level polling and analysis, and SQLite as a lightweight embedded database.

## System Architecture

The application is structured as a three-process system:
- **React Frontend**: Renders the monospaced user interface using dark mode defaults, displays real-time event logs, and communicates with Tauri.
- **Tauri Rust Controller**: Manages native windowing, implements custom borderless window drag/controls, exposes SQLite querying APIs, and manages the lifecycle of the Java sidecar.
- **Java Analyzer Sidecar**: Spawns as a background child process. It performs directory watches via NIO WatchService and process tracking via ProcessHandle APIs, writing events directly into the shared SQLite database.

## Prerequisites

To build and run this project, you must install the following toolchains:

1. **Node.js**: (v16 or higher) for the React frontend.
2. **Rust**: (`rustup`, `cargo`, `rustc`) for the Tauri backend.
3. **Java Development Kit (JDK)**: (Version 17 or higher) for the Java Analyzer Sidecar.
4. **Maven**: For building the Java Sidecar JAR.

## Build Instructions

Before running the application, the Java sidecar must be built into an executable JAR.

1. **Build the Java Sidecar**:
   Navigate to the `src-java` directory and package the sidecar:
   ```bash
   cd src-java
   mvn clean package
   ```
   This command compiles the Java source code and bundles dependencies into `monitor-core.jar`. Make sure to configure the system to place this JAR inside the `src-tauri/bin/` directory for Tauri to spawn it.

2. **Install Frontend Dependencies**:
   Navigate to the `src-ui` directory and install the node modules:
   ```bash
   cd src-ui
   npm install
   ```

## Running the Application

To start the application in development mode:

```bash
cd src-ui
npm run tauri dev
```

This command will:
- Start the Vite development server.
- Compile and run the Tauri application.
- Tauri will automatically spawn the Java Sidecar process.

## Packaging for Release

To create a standalone executable for your platform (e.g., `.msi` or `.exe` on Windows):

```bash
cd src-ui
npm run tauri build
```
The compiled binaries will be located in the `src-tauri/target/release/bundle` directory.

## Features

- **Global File Monitoring**: Captures file creation, modification, and deletion events in real-time.
- **Process Association**: Identifies the processes responsible for file modifications.
- **System Metrics**: Displays CPU and Memory usage statistics.
- **Dark Mode Aesthetic**: A minimal, professional Retro TUI interface with immersive animations.

## License

This project is licensed under the MIT License.
