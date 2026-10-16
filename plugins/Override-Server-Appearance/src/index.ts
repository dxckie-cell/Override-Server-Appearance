import { findByProps, findByPropsAll, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";

export { default as settings } from "./settings";

type Kind = "icon" | "banner";

// placeholder hashes, only used so the UI draws an icon / banner area for servers
// that have none of their own; the real image comes from the override
const PLACEHOLDER: Record<Kind, string> = {
    icon: "override-server-icon",
    banner: "override-server-banner",
};

let patches: (() => void)[] = [];

// guilds we put a placeholder on, with what each field was before
const injected = new Map<any, Partial<Record<Kind, any>>>();

// guilds whose hasFeature we replaced so the banner area is allowed to draw
const featurePatched = new Set<any>();

// looks up the override at call time so edits in settings apply without reloading
function getOverrideUrl(guildId: string | undefined, kind: Kind): string | undefined {
    if (!guildId) return undefined;
    for (const entry of storage.overrides ?? []) {
        if (entry?.id?.trim() === guildId) {
            const url = entry[kind]?.trim();
            if (url) return url;
        }
    }
    return undefined;
}

// wraps obj[key] and registers a function that puts the original back on unload
function wrap(obj: any, key: string, wrapper: (original: Function, self: any, args: any[]) => any): void {
    try {
        const original = obj?.[key];
        if (typeof original !== "function") return;

        obj[key] = function (...args: any[]) {
            return wrapper(original, this, args);
        };
        patches.push(() => { obj[key] = original; });
    } catch {
        // frozen objects are left alone
    }
}

// the banner area is only drawn for servers that have the BANNER feature,
// so for overridden guilds hasFeature("BANNER") is answered with yes
function allowBanner(guild: any): void {
    if (featurePatched.has(guild) || !getOverrideUrl(guild.id, "banner")) return;

    const original = guild.hasFeature;
    Object.defineProperty(guild, "hasFeature", {
        value(feature: any, ...rest: any[]) {
            if (feature === "BANNER" && getOverrideUrl(guild.id, "banner")) return true;
            return typeof original === "function" ? original.call(this, feature, ...rest) : false;
        },
        configurable: true,
        writable: true,
    });
    featurePatched.add(guild);
}

// gives an overridden guild an icon / banner so the UI draws the area for it,
// changed in place (and restored on unload) so any methods on the object keep working
function decorate(guild: any): void {
    if (!guild?.id) return;

    try {
        const before = injected.get(guild) ?? {};
        for (const kind of ["icon", "banner"] as Kind[]) {
            if (!guild[kind] && getOverrideUrl(guild.id, kind)) {
                if (!(kind in before)) before[kind] = guild[kind];
                guild[kind] = PLACEHOLDER[kind];
            }
        }
        if (Object.keys(before).length) injected.set(guild, before);

        allowBanner(guild);
    } catch {
        // frozen objects are left alone
    }
}

// wrapper for one icon / banner function. `source` functions return an image source
// ({ uri }), the others a URL. `onGuild` functions are methods of the guild itself,
// the rest take the guild (or its id) as the first argument
function makeWrapper(kind: Kind, source: boolean, onGuild: boolean) {
    return (original: Function, self: any, args: any[]) => {
        const target = onGuild ? self : args[0];
        const override = getOverrideUrl(typeof target === "string" ? target : target?.id, kind);

        if (override) {
            if (!source) return override;

            let base: any;
            try { base = original.apply(self, args); } catch { /* the override alone is enough */ }
            return { ...(base && typeof base === "object" ? base : {}), uri: override };
        }

        // a placeholder whose override was removed must not turn into a broken image
        if (target?.[kind] === PLACEHOLDER[kind]) return undefined;

        return original.apply(self, args);
    };
}

// [name, what it is for, whether it returns an image source instead of a URL]
const FUNCTIONS: [string, Kind, boolean][] = [
    ["getGuildIconURL", "icon", false],
    ["getGuildIconSource", "icon", true],
    ["getGuildBannerURL", "banner", false],
    ["getGuildBannerSource", "banner", true],
];

// the same things as methods on the guild object
const METHODS: [string, Kind, boolean][] = [
    ["getIconURL", "icon", false],
    ["getIconSource", "icon", true],
    ["getBannerURL", "banner", false],
    ["getBannerSource", "banner", true],
];

// every module that exposes `name`, since the same function can be reachable through several
function modulesWith(name: string): any[] {
    let found: any[] = [];
    try {
        found = findByPropsAll(name) ?? [];
    } catch { /* fall back to the single lookup */ }

    if (!found.length) found = [findByProps(name)];
    return Array.from(new Set(found.filter(Boolean)));
}

export function onLoad(): void {
    if (!Array.isArray(storage.overrides)) storage.overrides = [];

    const GuildStore = findByStoreName("GuildStore");
    if (!GuildStore) return;

    for (const [name, kind, source] of FUNCTIONS) {
        for (const mod of modulesWith(name)) wrap(mod, name, makeWrapper(kind, source, false));
    }

    const guilds: any[] = Object.values(GuildStore.getGuilds?.() ?? {});

    const proto = guilds[0] && Object.getPrototypeOf(guilds[0]);
    if (proto && proto !== Object.prototype) {
        for (const [name, kind, source] of METHODS) wrap(proto, name, makeWrapper(kind, source, true));
    }

    // servers without an icon or banner still get one drawn
    wrap(GuildStore, "getGuild", (original, self, args) => {
        const guild = original.apply(self, args);
        decorate(guild);
        return guild;
    });
    guilds.forEach(decorate);

    // refresh ui for every overridden server
    for (const entry of storage.overrides) {
        try {
            const guild = entry?.id && GuildStore.getGuild(entry.id.trim());
            if (guild) FluxDispatcher.dispatch({ type: "GUILD_UPDATE", guild });
        } catch {
            // the next time the server renders will show it anyway
        }
    }
}

export function onUnload(): void {
    patches.forEach(unpatch => unpatch());
    patches = [];

    injected.forEach((before, guild) => {
        try { Object.assign(guild, before); } catch { /* nothing to restore */ }
    });
    injected.clear();

    featurePatched.forEach(guild => {
        try { delete guild.hasFeature; } catch { /* nothing to restore */ }
    });
    featurePatched.clear();
}
