import { findByProps, findByPropsAll, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";

import { resetStatus, stats, status } from "./status";

const VERSION = "1.1.0";

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

// builds the wrapper for one icon / banner function.
// `source` functions return an image source ({ uri }), the others return a URL string.
// `onGuild` functions are methods on the guild object itself, so the id comes from `this`;
// the rest are helper functions that take the guild (or its id) as the first argument
function makeWrapper(kind: Kind, source: boolean, onGuild: boolean) {
    const placeholder = kind === "icon" ? PLACEHOLDER_ICON : PLACEHOLDER_BANNER;

    return (original: Function, self: any, args: any[]) => {
        const target = onGuild ? self : args[0];
        const id = guildIdOf(target);
        stats.calls++;

        const override = getOverrideUrl(id, kind);
        if (override) {
            stats[kind]++;
            if (!source) return override;

            let base: any;
            try { base = original.apply(self, args); } catch { /* the override alone is enough */ }
            return { ...(base && typeof base === "object" ? base : {}), uri: override };
        }

        // a placeholder whose override was removed must not turn into a broken image
        if (target && typeof target === "object" && target[kind] === placeholder) return undefined;

        return original.apply(self, args);
    };
}

// [function name, what it is for, whether it returns an image source instead of a URL]
const GETTERS: [string, Kind, boolean][] = [
    ["getGuildIconURL", "icon", false],
    ["getGuildIconSource", "icon", true],
    ["getGuildBannerURL", "banner", false],
    ["getGuildBannerSource", "banner", true],
];

// the same things as methods on the guild object
const GUILD_METHODS: [string, Kind, boolean][] = [
    ["getIconURL", "icon", false],
    ["getIconSource", "icon", true],
    ["getBannerURL", "banner", false],
    ["getBannerSource", "banner", true],
];

// every module that exposes `name`, since the same function can be reachable through several
function modulesWith(name: string): any[] {
    let found: any[] = [];
    try {
        if (typeof findByPropsAll === "function") found = findByPropsAll(name) ?? [];
    } catch { /* fall back to the single lookup */ }

    if (!found.length) {
        const one = findByProps(name);
        if (one) found = [one];
    }
    return Array.from(new Set(found.filter(Boolean)));
}

// patches the helper functions in the icon utils; returns the names that were found
function patchGetters(): string[] {
    const names: string[] = [];
    for (const [name, kind, source] of GETTERS) {
        const patched = modulesWith(name).filter(mod => wrap(mod, name, makeWrapper(kind, source, false)));
        if (patched.length) names.push(patched.length > 1 ? `${name} x${patched.length}` : name);
    }
    return names;
}

// patches the methods on the guild class, using a guild that is already loaded
function patchGuildClass(guild: any): string[] {
    const proto = guild && Object.getPrototypeOf(guild);
    if (!proto || proto === Object.prototype) return [];

    const names: string[] = [];
    for (const [name, kind, source] of GUILD_METHODS) {
        if (wrap(proto, name, makeWrapper(kind, source, true))) names.push(name);
    }
    return names;
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

    // icon and banner helper functions (the same place the avatar plugin patches)
    const helpers = patchGetters();
    status(`icon/banner functions patched: ${helpers.length ? helpers.join(", ") : "NONE FOUND"}`);

    // the same functions as methods on the guild object
    let guilds: any[] = [];
    try {
        guilds = Object.values(GuildStore.getGuilds?.() ?? {});
    } catch {
        // the guild list is only needed for the checks below
    }

    const methods = patchGuildClass(guilds[0]);
    status(`guild object methods patched: ${methods.length ? methods.join(", ") : "none found"}`);

    // guild store, so servers without an icon or banner still get one drawn
    const storeOk = wrap(GuildStore, "getGuild", guildWrapper);
    status(storeOk ? "guild store: patched" : "guild store: NOT FOUND");

    // guilds already loaded in memory
    for (const guild of guilds) addPlaceholders(guild);

    // does each configured server id match one of the servers you are in?
    for (const entry of (storage.overrides ?? []) as ServerOverride[]) {
        const id = entry?.id?.trim();
        if (!id) continue;
        const guild = guilds.find(g => g?.id === id);
        status(guild ? `server ${id}: found (${guild.name})` : `server ${id}: NOT in your servers, check the ID`);
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
