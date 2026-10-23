use std::{path::PathBuf, time::Duration};

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        eprintln!(
            "usage: native_v86_boot <absolute-asset-root> <bios-sha256> <kernel-sha256> <initrd-sha256>"
        );
        std::process::exit(2);
    }
    let root = PathBuf::from(&args[0]);
    match holonomy_desktop_v8::probe_v86_boot(
        &root,
        [args[1].clone(), args[2].clone(), args[3].clone()],
        Duration::from_secs(15),
    ) {
        Ok(serial) if !serial.is_empty() => {
            for byte in serial {
                print!("{byte:02x}");
            }
            println!();
        }
        Ok(_) => {
            eprintln!("v86 produced no UART1 bytes; stock boot is unproven");
            std::process::exit(1);
        }
        Err(error) => {
            eprintln!("native v86 probe failed: {error}");
            std::process::exit(1);
        }
    }
}
