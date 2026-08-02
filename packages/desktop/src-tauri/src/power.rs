//! Keep-awake for long download batches: SetThreadExecutionState with
//! ES_CONTINUOUS is scoped to the CALLING thread, and Tauri commands run on a
//! thread pool — so the state is owned by one dedicated long-lived thread that
//! receives on/off requests over a channel. Display may still sleep; only
//! system sleep is blocked (matches Android's best-effort keep-awake).

#[cfg(windows)]
mod win {
    pub const ES_CONTINUOUS: u32 = 0x8000_0000;
    pub const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn SetThreadExecutionState(es_flags: u32) -> u32;
    }
}

#[cfg(windows)]
fn keep_awake_sender() -> &'static std::sync::mpsc::Sender<bool> {
    use std::sync::mpsc::Sender;
    use std::sync::OnceLock;
    static TX: OnceLock<Sender<bool>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        std::thread::Builder::new()
            .name("convertx-keep-awake".to_string())
            .spawn(move || {
                for active in rx {
                    unsafe {
                        if active {
                            win::SetThreadExecutionState(
                                win::ES_CONTINUOUS | win::ES_SYSTEM_REQUIRED,
                            );
                        } else {
                            win::SetThreadExecutionState(win::ES_CONTINUOUS);
                        }
                    }
                }
            })
            .expect("failed to spawn keep-awake thread");
        tx
    })
}

/// Block (or re-allow) system sleep. Best-effort: failures are swallowed —
/// a download must never fail because the power request did.
#[tauri::command]
pub fn set_keep_awake(active: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = keep_awake_sender().send(active);
    }
    #[cfg(not(windows))]
    {
        let _ = active;
    }
    Ok(())
}
