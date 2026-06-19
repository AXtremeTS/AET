use sysinfo::{System, ProcessesToUpdate}; fn main() { let mut sys = System::new_all(); sys.refresh_processes(ProcessesToUpdate::All, true); println!("Count: {}", sys.processes().len()); }
