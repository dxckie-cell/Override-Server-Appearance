import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";

import { resetStatus, status } from "./status";

const VERSION = "1.0.0";

// placeholder hashes, only used so the UI draws an icon / banner for servers
// that have none of their own; the real image comes from the override
const PLACEHOLDER_ICON = "override-server-icon";
const PLACEHOLDER_BANNER = "override-server-banner";

type Kind = "icon" | "banner";

export interface ServerOverride {
    id: string;
    icon: string;
    banner: string;
}

let patches: (() => void)[] = [];

// guilds we put a placeholder on, with what each field was before
const injected = new Map<any, { icon?: any; banner?: any }>();

// guilds whose hasFeature we replaced so the banner area is allowed to draw
const featurePatched = new Set<any>();

export { default as settings } from "./settings";

function initStorage(): void {
    if (!Array.isArray(storage.overrides)) {
        storage.overrides = [];
    }
}

// looks up the override at call time so edits in settings apply without reloading
function getOverrideUrl(guildId: string | undefined, kind: Kind): string | undefined {
    if (!guildId) return undefined;
    const list: ServerOverride[] = storage.overrides ?? [];
    for (const entry of list) {
        if (entry?.id?.trim() === guildId) {
            const url = entry[kind]?.trim();
            if (url) return url;
        }
    }
    return undefined;
}

function hasAnyOverride(guildId?: string): boolean {
    return !!getOverrideUrl(guildId, "icon") || !!getOverrideUrl(guildId, "banner");
}

// wraps obj[key] so that `wrapper(original, self, args)` runs instead, and
// registers a function that puts the original back on unload
function wrap(obj: any, key: string, wrapper: (original: Function, self: any, args: any[]) => any): boolean {
    try {
        const original = obj?.[key];
        if (typeof original !== "function") return false;

        obj[key] = function (...args: any[]) {
            return wrapper(original, this, args);
        };
        patches.push(() => { obj[key] = original; });
        return true;
    } catch {
        return false;
    }
}

// gives an overridden guild an icon / banner so the UI draws the area for it.
// changed in place (and restored on unload) so any methods on the object keep working
function addPlaceholders(guild: any): void {
    if (!guild || typeof guild !== "object") return;
    const id = guild.id;
    if (!hasAnyOverride(id)) return;

    try {
        const before = injected.get(guild) ?? {};

        if (!guild.icon && getOverrideUrl(id, "icon")) {
            if (!("icon" in before)) before.icon = guild.icon;
            guild.icon = PLACEHOLDER_ICON;
        }
        if (!guild.banner && getOverrideUrl(id, "banner")) {
            if (!("banner" in before)) before.banner = guild.banner;
            guild.banner = PLACEHOLDER_BANNER;
        }

        if (Object.keys(before).length) injected.set(guild, before);
    } catch {
        // frozen objects are left alone
    }

    allowBanner(guild);
}

// the banner area is only drawn for servers that have the BANNER feature,
// so for overridden guilds hasFeature("BANNER") is answered with yes
function allowBanner(guild: any): void {
    if (featurePatched.has(guild) || !getOverrideUrl(guild.id, "banner")) return;

    try {
        const original = guild.hasFeature;
        Object.defineProperty(guild, "hasFeature", {
            value: function (feature: any, ...rest: any[]) {
                if (feature === "BANNER" && getOverrideUrl(guild.id, "banner")) return true;
                return typeof original === "function" ? original.call(this, feature, ...rest) : false;
            },
            configurable: true,
            writable: true,
            enumerable: false,
        });
        featurePatched.add(guild);
    } catch {
        // frozen objects are left alone
    }
}

function guildIdOf(first: any): string | undefined {
    return typeof first === "string" ? first : first?.id;
}

// getGuildIconURL / getGuildBannerURL and friends: hand back the override as a string
function urlGetterWrapper(kind: Kind) {
    return (original: Function, self: any, args: any[]) => {
        const override = getOverrideUrl(guildIdOf(args[0]), kind);
        if (override) return override;

        // a placeholder whose override was removed must not turn into a broken image
        const placeholder = kind === "icon" ? PLACEHOLDER_ICON : PLACEHOLDER_BANNER;
        if (args[0]?.[kind] === placeholder) return undefined;

        return original.apply(self, args);
    };
}

