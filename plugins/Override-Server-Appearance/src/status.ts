// tag added to all print statements to help with debugging with logcat on adb
const TAG = "[server-appearance]";

// what happened on load, shown at the bottom of the settings screen
export const statusLines: string[] = [];

export function status(message: string): void {
    statusLines.push(message);
    try {
        console.log(`${TAG} ${message}`);
    } catch {
        // logging must never break the plugin
    }
}

// how often Discord asked for a server icon / banner, and how often an override was handed back.
// shown in settings: calls staying at 0 means the patched functions are not the ones Discord uses
export const stats = { calls: 0, icon: 0, banner: 0 };

export function resetStatus(): void {
    statusLines.length = 0;
    stats.calls = 0;
    stats.icon = 0;
    stats.banner = 0;
}