// getGuildIconSource and friends: hand back an image source with the override as its uri
function sourceGetterWrapper(kind: Kind) {
    return (original: Function, self: any, args: any[]) => {
        const override = getOverrideUrl(guildIdOf(args[0]), kind);
        if (override) {
            let base: any;
            try { base = original.apply(self, args); } catch { /* the override alone is enough */ }
            return { ...(base && typeof base === "object" ? base : {}), uri: override };
        }

        const placeholder = kind === "icon" ? PLACEHOLDER_ICON : PLACEHOLDER_BANNER;
        if (args[0]?.[kind] === placeholder) return undefined;

        return original.apply(self, args);
    };
}

const URL_GETTERS: [string, Kind][] = [
    ["getGuildIconURL", "icon"],
    ["getGuildBannerURL", "banner"],
];

const SOURCE_GETTERS: [string, Kind][] = [
    ["getGuildIconSource", "icon"],
    ["getGuildBannerSource", "banner"],
];

function patchGetter(name: string, kind: Kind, source: boolean): boolean {
    const mod = findByProps(name);
    if (!mod) return false;
    return wrap(mod, name, source ? sourceGetterWrapper(kind) : urlGetterWrapper(kind));
}

// guild lookups: hands back the guild with placeholders on it
function guildWrapper(original: Function, self: any, args: any[]) {
    const guild = original.apply(self, args);
    addPlaceholders(guild);
    return guild;
}

function refreshGuild(guildStore: any, id: string): void {
    try {
        const guild = guildStore?.getGuild?.(id);
        if (guild) {
            FluxDispatcher.dispatch({ type: "GUILD_UPDATE", guild });
        }
    } catch {
        // the next time the server renders will show it anyway
    }
}

function applyPatches(): void {
    resetStatus();
    status(`loaded v${VERSION}`);

    initStorage();

    const GuildStore = findByStoreName("GuildStore");
    if (!GuildStore) {
        status("guild store not found, nothing patched");
        return;
    }

    // placeholders left behind by an earlier load that was not unloaded
    try {
        const all = GuildStore.getGuilds?.() ?? {};
        for (const guild of Object.values(all) as any[]) {
            if (guild?.icon === PLACEHOLDER_ICON) guild.icon = null;
            if (guild?.banner === PLACEHOLDER_BANNER) guild.banner = null;
        }
    } catch {
        // nothing to clean up
    }

    // icon and banner URL / source functions
    const urlOk = URL_GETTERS.filter(([name, kind]) => patchGetter(name, kind, false)).map(([name]) => name);
    status(`URL functions patched: ${urlOk.length ? urlOk.join(", ") : "none"}`);

    const sourceOk = SOURCE_GETTERS.filter(([name, kind]) => patchGetter(name, kind, true)).map(([name]) => name);
    status(`source functions patched: ${sourceOk.length ? sourceOk.join(", ") : "none"}`);

    if (!urlOk.length && !sourceOk.length) {
        status("icon/banner functions NOT FOUND, relying on the guild store only");
    }

    // guild store, so servers without an icon or banner still get one drawn
    const storeOk = wrap(GuildStore, "getGuild", guildWrapper);
    status(storeOk ? "guild store: patched" : "guild store: NOT FOUND");

    // guilds already loaded in memory
    try {
        const all = GuildStore.getGuilds?.() ?? {};
        for (const guild of Object.values(all) as any[]) addPlaceholders(guild);
    } catch {
        // they are picked up on the next getGuild call
    }

    // refresh ui for every overridden server
    for (const entry of (storage.overrides ?? []) as ServerOverride[]) {
        if (entry?.id) refreshGuild(GuildStore, entry.id.trim());
    }
}

export function onLoad(): void {
    // an exception here would stop the plugin silently, so keep it visible
    try {
        applyPatches();
    } catch (e) {
        status(`crashed on load: ${(e as Error)?.message}`);
    }
}

export function onUnload(): void {
    // restore patches
    patches.forEach(unpatch => unpatch());
    patches = [];

    injected.forEach((before, guild) => {
        try {
            if ("icon" in before) guild.icon = before.icon;
            if ("banner" in before) guild.banner = before.banner;
        } catch { /* nothing to restore */ }
    });
    injected.clear();

    featurePatched.forEach(guild => {
        try { delete guild.hasFeature; } catch { /* nothing to restore */ }
    });
    featurePatched.clear();
}
