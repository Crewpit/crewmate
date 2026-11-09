(function () {
    "use strict";

    var el = App.el;

    // Live mode installs into /usr/share/cockpit as root. Dry Run installs into
    // DRY_ROOT and only logs package-manager and removal commands.
    // SETTINGS_PATH holds the settings and the live install record; dry runs
    // keep their record inside the fake root.
    var DRY = false;            // set from settings.dryRun at startup
    var DRY_ROOT = "/tmp/crewmate-dryroot";
    var SETTINGS_PATH = "/etc/cockpit/crewmate.json";
    var DRY_RECORD_PATH = DRY_ROOT + "/etc/cockpit/crewmate.json";
    var CM_SCHEMA = 1;
    var LOG_LIMIT = 2000;
    var METHODS = ["auto", "git", "curl", "wget", "openssl", "devtcp"];
    var MAX_PROBES = 60;
    var LOGOUT_SECONDS = 30;

    var DEFAULT_SETTINGS = {
        registryUrl: "https://raw.githubusercontent.com/Crewpit/.github/main/registry.json",
        method: "auto",
        dryRun: false,
    };

    // Missing dependencies are installed, outdated ones upgraded, always to the
    // latest the distro offers. "refresh" updates the package lists first.
    var PM = {
        "apt-get": {
            refresh: ["apt-get", "update"],
            install: ["apt-get", "install", "-y"],
            upgrade: ["apt-get", "install", "-y", "--only-upgrade"],
        },
        dnf: { install: ["dnf", "-y", "install"], upgrade: ["dnf", "-y", "upgrade"] },
        yum: { install: ["yum", "-y", "install"], upgrade: ["yum", "-y", "update"] },
        zypper: {
            refresh: ["zypper", "--non-interactive", "refresh"],
            install: ["zypper", "--non-interactive", "install"],
            upgrade: ["zypper", "--non-interactive", "update"],
        },
        apk: { refresh: ["apk", "update"], install: ["apk", "add"], upgrade: ["apk", "add", "--upgrade"] },
        pacman: { install: ["pacman", "-S", "--noconfirm", "--needed"], upgrade: ["pacman", "-S", "--noconfirm"] },
    };
    var PKG_RE = /^[A-Za-z0-9][A-Za-z0-9.+_:-]*$/;

    var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

    var state = {
        env: null,           // { tools, cockpit, pm }
        config: null,        // { settings, installed } for the current mode
        liveInstalled: {},   // live record, kept to rewrite SETTINGS_PATH
        registry: null,
        registryPkgs: null,  // registryPackages() cache
        registrySource: "",
        managed: [],         // [{ name, preflight, version }] in <root>/usr/share/cockpit
        system: [],          // [{ name, path, version }] Crewpit packages elsewhere
        busy: false,         // one install/uninstall at a time
        loaded: false,
        health: null,        // result of crewmate.sh check
        etcReady: false,     // /etc/cockpit exists (created before the first save)
    };

    // First version-looking token: "git version 2.56.0" -> "2.56.0".
    function parseVersion(text) {
        var m = /\d+(?:\.\d+)*/.exec(text || "");
        return m ? m[0] : null;
    }

    // <0 if a is older than b, 0 if equal, >0 if newer. Missing parts count as 0
    // ("2.0" == "2.0.0"); a pre-release suffix sorts before its release.
    function compareVersions(a, b) {
        function split(v) {
            var s = String(v).trim().replace(/^v/i, "");
            var dash = s.indexOf("-");
            return {
                nums: (dash === -1 ? s : s.slice(0, dash)).split(".").map(function (p) { return parseInt(p, 10) || 0 }),
                pre: dash === -1 ? "" : s.slice(dash + 1),
            };
        }
        var x = split(a);
        var y = split(b);
        for (var i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
            var d = (x.nums[i] || 0) - (y.nums[i] || 0);
            if (d)
                return d;
        }
        if (x.pre === y.pre)
            return 0;
        if (!x.pre)
            return 1;
        if (!y.pre)
            return -1;
        return x.pre.localeCompare(y.pre, undefined, { numeric: true });
    }

    var Log = (function () {
        var pre = document.getElementById("activity-log");
        var entries = [];
        var listeners = [];

        function render(entry) {
            return el("div", { class: "app-log__line app-log__line--" + entry.kind }, [
                el("span", { class: "app-log__time", text: entry.time + " " }),
                el("span", { class: "app-log__stage", text: "[" + entry.stage + "] " }),
                el("span", { text: entry.msg }),
            ]);
        }

        function add(stage, msg, kind) {
            var entry = { time: new Date().toLocaleTimeString(), stage: stage, msg: msg, kind: kind || "info" };
            entries.push(entry);
            pre.appendChild(render(entry));
            if (entries.length > LOG_LIMIT) {
                entries.splice(0, entries.length - LOG_LIMIT);
                while (pre.childElementCount > LOG_LIMIT)
                    pre.removeChild(pre.firstChild);
            }
            pre.scrollTop = pre.scrollHeight;
            listeners.forEach(function (fn) { fn(entry) });
        }

        return {
            add: add,
            render: render,
            subscribe: function (fn) {
                listeners.push(fn);
                return function () { listeners = listeners.filter(function (f) { return f !== fn }) };
            },
            text: function () {
                return entries.map(function (e) { return e.time + " [" + e.stage + "] " + e.msg }).join("\n");
            },
            clear: function () {
                entries = [];
                pre.replaceChildren();
            },
        };
    }());

    // helper(args) -> Promise<{ kv }>: runs crewmate.sh, streams its output into
    // the log and collects "@kv key value" lines into result.kv[key] = [values].
    // The script is found at runtime because the package can live in any of
    // Cockpit's package dirs; the package name comes from our URL.
    var PKG = (function () {
        var parts = location.pathname.split("/");
        var name = parts[parts.length - 2] || "crewmate";
        return NAME_RE.test(name) ? name : "crewmate";
    }());

    var LAUNCH =
        'for d in "/usr/share/cockpit/$1" "/usr/local/share/cockpit/$1" "$HOME/.local/share/cockpit/$1"; do ' +
        'if [ -f "$d/crewmate.sh" ]; then shift; exec /bin/sh "$d/crewmate.sh" "$@"; fi; done; ' +
        'echo "@log error crewmate.sh not found in any Cockpit package dir named $1"; exit 127';

    // These run as root in live mode. env, probe and list stay unprivileged:
    // probes are commands from the package author and must never run as root.
    var PRIVILEGED = ["init", "get", "fetch", "mkstage", "unpack", "install", "uninstall", "cleanup", "cleanup-all"];

    function helper(args) {
        var settings = (state.config && state.config.settings) || DEFAULT_SETTINGS;
        var asRoot = !DRY && PRIVILEGED.indexOf(args[0]) !== -1;
        var result = { kv: {} };
        var buffer = "";
        var lastError = null;

        Log.add("run", (asRoot ? "[root] " : "") + "crewmate.sh " + args.map(shellQuote).join(" "), "cmd");

        function onLine(line) {
            var m = /^@log (\S+) (.*)$/.exec(line);
            if (m) {
                if (m[1] === "error")
                    lastError = m[2];
                Log.add(m[1], m[2], m[1] === "error" ? "error" : "info");
                return;
            }
            m = /^@kv (\S+) ?(.*)$/.exec(line);
            if (m) {
                (result.kv[m[1]] = result.kv[m[1]] || []).push(m[2]);
                Log.add("result", m[1] + " = " + (m[2] || "(empty)"), "raw");
                return;
            }
            if (line.trim())
                Log.add("output", line, "raw");
        }

        var proc = cockpit.spawn(["/bin/sh", "-c", LAUNCH, "crewmate", PKG].concat(args), {
            err: "out",
            superuser: asRoot ? "require" : undefined,
            environ: [
                "CREWMATE_ROOT=" + DRY_ROOT,
                "CREWMATE_DRY=" + (DRY ? "1" : "0"),
                "CREWMATE_METHOD=" + settings.method,
            ],
        });
        proc.stream(function (chunk) {
            buffer += chunk;
            var lines = buffer.split("\n");
            buffer = lines.pop();
            lines.forEach(onLine);
        });

        return settle(proc).then(function () {
            if (buffer)
                onLine(buffer);
            return result;
        }, function (ex) {
            if (buffer)
                onLine(buffer);
            console.error("crewmate.sh failed:", args, ex);
            var err = new Error(lastError || errorText(ex) || "crewmate.sh failed");
            err.result = result;
            throw err;
        });
    }

    // Cockpit's own promises don't catch a throwing .then() callback, so the
    // shell shows "Oops!". Adopting them into a native Promise turns the throw
    // into a rejection. Wrap every cockpit.spawn / cockpit.file promise.
    function settle(cockpitPromise) {
        return Promise.resolve(cockpitPromise);
    }

    function first(result, key) {
        var v = result.kv[key];
        return v && v.length ? v[0] : null;
    }

    // Log display only; arguments are always passed as argv.
    function shellQuote(s) {
        s = String(s);
        return /^[A-Za-z0-9_./:@=+-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
    }

    function errorText(ex) {
        if (ex && ex.problem === "access-denied")
            return "Administrative access is required. Turn it on in Cockpit's top bar and try again.";
        return (ex && (ex.message || ex.problem)) || String(ex);
    }

    // Stage dirs are root-owned in live mode.
    function stageFile(path, opts) {
        return cockpit.file(path, Object.assign({}, opts || {}, DRY ? {} : { superuser: "require" }));
    }

    function root() {
        return DRY ? DRY_ROOT : "";
    }

    function sanitizeSettings(raw) {
        var s = Object.assign({}, DEFAULT_SETTINGS, raw && typeof raw === "object" ? raw : {});
        if (typeof s.registryUrl !== "string" || !/^https?:\/\//.test(s.registryUrl))
            s.registryUrl = DEFAULT_SETTINGS.registryUrl;
        if (METHODS.indexOf(s.method) === -1)
            s.method = DEFAULT_SETTINGS.method;
        s.dryRun = s.dryRun === true;
        return s;
    }

    function loadConfig() {
        Log.add("config", "reading " + SETTINGS_PATH);
        return settle(cockpit.file(SETTINGS_PATH, { syntax: JSON, superuser: "try" }).read())
                .catch(function (ex) {
                    Log.add("config", SETTINGS_PATH + " is unreadable (" + errorText(ex) + "); using defaults", "warn");
                    App.alerts.inline("installed-alert", "warning", "Settings file ignored",
                        SETTINGS_PATH + " couldn't be read, so defaults are in use. Saving a setting or installing a package overwrites it.");
                    return null;
                })
                .then(function (data) {
                    if (!data || typeof data !== "object") {
                        Log.add("config", "no settings file yet, using defaults (written on first change)");
                        data = {};
                    } else if (data.cmSchema > CM_SCHEMA) {
                        throw new Error(SETTINGS_PATH + " was written by a newer Crewmate (cmSchema " + data.cmSchema + ")");
                    }
                    var settings = sanitizeSettings(data.settings);
                    state.liveInstalled = data.installed && typeof data.installed === "object" ? data.installed : {};
                    DRY = !!settings.dryRun;
                    Log.add("config", DRY ? "mode: DRY RUN (fake root " + DRY_ROOT + ")" : "mode: live (installs go to /usr/share/cockpit)");
                    if (!DRY) {
                        state.config = { settings: settings, installed: state.liveInstalled };
                        return;
                    }
                    return helper(["init"])
                            .then(function () {
                                Log.add("config", "reading dry-run record " + DRY_RECORD_PATH);
                                return settle(cockpit.file(DRY_RECORD_PATH, { syntax: JSON }).read());
                            })
                            .then(function (dry) {
                                state.config = { settings: settings, installed: (dry && dry.installed) || {} };
                            });
                })
                .then(function () {
                    Log.add("config", Object.keys(state.config.installed).length + " package(s) in the install record");
                });
    }

    function saveSettingsFile() {
        Log.add("config", "writing " + SETTINGS_PATH + " (as root)");
        // /etc/cockpit may not exist on a fresh host.
        var ready = state.etcReady ? Promise.resolve() :
            settle(cockpit.spawn(["mkdir", "-p", "/etc/cockpit"], { superuser: "require", err: "message" }))
                    .then(function () { state.etcReady = true });
        return ready.then(function () {
            return settle(cockpit.file(SETTINGS_PATH, { syntax: JSON, superuser: "require" }).replace({
                cmSchema: CM_SCHEMA,
                settings: state.config.settings,
                installed: state.liveInstalled,
            }));
        });
    }

    function saveRecord() {
        if (!DRY) {
            state.liveInstalled = state.config.installed;
            return saveSettingsFile();
        }
        Log.add("config", "writing dry-run record " + DRY_RECORD_PATH);
        return settle(cockpit.file(DRY_RECORD_PATH, { syntax: JSON }).replace({
            cmSchema: CM_SCHEMA,
            installed: state.config.installed,
        }));
    }

    function detectEnv() {
        return helper(["env"]).then(function (r) {
            var cockpitVersion = first(r, "cockpit");
            if (!cockpitVersion && cockpit.info && cockpit.info.version) {
                cockpitVersion = String(cockpit.info.version);
                Log.add("env", "cockpit version from cockpit.info: " + cockpitVersion);
            }
            state.env = {
                tools: r.kv.tool || [],
                cockpit: cockpitVersion || null,
                pm: first(r, "pm"),
            };
            renderHostInfo();
        });
    }

    function healthCheck() {
        return helper(["check"]).then(function (r) {
            state.health = {
                changed: r.kv.changed || [],
                unreadable: Number(first(r, "unreadable")) || 0,
                unreadableSample: first(r, "unreadable_sample") || "",
                settings: first(r, "settings") === "yes",
                others: Number(first(r, "others")) || 0,
            };
        }).catch(function (ex) {
            Log.add("check", "health check failed: " + errorText(ex), "warn");
        });
    }

    // Does Cockpit serve this package file? Same-origin request for a file of
    // this package only; the body is dropped as soon as the status is known.
    // An unknown result (network error, timeout) counts as served.
    function isServed(path) {
        var ctl = new AbortController();
        var timer = window.setTimeout(function () { ctl.abort() }, 5000);
        return window.fetch(new URL(encodeURI(path), window.location.href).href, { cache: "no-store", signal: ctl.signal })
                .then(function (r) { return r.ok }, function () { return true })
                .then(function (ok) {
                    window.clearTimeout(timer);
                    ctl.abort();
                    return ok;
                });
    }

    // The session's file list is fixed at login, so a file added since then
    // answers 404. Only files changed after login are probed; edits to files
    // the session already knows are served fine.
    function sessionIsStale() {
        var changed = state.health ? state.health.changed : [];
        if (!changed.length)
            return Promise.resolve(false);
        if (changed.length > MAX_PROBES) {
            Log.add("check", changed.length + "+ files changed since login", "warn");
            return Promise.resolve(true);
        }
        var stale = false;
        return changed.reduce(function (chain, path) {
            return chain.then(function () {
                if (stale)
                    return;
                return isServed(path).then(function (ok) {
                    if (!ok) {
                        stale = true;
                        Log.add("check", "not served by Cockpit yet: " + path, "warn");
                    }
                });
            });
        }, Promise.resolve()).then(function () { return stale });
    }

    function adminAllowed() {
        return new Promise(function (resolve) {
            if (!cockpit.permission)
                return resolve(null);
            var perm = cockpit.permission({ admin: true });
            var timer = window.setTimeout(function () { finish(null) }, 1500);
            function finish(value) {
                window.clearTimeout(timer);
                perm.removeEventListener("changed", check);
                if (perm.close)
                    perm.close();
                resolve(value);
            }
            function check() {
                if (perm.allowed === true || perm.allowed === false)
                    finish(perm.allowed);
            }
            perm.addEventListener("changed", check);
            check();
        });
    }

    // Clicks the shell's own "Log out" menu item so the shell logs out cleanly.
    // cockpit.logout() from inside this frame leaves the shell on a "disconnected"
    // error page. Falls back to it when the shell isn't reachable.
    function logOut() {
        function fallback() {
            if (typeof cockpit.logout === "function")
                cockpit.logout(true);
            else
                App.alerts.toast("warning", "Log out of Cockpit and back in", { description: "This Cockpit version can't log out from a page." });
        }
        var shell = null;
        try {
            shell = window.top !== window ? window.top.document : null;
        } catch (ex) {
            shell = null;
        }
        if (!shell)
            return fallback();

        var tries = 0;
        (function press() {
            var item = shell.getElementById("logout");
            if (item) {
                item.click();
                return;
            }
            // The menu only renders its items once opened.
            var toggle = shell.getElementById("toggle-menu");
            if (toggle && tries === 0)
                toggle.click();
            if (++tries > 20)
                return fallback();
            window.setTimeout(press, 50);
        }());
    }

    function logoutPrompt() {
        var seconds = LOGOUT_SECONDS;
        var timer = null;
        var countdown = el("span", { class: "app-modal__countdown" });
        var nowBtn = el("button", { class: "pf-v6-c-button pf-m-primary", type: "button", text: "Log Out Now" });
        var laterBtn = el("button", { class: "pf-v6-c-button pf-m-link", type: "button", text: "Not Now" });

        function paint() { countdown.textContent = "Logging out in " + seconds + " sec" }
        var modal = App.modals.open({
            title: "Log Out to Finish Setup",
            body: [
                "Crewmate's files changed after you logged in, and Cockpit may not serve the new ones until you log in again.",
                "You'll be logged out automatically to avoid problems. Anything unsaved in other Cockpit pages will be lost.",
            ],
            footer: [countdown, nowBtn, laterBtn],
            closable: false,
            onClose: function () { window.clearInterval(timer) },
        });
        nowBtn.addEventListener("click", function () {
            modal.close();
            logOut();
        });
        laterBtn.addEventListener("click", modal.close);
        laterBtn.focus();
        paint();
        Log.add("check", "session is out of date, logging out in " + seconds + "s unless dismissed", "warn");
        timer = window.setInterval(function () {
            seconds -= 1;
            if (seconds > 0)
                return paint();
            modal.close();
            logOut();
        }, 1000);
    }

    function showHealth(stale, admin) {
        var h = state.health;
        var notes = [];
        var variant = "info";
        if (stale) {
            notes.push("Crewmate's files changed after you logged in, so some may not load. Log out and back in if something is missing.");
            variant = "warning";
        }
        if (h && h.unreadable) {
            notes.push(h.unreadable + " file(s) in Crewmate's folder can't be read by other users" +
                       (h.unreadableSample ? " (for example " + h.unreadableSample + ")" : "") +
                       ". Cockpit serves files as the logged-in user, so they may fail to load. Run chmod -R a+rX on the folder.");
            variant = "warning";
        }
        var firstRun = h && !h.settings && !h.others && !Object.keys(state.liveInstalled).length;
        if (firstRun) {
            notes.push("First run: settings and install history are saved once you change a setting or install something.");
            if (admin === false)
                notes.push("Administrative access is off. Turn it on in Cockpit's top bar before installing or changing settings.");
        }
        if (notes.length)
            App.alerts.inline("health-banner", variant, variant === "warning" ? "Check Crewmate's Setup" : "Welcome to Crewmate", notes);
        else
            App.alerts.inline("health-banner");
    }

    function runHealthChecks() {
        return sessionIsStale().then(function (stale) {
            if (stale)
                logoutPrompt();
            return adminAllowed().then(function (admin) { showHealth(stale, admin) });
        }).catch(function (ex) {
            Log.add("check", "couldn't evaluate the health check: " + errorText(ex), "warn");
        });
    }

    function renderHostInfo() {
        var env = state.env || { tools: [] };
        var rows = [
            ["Mode", DRY ? "Dry Run: nothing outside /tmp is touched" : "Live: packages are installed into /usr/share/cockpit"],
            ["Install location", root() + "/usr/share/cockpit/<package>"],
            ["Rollback copies", root() + "/var/lib/crewmate/backup/<package>"],
            ["Settings", SETTINGS_PATH],
            ["Install record", DRY ? DRY_RECORD_PATH : SETTINGS_PATH],
            ["Staging folders", "/tmp/crewmate.XXXXXX/<package>"],
            ["Cockpit version", env.cockpit || "unknown"],
            ["Transfer tools", env.tools.join(", ") || "none found"],
            ["Package manager", env.pm || "none found"],
        ];
        document.getElementById("host-info").replaceChildren.apply(
            document.getElementById("host-info"),
            rows.map(function (r) {
                return el("div", { class: "pf-v6-c-description-list__group" }, [
                    el("dt", { class: "pf-v6-c-description-list__term", text: r[0] }),
                    el("dd", { class: "pf-v6-c-description-list__description", text: r[1] }),
                ]);
            })
        );
    }

    function nameFromHref(href) {
        var name = String(href).replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop();
        name = name.replace(/\.(zip|tar\.gz|tgz)$/, "");
        return NAME_RE.test(name) ? name : null;
    }

    function normalizeHref(href) {
        return String(href || "").toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
    }

    function validateRegistry(data) {
        if (!data || typeof data !== "object" || !Array.isArray(data.apps))
            throw new Error("not a Crewmate registry (no \"apps\" list)");
        if (typeof data.cmSchema !== "number")
            throw new Error("registry has no cmSchema");
        if (data.cmSchema > CM_SCHEMA)
            throw new Error("registry uses cmSchema " + data.cmSchema + "; this Crewmate understands up to " + CM_SCHEMA + ". Update Crewmate.");
        var apps = data.apps.filter(function (a, i) {
            var ok = a && typeof a.name === "string" && typeof a.version === "string" &&
                     typeof a.href === "string" && /^https?:\/\//.test(a.href) && nameFromHref(a.href);
            if (!ok)
                Log.add("registry", "skipping invalid entry #" + i + ": " + JSON.stringify(a), "warn");
            return ok;
        });
        return { cmSchema: data.cmSchema, updated: data.updated || "", apps: apps };
    }

    function fetchRegistry() {
        var url = state.config.settings.registryUrl;
        var stage = null;
        App.alerts.inline("gallery-alert");

        Log.add("registry", "refreshing from " + url);
        return helper(["get", url])
                .then(function (r) {
                    stage = first(r, "stage");
                    return settle(stageFile(first(r, "file"), { syntax: JSON }).read());
                })
                .then(function (data) {
                    state.registry = validateRegistry(data);
                    state.registryPkgs = null;
                    state.registrySource = url;
                    Log.add("registry", state.registry.apps.length + " app(s) listed (updated " + (state.registry.updated || "?") + ")");
                })
                .catch(function (ex) {
                    state.registry = null;
                    state.registryPkgs = null;
                    state.registrySource = url + " (fetch failed)";
                    Log.add("registry", "registry unavailable: " + errorText(ex), "error");
                    App.alerts.inline("gallery-alert", "danger", "Couldn't load the registry", [url, errorText(ex)]);
                })
                .then(function () {
                    if (stage)
                        return helper(["cleanup", stage]).catch(function () {});
                })
                .then(function () {
                    document.getElementById("gallery-updated").textContent = "Refreshed " + new Date().toLocaleTimeString();
                    renderGallery();
                    renderInstalled();
                });
    }

    // Registry entries grouped per package (same href), cached until the next
    // fetch. -> [{ name, latest, versions (newest first) }]
    function registryPackages() {
        if (!state.registry)
            return [];
        if (state.registryPkgs)
            return state.registryPkgs;
        var groups = {};
        var order = [];
        state.registry.apps.forEach(function (a) {
            var key = normalizeHref(a.href);
            if (!groups[key]) {
                groups[key] = { name: nameFromHref(a.href), entries: [] };
                order.push(key);
            }
            groups[key].entries.push(a);
        });
        state.registryPkgs = order.map(function (key) {
            var g = groups[key];
            g.entries.sort(function (x, y) { return compareVersions(y.version, x.version) });
            return { name: g.name, latest: g.entries[0], versions: g.entries.map(function (e) { return e.version }) };
        });
        return state.registryPkgs;
    }

    function registryPackageFor(name, href) {
        var h = normalizeHref(href);
        return registryPackages().find(function (p) {
            return (h && normalizeHref(p.latest.href) === h) || p.name === name;
        }) || null;
    }

    // Placeholder shown until startup has data, so a slow host doesn't look frozen.
    var SPINNER = '<svg class="pf-v6-c-spinner pf-m-lg" role="progressbar" aria-label="Loading" viewBox="0 0 100 100">' +
                  '<circle class="pf-v6-c-spinner__path" cx="50" cy="50" r="45" fill="none" /></svg>';

    function pendingNode(text) {
        var node = el("div", { class: "app-pending", "aria-live": "polite" }, [
            el("span", { class: "app-pending__spinner" }),
            el("div", {}, [
                el("div", { class: "app-strong", text: "Pending" }),
                el("div", { class: "app-muted", text: text }),
            ]),
        ]);
        node.firstChild.insertAdjacentHTML("beforeend", SPINNER);
        return node;
    }

    function setPending(text) {
        if (state.loaded)
            return;
        document.getElementById("installed-table").replaceChildren(pendingNode(text));
        document.getElementById("gallery-list").replaceChildren(pendingNode(text));
        ["installed-refresh", "gallery-refresh"].forEach(function (id) {
            document.getElementById(id).disabled = true;
        });
    }

    function setLoaded() {
        state.loaded = true;
        ["installed-refresh", "gallery-refresh"].forEach(function (id) {
            document.getElementById(id).disabled = false;
        });
        renderInstalled();
        renderGallery();
    }

    var installedTable = null;

    function refreshInventory() {
        return helper(["list"]).then(function (r) {
            state.managed = (r.kv.managed || []).map(function (line) {
                var parts = line.split(" ");
                return { name: parts[0], preflight: parts[1] === "1", version: parts[2] || "" };
            });
            state.system = (r.kv.system || []).map(function (line) {
                var parts = line.split(" ");
                return { name: parts[0].replace(/\/+$/, "").split("/").pop(), path: parts[0], version: parts[1] || "" };
            });
            document.getElementById("installed-updated").textContent = "Checked " + new Date().toLocaleTimeString();
            renderInstalled();
        }).catch(function (ex) {
            App.alerts.inline("installed-alert", "danger", "Couldn't list packages", errorText(ex));
        });
    }

    function allInstalled() {
        return state.config.installed;
    }

    function label(text, color) {
        return el("span", { class: "pf-v6-c-label pf-m-compact" + (color ? " pf-m-" + color : "") }, [
            el("span", { class: "pf-v6-c-label__content" }, [el("span", { class: "pf-v6-c-label__text", text: text })]),
        ]);
    }

    function button(text, variant, onClick) {
        var b = el("button", { class: "pf-v6-c-button pf-m-" + variant + " pf-m-small", type: "button", text: text });
        b.addEventListener("click", onClick);
        return b;
    }

    // { kind: "upgrade" | "current" | "ahead" | "unlisted" | "custom", pkg, newer }
    function registryStatus(rec) {
        // Only versions from preflight.json or a registry install are comparable;
        // unversioned git/ZIP sources and commit-hash versions are never checked.
        var commitOnly = rec.commit && rec.version === rec.commit.slice(0, 12);
        if (rec.source !== "registry" && (!rec.version || commitOnly))
            return { kind: "custom" };
        var pkg = registryPackageFor(rec.name, rec.href);
        if (!pkg)
            return { kind: "unlisted" };
        if (!rec.version)
            return { kind: "custom", pkg: pkg };
        var cmp = compareVersions(pkg.latest.version, rec.version);
        if (cmp > 0)
            return {
                kind: "upgrade", pkg: pkg,
                newer: pkg.versions.filter(function (v) { return compareVersions(v, rec.version) > 0 }),
            };
        return { kind: cmp < 0 ? "ahead" : "current", pkg: pkg };
    }

    function upgradeFor(rec) {
        var st = registryStatus(rec);
        return st.kind === "upgrade" ? st.pkg.latest : null;
    }

    function installPath(name) {
        return root() + "/usr/share/cockpit/" + name;
    }

    // One row per package name: the install record, folders in the (fake) root
    // with a preflight.json but no record, and packages elsewhere on the system.
    function inventoryRows() {
        var installed = allInstalled();
        var byName = {};

        Object.keys(installed).forEach(function (name) {
            var rec = Object.assign({ name: name }, installed[name]);
            var disk = state.managed.find(function (m) { return m.name === name });
            if (!rec.version && disk && disk.version)
                rec.version = disk.version;
            byName[name] = { name: name, rec: rec, kind: "crewmate", paths: [installPath(name)], onDisk: !!disk };
        });
        state.managed.forEach(function (m) {
            if (byName[m.name] || !m.preflight)
                return;
            byName[m.name] = { name: m.name, rec: { name: m.name, version: m.version }, kind: "unmanaged", paths: [installPath(m.name)], onDisk: true };
        });
        state.system.forEach(function (sys) {
            var row = byName[sys.name];
            if (row) {
                if (row.paths.indexOf(sys.path) === -1)
                    row.paths.push(sys.path);
                return;
            }
            byName[sys.name] = { name: sys.name, rec: { name: sys.name, version: sys.version }, kind: "system", paths: [sys.path], onDisk: true };
        });
        return Object.keys(byName).map(function (k) { return byName[k] });
    }

    function renderInstalled() {
        if (!state.config || !state.loaded)
            return;
        if (!installedTable)
            installedTable = App.table.create({
                container: "installed-table",
                caption: "Installed Cockpit packages",
                emptyText: "Nothing installed yet. Pick something from the Gallery or add a custom source.",
                columns: [
                    { key: "name", label: "Package", render: function (v, row) { return row.nameNode } },
                    { key: "location", label: "Location", render: function (v, row) { return row.locationNode } },
                    { key: "local", label: "Local" },
                    { key: "remote", label: "Remote" },
                    { key: "status", label: "Status", sortable: false, render: function (v, row) { return row.statusNode } },
                    { key: "actions", label: "", sortable: false, render: function (v, row) { return row.actions } },
                ],
                sort: { key: "name", dir: "asc" },
            });

        installedTable.setRows(inventoryRows().map(function (item) {
            var rec = item.rec;
            var st = item.kind === "crewmate" || rec.version ? registryStatus(rec)
                : { kind: "unknown", pkg: registryPackageFor(item.name, "") };
            var pkg = st.pkg || null;
            var status = el("div", { class: "app-status" });
            var actions = el("div", { class: "app-actions" });

            if (!item.onDisk)
                status.appendChild(label("Missing on Disk", "red"));
            else if (st.kind === "upgrade") {
                status.appendChild(label("Upgrade Available", "orange"));
                status.appendChild(el("div", { class: "app-muted", text: st.newer.length + " newer: " + st.newer.join(", ") }));
            } else if (st.kind === "current")
                status.appendChild(label("Up to Date", "green"));
            else if (st.kind === "ahead")
                status.appendChild(label("Newer Than Registry", "blue"));
            else if (st.kind === "unlisted")
                status.appendChild(label("Not in Registry", "purple"));
            else if (st.kind === "custom")
                status.appendChild(label("Custom Source", "purple"));
            if (item.kind !== "crewmate")
                status.appendChild(label(item.kind === "system" ? "Not Installed by Crewmate" : "Unmanaged", "purple"));

            if (pkg && (st.kind === "upgrade" || st.kind === "unknown")) {
                var verb = st.kind === "upgrade" ? "Upgrade to " : "Install ";
                actions.appendChild(button(verb + pkg.latest.version, st.kind === "upgrade" ? "primary" : "secondary",
                    function () {
                        startInstall({ kind: "registry", name: item.name, href: pkg.latest.href, ref: "", version: pkg.latest.version, upgrade: true });
                    }));
            }
            if (item.name !== PKG)
                actions.appendChild(button("Uninstall", "danger", function () { confirmUninstall(item) }));

            var source = item.kind === "system" ? "found on the system"
                : item.kind === "unmanaged" ? "not installed by Crewmate"
                : rec.source === "registry" ? "registry" + (rec.method ? " via " + rec.method : "")
                : rec.source + (rec.href ? ": " + rec.href + (rec.ref ? " @ " + rec.ref : "") : "");

            return {
                name: item.name,
                nameNode: el("div", {}, [
                    el("div", { class: "app-strong", text: item.name }),
                    el("div", { class: "app-muted", text: source + (rec.installedAt ? ", " + new Date(rec.installedAt).toLocaleDateString() : "") }),
                ]),
                location: item.paths.join(" "),
                locationNode: el("div", {}, item.paths.map(function (p) { return el("div", { class: "app-path", text: p }) })),
                local: rec.version || (rec.commit ? rec.commit.slice(0, 12) : "unknown"),
                remote: pkg ? pkg.latest.version : "—",
                statusNode: status,
                actions: actions,
            };
        }));
    }

    // ------------------------------------------------------------------
    // Gallery
    // ------------------------------------------------------------------
    function renderGallery() {
        if (!state.loaded)
            return;
        var list = document.getElementById("gallery-list");
        document.getElementById("gallery-source").textContent = state.registrySource || "(not loaded)";
        if (!state.registry || !state.config) {
            list.replaceChildren(el("p", { class: "app-muted",
                text: "The registry couldn't be loaded. Check the error above and the Debug Log. Custom Sources still works." }));
            return;
        }
        var packages = registryPackages();
        if (!packages.length) {
            list.replaceChildren(el("p", { class: "app-muted", text: "The registry has no apps listed." }));
            return;
        }
        var installed = allInstalled();
        list.replaceChildren.apply(list, packages.map(function (pkg) {
            var app = pkg.latest;
            var name = pkg.name;
            var rec = installed[name] ? Object.assign({ name: name }, installed[name]) : null;
            var footer;
            if (!rec) {
                footer = button("Install " + app.version, "primary", function () {
                    startInstall({ kind: "registry", name: name, href: app.href, ref: "", version: app.version });
                });
            } else {
                footer = label("Installed" + (rec.version ? " " + rec.version : ""), "green");
            }
            var older = pkg.versions.slice(1);
            var link = el("a", { href: app.href, target: "_blank", rel: "noopener noreferrer", text: app.href });
            return el("div", { class: "pf-v6-c-card pf-m-compact app-gallery__card" }, [
                el("div", { class: "pf-v6-c-card__header" }, [
                    el("div", { class: "pf-v6-c-card__header-main" }, [
                        el("div", { class: "pf-v6-c-card__title" }, [
                            el("h3", { class: "pf-v6-c-card__title-text", text: app.name }),
                        ]),
                    ]),
                ]),
                el("div", { class: "pf-v6-c-card__body" }, [
                    el("p", { text: app.description || "" }),
                    el("p", { class: "app-muted pf-v6-u-mt-sm",
                              text: "v" + app.version + (older.length ? " (also listed: " + older.join(", ") + ")" : "") }),
                    el("p", { class: "app-muted" }, [link]),
                ]),
                el("div", { class: "pf-v6-c-card__footer" }, [footer]),
            ]);
        }));
    }

    // Preflight result statuses: pass, warn (can't tell; install allowed),
    // missing / outdated (offered for install), block (can't install here).
    function probeDeps(pf) {
        var deps = (pf && Array.isArray(pf.dependencies)) ? pf.dependencies : [];
        var results = [];
        return deps.reduce(function (chain, dep) {
            return chain.then(function () {
                if (!dep || typeof dep.name !== "string" || !NAME_RE.test(dep.name)) {
                    results.push({ dep: dep, invalid: true });
                    return;
                }
                var wantVersion = !!(dep.min || dep.probe);
                var args = ["probe", dep.name, wantVersion ? "version" : "exists"];
                if (dep.probe)
                    args.push(String(dep.probe));
                return helper(args).then(function (r) {
                    results.push({
                        dep: dep,
                        found: first(r, "found"),
                        output: first(r, "output"),
                    });
                });
            });
        }, Promise.resolve()).then(function () { return results });
    }

    function evaluatePreflight(pf, env, probes) {
        var out = [];
        if (pf === null) {
            out.push({ check: "preflight.json", want: "present", got: "not present", status: "block",
                       detail: "Crewmate only installs packages that ship a preflight.json file." });
            return out;
        }
        if (pf.invalid) {
            out.push({ check: "preflight.json", want: "valid JSON", got: pf.invalid, status: "block", detail: "Fix the package's preflight.json." });
            return out;
        }
        if (typeof pf.cmSchema === "number" && pf.cmSchema > CM_SCHEMA)
            out.push({ check: "preflight.json", want: "cmSchema ≤ " + CM_SCHEMA, got: String(pf.cmSchema), status: "block",
                       detail: "Needs a newer Crewmate. Update Crewmate first." });

        if (pf.cockpitMin !== undefined) {
            var min = String(pf.cockpitMin);
            if (!env.cockpit)
                out.push({ check: "Cockpit", want: "≥ " + min, got: "unknown", status: "warn", detail: "Cockpit's version couldn't be read." });
            else if (compareVersions(env.cockpit, min) < 0)
                out.push({ check: "Cockpit", want: "≥ " + min, got: env.cockpit, status: "block", detail: "This machine's Cockpit is too old for this package." });
            else
                out.push({ check: "Cockpit", want: "≥ " + min, got: env.cockpit, status: "pass" });
        }

        probes.forEach(function (p) {
            if (p.invalid) {
                out.push({ check: "dependency", want: "", got: JSON.stringify(p.dep), status: "block", detail: "Invalid dependency entry in preflight.json." });
                return;
            }
            var dep = p.dep;
            var want = dep.min ? "≥ " + dep.min : "present";
            if (!p.found) {
                out.push({ check: dep.name, want: want, got: "not found", status: "missing", dep: dep });
                return;
            }
            if (!dep.min && !dep.probe) {
                out.push({ check: dep.name, want: want, got: p.found, status: "pass" });
                return;
            }
            var v = parseVersion(p.output);
            if (!dep.min)
                out.push({ check: dep.name, want: want, got: v || p.found, status: "pass" });
            else if (!v)
                out.push({ check: dep.name, want: want, got: p.output || "no output", status: "warn",
                           detail: "Found, but couldn't read its version." });
            else if (compareVersions(v, String(dep.min)) < 0)
                out.push({ check: dep.name, want: want, got: v, status: "outdated", dep: dep });
            else
                out.push({ check: dep.name, want: want, got: v, status: "pass" });
        });
        return out;
    }

    var STATUS_LABEL = {
        pass: ["OK", "green"],
        warn: ["Check", "orange"],
        missing: ["Missing", "orange"],
        outdated: ["Too old", "orange"],
        block: ["Blocks install", "red"],
    };

    function preflightTable(results) {
        var t = el("table", { class: "pf-v6-c-table pf-m-compact app-preflight" }, [
            el("thead", { class: "pf-v6-c-table__thead" }, [
                el("tr", { class: "pf-v6-c-table__tr" }, ["Check", "Needs", "Found", "Result"].map(function (h) {
                    return el("th", { class: "pf-v6-c-table__th", scope: "col", text: h });
                })),
            ]),
            el("tbody", { class: "pf-v6-c-table__tbody" }, results.map(function (r) {
                var l = STATUS_LABEL[r.status];
                var resultCell = el("td", { class: "pf-v6-c-table__td" }, [label(l[0], l[1])]);
                if (r.detail)
                    resultCell.appendChild(el("div", { class: "app-muted", text: r.detail }));
                return el("tr", { class: "pf-v6-c-table__tr" }, [
                    el("td", { class: "pf-v6-c-table__td", text: r.check }),
                    el("td", { class: "pf-v6-c-table__td", text: r.want }),
                    el("td", { class: "pf-v6-c-table__td", text: r.got }),
                    resultCell,
                ]);
            })),
        ]);
        return t;
    }

    // Install / upgrade modal.
    // src: { kind: "registry" | "git" | "zip", name, href, ref, version, file (zip), upgrade }
    var STEPS = [
        ["env", "Check the host"],
        ["fetch", "Download into a staging folder"],
        ["inspect", "Read manifest.json and preflight.json"],
        ["preflight", "Check requirements"],
        ["install", "Install"],
    ];
    var STEP_ICON = { todo: "○", run: "…", ok: "✓", warn: "!", fail: "✗" };

    function startInstall(src) {
        if (state.busy) {
            App.alerts.toast("warning", "Another operation is running", { description: "Let it finish first." });
            return;
        }
        state.busy = true;

        var stage = null;
        var pkgDir = null;
        var fetched = {};
        var finished = false;
        var reloader = null;
        var depsFixedDry = false;
        var fixAttempted = false;

        var stepNodes = {};
        var stepList = el("ol", { class: "app-steps" }, STEPS.map(function (s) {
            var icon = el("span", { class: "app-steps__icon", text: STEP_ICON.todo });
            var note = el("span", { class: "app-muted" });
            var li = el("li", { class: "app-steps__item is-todo" }, [icon, el("span", { text: s[1] + " " }), note]);
            stepNodes[s[0]] = { li: li, icon: icon, note: note };
            return li;
        }));
        function step(key, status, note) {
            var n = stepNodes[key];
            n.li.className = "app-steps__item is-" + status;
            n.icon.textContent = STEP_ICON[status];
            if (note !== undefined)
                n.note.textContent = note ? "(" + note + ")" : "";
        }

        var checks = el("div", { class: "app-modal__section" });
        var depsBox = el("div", { class: "app-modal__section" });
        var logPre = el("pre", { class: "app-log app-log--modal", "aria-live": "off" });
        var unsubscribe = Log.subscribe(function (entry) {
            logPre.appendChild(Log.render(entry));
            logPre.scrollTop = logPre.scrollHeight;
        });

        var installBtn = el("button", { class: "pf-v6-c-button pf-m-primary", type: "button",
                                        text: (src.upgrade ? "Upgrade" : "Install") + (DRY ? " (dry run)" : "") });
        installBtn.disabled = true;
        var cancelBtn = el("button", { class: "pf-v6-c-button pf-m-link", type: "button", text: "Cancel" });
        var fixBtn = el("button", { class: "pf-v6-c-button pf-m-primary", type: "button", text: "Fix Dependencies" + (DRY ? " (dry run)" : "") });
        var recheckBtn = el("button", { class: "pf-v6-c-button pf-m-secondary", type: "button", text: "Re-Check" });
        var forceBtn = el("button", { class: "pf-v6-c-button pf-m-danger", type: "button", text: "Force Install" + (DRY ? " (dry run)" : "") });
        forceBtn.hidden = true;
        fixBtn.hidden = true;
        recheckBtn.hidden = true;

        var intro = el("p", {}, [
            el("strong", { text: src.name }),
            el("span", { text: src.version ? " " + src.version : "" }),
            el("span", { class: "app-muted", text: " from " + (src.kind === "zip" ? "uploaded file " + src.file.name : src.href + (src.ref ? " @ " + src.ref : "")) }),
        ]);

        var modal = App.modals.open({
            title: (src.upgrade ? "Upgrade " : "Install ") + src.name,
            size: "lg",
            body: [intro, stepList, checks, depsBox,
                   el("p", { class: "app-settings__heading pf-v6-u-mt-md", text: "Log" }), logPre],
            footer: [fixBtn, recheckBtn, forceBtn, installBtn, cancelBtn],
            onClose: function () {
                if (reloader)
                    reloader.stop();
                unsubscribe();
                state.busy = false;
                if (stage)
                    helper(["cleanup", stage]).catch(function () {});
                if (!finished)
                    Log.add("crewmate", "install of " + src.name + " cancelled", "warn");
            },
        });
        cancelBtn.addEventListener("click", modal.close);

        function fail(key, ex) {
            step(key, "fail", ex.critical ? "critical" : errorText(ex));
            cancelBtn.textContent = "Close";
            if (!ex.critical) {
                modal.setStatus("Stopped: " + errorText(ex));
                return;
            }
            Log.add("critical", src.name + ": " + errorText(ex), "error");
            Object.keys(stepNodes).forEach(function (k) {
                if (stepNodes[k].li.classList.contains("is-todo"))
                    step(k, "todo", "skipped");
            });
            modal.setTitle("Install stopped: " + src.name);
            modal.setStatus("");
            checks.replaceChildren(App.alerts.inline(el("div"), "danger", "Critical error: missing preflight.json", [
                errorText(ex),
                "Nothing was installed. The downloaded files are removed when you close this window.",
            ]));
            App.alerts.toast("danger", "Critical: " + src.name + " can't be installed", {
                description: "It has no preflight.json file.", timeout: 0,
            });
        }

        step("env", "run");
        detectEnv()
                .then(function () {
                    step("env", "ok", "cockpit " + (state.env.cockpit || "unknown") + ", " + state.env.tools.length + " tools");
                    step("fetch", "run");
                    return src.kind === "zip" ? stageUpload(src) : helper(["fetch", src.href, src.ref || "", src.name]);
                }, function (ex) { fail("env", ex); throw null })
                .then(function (r) {
                    stage = first(r, "stage");
                    pkgDir = first(r, "dir");
                    fetched = { method: first(r, "method"), commit: first(r, "commit"), hasPreflight: first(r, "preflight") === "yes" };
                    step("fetch", "ok", "via " + fetched.method + " → " + pkgDir);
                    step("inspect", "run");
                    return readPackage(pkgDir, fetched.hasPreflight);
                }, function (ex) { if (ex && ex.result) stage = first(ex.result, "stage"); if (ex) fail("fetch", ex); throw null })
                .then(function (pkg) {
                    fetched.manifest = pkg.manifest;
                    fetched.preflight = pkg.preflight;
                    step("inspect", "ok", pkg.preflight ? "preflight.json present" : "no preflight.json");
                    step("preflight", "run");
                    return probeDeps(pkg.preflight).then(function (probes) {
                        return { pf: pkg.preflight, probes: probes };
                    });
                }, function (ex) { if (ex) fail("inspect", ex); throw null })
                .then(showRequirements, function (ex) { if (ex) throw ex; throw null })
                .catch(function (ex) {
                    if (!ex)
                        return;
                    console.error("Crewmate preflight failed:", ex);
                    fail("preflight", ex);
                });

        function showRequirements(p) {
            var results = evaluatePreflight(p.pf, state.env, p.probes);
            checks.replaceChildren(el("p", { class: "app-settings__heading", text: "Requirements" }), preflightTable(results));
            var blocked = results.some(function (r) { return r.status === "block" });
            var needs = results.filter(function (r) { return r.status === "missing" || r.status === "outdated" });
            fixBtn.hidden = true;
            recheckBtn.hidden = true;
            if (blocked) {
                step("preflight", "fail", "blocked");
                installBtn.disabled = true;
                modal.setStatus("This package can't be installed here. See Requirements above.");
                depsBox.replaceChildren();
                if (p.pf && p.pf.issues)
                    depsBox.appendChild(el("p", {}, [
                        el("span", { text: "If this looks wrong, report it at " }),
                        el("a", { href: p.pf.issues, target: "_blank", rel: "noopener noreferrer", text: p.pf.issues }),
                    ]));
                cancelBtn.textContent = "Close";
                return;
            }
            var warned = needs.length || results.some(function (r) { return r.status === "warn" });
            step("preflight", warned ? "warn" : "ok", needs.length ? "dependencies need fixing" : warned ? "see Requirements" : "all good");
            installBtn.disabled = true;
            return renderDeps(needs, p.pf).then(function () { decide(needs) });
        }

        function decide(needs) {
            installBtn.onclick = function () { install() };
            if (needs.length && !depsFixedDry) {
                installBtn.disabled = true;
                modal.setStatus(fixAttempted
                    ? "Still not satisfied after running " + state.env.pm + ": " + needs.map(function (r) { return r.dep.name }).join(", ") +
                      ". The repositories may not have it, or not a new enough version. Fix it by hand, then press Re-Check."
                    : "Fix the dependencies first, otherwise the app won't work.");
                return;
            }
            installBtn.disabled = false;
            modal.setStatus(depsFixedDry
                ? "Dry run: the dependency commands were only logged, so they still show as missing. Install stays enabled for debugging."
                : "Ready. Review the requirements, then press " + installBtn.textContent + ".");
        }

        function recheck(pf) {
            step("preflight", "run", "re-checking");
            return probeDeps(pf).then(function (probes) {
                return showRequirements({ pf: pf, probes: probes });
            });
        }

        function renderDeps(needs, pf) {
            depsBox.replaceChildren();
            if (!needs.length)
                return Promise.resolve();
            var pm = state.env.pm;
            depsBox.appendChild(el("p", { class: "app-settings__heading", text: "Dependencies" }));
            depsBox.appendChild(el("ul", { class: "app-changes" }, needs.map(function (r) {
                return el("li", { text: r.dep.name + ": " + (r.status === "missing"
                    ? "not installed → install the latest from the repos"
                    : "found " + r.got + ", needs " + r.want + " → upgrade to the latest from the repos") });
            })));
            recheckBtn.hidden = false;
            recheckBtn.onclick = function () {
                recheck(pf).catch(function (ex) {
                    console.error("Crewmate re-check failed:", ex);
                    fail("preflight", ex);
                });
            };

            if (!pm || !PM[pm]) {
                depsBox.appendChild(App.alerts.inline(el("div"), "warning", "No supported package manager found",
                    "Crewmate supports apt-get, dnf, yum, zypper, apk and pacman. Install or upgrade the dependencies by hand, then press Re-Check."));
                return Promise.resolve();
            }
            var checking = el("p", { class: "app-muted", text: "Looking in the system's package repositories..." });
            depsBox.appendChild(checking);
            return unavailableIn(needs, pm).then(function (missingFromRepos) {
                checking.remove();
                if (missingFromRepos.length)
                    depsBox.appendChild(vendorNotice(missingFromRepos));
                var plan = fixPlan(needs.filter(function (r) { return missingFromRepos.indexOf(r) === -1 }), pm);
                fixBtn.hidden = !plan.commands.length;
                if (!plan.commands.length)
                    return;
                depsBox.appendChild(el("p", { class: "app-muted", text: "\"Fix Dependencies\" runs as root" + (DRY ? " (dry run: only logged)" : "") + ":" }));
                depsBox.appendChild(el("pre", { class: "app-log app-log--cmds", text: plan.commands.map(function (c) { return c.join(" ") }).join("\n") }));
                if (plan.skipped.length)
                    depsBox.appendChild(el("p", { class: "app-muted", text: "Skipped (invalid package name in preflight.json): " + plan.skipped.join(", ") }));
                depsBox.appendChild(el("p", { class: "app-muted",
                    text: "Package names default to the command names unless preflight.json sets \"package\"." }));
                wireFix(plan, pm, pf);
            });
        }

        // Needs whose package the OS repositories don't carry. If the check
        // can't tell, "Fix Dependencies" is left to try.
        function unavailableIn(needs, pm) {
            var out = [];
            return needs.reduce(function (chain, r) {
                return chain.then(function () {
                    var pkg = depPackage(r.dep, pm);
                    if (!pkg)
                        return;
                    return helper(["pkgcheck", pm, pkg]).then(function (res) {
                        if (first(res, "available") === "no")
                            out.push(r);
                    }, function () {});
                });
            }, Promise.resolve()).then(function () { return out });
        }

        function vendorNotice(list) {
            var items = list.map(function (r) {
                var docs = typeof r.dep.docs === "string" && /^https?:\/\//.test(r.dep.docs) ? r.dep.docs : null;
                return el("li", {}, docs ? [
                    el("strong", { text: r.dep.name + ": " }),
                    el("span", { text: "see the vendor's install instructions: " }),
                    el("a", { href: docs, target: "_blank", rel: "noopener noreferrer", text: docs }),
                ] : [
                    el("strong", { text: r.dep.name + ": " }),
                    el("span", { text: "check the vendor's documentation for install instructions." }),
                ]);
            });
            Log.add("deps", "not in the OS's package repositories: " + list.map(function (r) { return r.dep.name }).join(", "), "warn");
            return App.alerts.inline(el("div"), "warning", "Not in the system repositories", [
                "The system's package repositories don't carry these, so \"Fix Dependencies\" can't install them:",
                el("ul", { class: "app-changes" }, items),
                "Install them the way the vendor describes (usually by adding their repository), then press Re-Check.",
            ]);
        }

        function wireFix(plan, pm, pf) {
            fixBtn.onclick = function () {
                fixBtn.disabled = recheckBtn.disabled = installBtn.disabled = cancelBtn.disabled = true;
                step("preflight", "run", "fixing dependencies with " + pm);
                modal.setStatus("Running " + pm + "...");
                plan.commands.reduce(function (chain, argv) {
                    return chain.then(function () { return runAsRoot(argv) });
                }, Promise.resolve())
                        .then(function () {
                            fixAttempted = true;
                            if (DRY)
                                depsFixedDry = true;
                            return recheck(pf);
                        })
                        .catch(function (ex) {
                            Log.add("deps", errorText(ex), "error");
                            step("preflight", "fail", "fixing dependencies failed");
                            modal.setStatus("Fixing dependencies failed: " + errorText(ex) + " See the log below.");
                        })
                        .finally(function () {
                            fixBtn.disabled = recheckBtn.disabled = cancelBtn.disabled = false;
                        });
            };
        }

        function install(force) {
            installBtn.disabled = fixBtn.disabled = recheckBtn.disabled = true;
            cancelBtn.disabled = true;
            fixBtn.hidden = recheckBtn.hidden = forceBtn.hidden = true;
            step("install", "run");
            doInstall(src, pkgDir, fetched, force)
                    .then(function () {
                        finished = true;
                        step("install", "ok", installPath(src.name));
                        modal.setTitle((src.upgrade ? "Upgraded " : "Installed ") + src.name);
                        installBtn.hidden = true;
                        if (DRY) {
                            modal.setStatus("Done (dry run). Files are in " + installPath(src.name) + "; nothing changed on the real system.");
                            return;
                        }
                        modal.setStatus("Done. Reload the Cockpit tab to update the sidebar and pick up changed files.");
                        reloader = reloadCountdown(installBtn.parentNode, cancelBtn, src.name + (src.upgrade ? " upgraded" : " installed"));
                    }, function (ex) {
                        fail("install", ex);
                        // A hand-deployed copy (no preflight.json) blocks the install. Offer to replace it;
                        // the helper keeps the old folder as a rollback copy.
                        if (!force && /isn't a Crewpit package/.test(errorText(ex))) {
                            modal.setStatus(installPath(src.name) + " was deployed by hand. Force Install replaces it and keeps the old copy as a rollback.");
                            forceBtn.hidden = false;
                            forceBtn.onclick = function () { install(true) };
                        }
                    })
                    .finally(function () {
                        cancelBtn.disabled = false;
                        if (!reloader)
                            cancelBtn.textContent = "Close";
                    });
        }
    }

    // Package for a dependency: preflight.json "package" (a string, or a map per
    // package manager) when it differs from the command name.
    function depPackage(dep, pm) {
        var p = dep.package;
        if (p && typeof p === "object")
            p = p[pm];
        p = typeof p === "string" && p ? p : dep.name;
        return PKG_RE.test(p) ? p : null;
    }

    function fixPlan(needs, pm) {
        var cmds = PM[pm];
        var install = [];
        var upgrade = [];
        var skipped = [];
        needs.forEach(function (r) {
            var pkg = depPackage(r.dep, pm);
            if (!pkg)
                skipped.push(r.dep.name);
            else if (r.status === "missing")
                install.push(pkg);
            else
                upgrade.push(pkg);
        });
        var commands = [];
        if (cmds.refresh && (install.length || upgrade.length))
            commands.push(cmds.refresh);
        if (install.length)
            commands.push(cmds.install.concat(install));
        if (upgrade.length)
            commands.push(cmds.upgrade.concat(upgrade));
        return { commands: commands, skipped: skipped };
    }

    function runAsRoot(argv) {
        if (DRY) {
            Log.add("deps", "[DRY] would run as root: " + argv.join(" "), "dry");
            return Promise.resolve();
        }
        Log.add("deps", "[root] " + argv.join(" "), "cmd");
        var buffer = "";
        var proc = cockpit.spawn(argv, { superuser: "require", err: "out", environ: ["DEBIAN_FRONTEND=noninteractive"] });
        proc.stream(function (chunk) {
            buffer += chunk;
            var lines = buffer.split("\n");
            buffer = lines.pop();
            lines.forEach(function (l) { if (l.trim()) Log.add("deps", l, "raw") });
        });
        return settle(proc).then(function () {
            if (buffer.trim())
                Log.add("deps", buffer, "raw");
        }, function (ex) {
            if (buffer.trim())
                Log.add("deps", buffer, "raw");
            throw new Error(argv.join(" ") + " failed: " + errorText(ex));
        });
    }

    // The sidebar is built once per load, so changes only show after reloading
    // the top window. Adds a "Reload tab (15)" button to `footer` and returns
    // { stop } for the modal's onClose.
    function reloadCountdown(footer, closeBtn, why) {
        var seconds = 15;
        var btn = el("button", { class: "pf-v6-c-button pf-m-primary", type: "button" });
        function paint() { btn.textContent = "Reload Tab (" + seconds + ")" }
        paint();
        btn.addEventListener("click", reloadTab);
        footer.insertBefore(btn, footer.firstChild);
        closeBtn.textContent = "Close (Don't Reload)";
        btn.focus();
        Log.add("crewmate", "reloading the Cockpit tab in " + seconds + "s: " + why);
        var timer = window.setInterval(function () {
            seconds -= 1;
            if (seconds > 0) {
                paint();
                return;
            }
            window.clearInterval(timer);
            reloadTab();
        }, 1000);
        return { stop: function () { window.clearInterval(timer) } };
    }

    function stageUpload(src) {
        var stage = null;
        return helper(["mkstage"])
                .then(function (r) {
                    stage = first(r, "stage");
                    Log.add("upload", "reading " + src.file.name + " (" + src.file.size + " bytes) in the browser");
                    return src.file.arrayBuffer();
                })
                .then(function (buf) {
                    var target = stage + "/upload.archive";
                    Log.add("upload", "writing " + buf.byteLength + " bytes to " + target + " via cockpit.file");
                    return settle(stageFile(target, { binary: true }).replace(new Uint8Array(buf))).then(function () { return target });
                })
                .then(function (target) {
                    return helper(["unpack", target, src.name]);
                })
                .then(function (r) {
                    r.kv.stage = [stage];
                    return r;
                });
    }

    function readPackage(dir, hasPreflight) {
        var pkg = { manifest: null, preflight: null };
        return settle(stageFile(dir + "/manifest.json", { syntax: JSON }).read())
                .then(function (m) {
                    pkg.manifest = m || {};
                    var labels = [];
                    ["tools", "menu", "dashboard"].forEach(function (s) {
                        Object.keys(pkg.manifest[s] || {}).forEach(function (k) {
                            labels.push(s + "/" + k + " \"" + (pkg.manifest[s][k].label || k) + "\"");
                        });
                    });
                    Log.add("inspect", "manifest.json: " + (labels.join(", ") || "no menu entries") +
                            (pkg.manifest.requires && pkg.manifest.requires.cockpit ? ", requires cockpit " + pkg.manifest.requires.cockpit : ""));
                    if (!hasPreflight) {
                        var err = new Error("No preflight.json file in the package root. Crewmate only installs packages that ship one (an empty file is enough).");
                        err.critical = true;
                        throw err;
                    }
                    return settle(stageFile(dir + "/preflight.json").read());
                }, function (ex) {
                    throw new Error("manifest.json isn't valid JSON: " + errorText(ex));
                })
                .then(function (text) {
                    if (text === null || !text.trim()) {
                        Log.add("inspect", "preflight.json is empty: no requirements declared");
                        pkg.preflight = {};
                        return pkg;
                    }
                    try {
                        pkg.preflight = JSON.parse(text);
                        if (!pkg.preflight || typeof pkg.preflight !== "object")
                            throw new Error("not a JSON object");
                        Log.add("inspect", "preflight.json: " + JSON.stringify(pkg.preflight));
                    } catch (ex) {
                        Log.add("inspect", "preflight.json is invalid: " + errorText(ex), "error");
                        pkg.preflight = { invalid: errorText(ex) };
                    }
                    return pkg;
                });
    }

    function doInstall(src, pkgDir, fetched, force) {
        return helper(force ? ["install", pkgDir, src.name, "force"] : ["install", pkgDir, src.name])
                .then(function () {
                    var prev = state.config.installed[src.name] || {};
                    var pfVersion = fetched.preflight && typeof fetched.preflight.version === "string" ? fetched.preflight.version : "";
                    if (pfVersion && src.version && compareVersions(pfVersion, src.version) !== 0)
                        Log.add("record", "registry says " + src.version + " but preflight.json says " + pfVersion + "; recording " + pfVersion, "warn");
                    state.config.installed[src.name] = {
                        name: src.name,
                        label: firstLabel(fetched.manifest) || src.name,
                        version: pfVersion || (src.kind === "registry" ? src.version : ""),
                        source: src.kind,
                        href: src.href || "",
                        ref: src.ref || "",
                        commit: fetched.commit || "",
                        method: fetched.method || "",
                        scope: "system",
                        installedAt: new Date().toISOString(),
                        firstInstalledAt: prev.firstInstalledAt || prev.installedAt || new Date().toISOString(),
                    };
                    Log.add("record", src.name + " → " + JSON.stringify(state.config.installed[src.name]));
                    return saveRecord();
                })
                .then(refreshInventory)
                .then(renderGallery);
    }

    function reloadTab() {
        Log.add("crewmate", "reloading the whole Cockpit tab");
        try {
            window.top.location.reload();
        } catch (ex) {
            window.location.reload();
        }
    }

    function firstLabel(manifest) {
        var sections = ["tools", "menu", "dashboard"];
        for (var i = 0; i < sections.length; i++) {
            var s = (manifest || {})[sections[i]] || {};
            var keys = Object.keys(s);
            if (keys.length && s[keys[0]].label)
                return s[keys[0]].label;
        }
        return null;
    }

    // Only <root>/usr/share/cockpit is touched; copies elsewhere are left alone.
    function confirmUninstall(item) {
        if (state.busy) {
            App.alerts.toast("warning", "Another operation is running");
            return;
        }
        var name = item.name;
        var mine = item.paths.filter(function (p) { return p === installPath(name) });
        var other = item.paths.filter(function (p) { return p !== installPath(name) });
        var body = [];
        if (mine.length)
            body.push("Removes " + mine[0] + " and its rollback copy in " + root() + "/var/lib/crewmate/backup/.");
        if (other.length)
            body.push((DRY ? "Dry run: " + other.join(", ") + " is only logged, not removed."
                           : other.join(", ") + " is outside Crewmate's package folder and stays; remove it yourself if needed."));
        if (!DRY && mine.length)
            body.push("Runs as root. The app leaves the sidebar once the Cockpit tab reloads.");
        var reloader = null;
        App.modals.confirm({
            title: "Uninstall " + name + "?",
            body: body,
            onClose: function () {
                if (reloader)
                    reloader.stop();
            },
            buttons: [
                {
                    label: "Uninstall" + (DRY ? " (dry run)" : ""), variant: "danger",
                    action: function (m) {
                        state.busy = true;
                        m.setStatus("Removing...");
                        other.forEach(function (p) {
                            Log.add("uninstall", (DRY ? "[DRY] would run as root: rm -rf " : "left in place (outside " + installPath("") + "): ") + p, DRY ? "dry" : "warn");
                        });
                        return (mine.length ? helper(["uninstall", name]) : Promise.resolve())
                                .then(function () {
                                    if (!state.config.installed[name])
                                        return;
                                    delete state.config.installed[name];
                                    return saveRecord();
                                })
                                .then(refreshInventory)
                                .then(function () {
                                    renderGallery();
                                    if (DRY || !mine.length) {
                                        m.close();
                                        App.alerts.toast("success", "Uninstalled " + name + (DRY ? " (dry run)" : ""));
                                        return;
                                    }
                                    var buttons = m.box.querySelectorAll(".pf-v6-c-modal-box__footer button");
                                    buttons[0].hidden = true;
                                    m.setTitle("Uninstalled " + name);
                                    m.setStatus("Removed. Reload the Cockpit tab to drop it from the sidebar.");
                                    reloader = reloadCountdown(buttons[0].parentNode, buttons[1], name + " uninstalled");
                                }, function (ex) {
                                    m.setStatus("Failed: " + errorText(ex));
                                })
                                .finally(function () { state.busy = false });
                    },
                },
                { label: "Cancel", variant: "link", action: function (m) { m.close() } },
            ],
            focus: 1,
        });
    }

    document.getElementById("git-url").addEventListener("input", function (ev) {
        document.getElementById("git-name").placeholder = nameFromHref(ev.target.value) || "taken from the URL";
    });

    document.getElementById("git-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        App.alerts.inline("custom-alert");
        var url = document.getElementById("git-url").value.trim();
        var ref = document.getElementById("git-ref").value.trim();
        var name = document.getElementById("git-name").value.trim() || nameFromHref(url);
        if (!/^(https?|git|ssh):\/\/\S+$/.test(url) && !/^[\w.-]+@[\w.-]+:\S+$/.test(url)) {
            App.alerts.inline("custom-alert", "danger", "That doesn't look like a git or http(s) URL", url || "(empty)");
            return;
        }
        if (ref && !/^[A-Za-z0-9._\/-]+$/.test(ref)) {
            App.alerts.inline("custom-alert", "danger", "Invalid branch or tag", ref);
            return;
        }
        if (!name || !NAME_RE.test(name)) {
            App.alerts.inline("custom-alert", "danger", "Invalid package name",
                              "Letters, digits, dot, dash, underscore and plus only; can't start with a dot.");
            return;
        }
        startInstall({ kind: "git", name: name, href: url, ref: ref, version: "", upgrade: !!state.config.installed[name] });
    });

    document.getElementById("zip-file").addEventListener("change", function (ev) {
        var f = ev.target.files[0];
        document.getElementById("zip-name").placeholder = (f && nameFromHref(f.name)) || "taken from the file name";
    });

    document.getElementById("zip-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        App.alerts.inline("custom-alert");
        var file = document.getElementById("zip-file").files[0];
        if (!file) {
            App.alerts.inline("custom-alert", "danger", "Choose a .zip or .tar.gz file first");
            return;
        }
        var name = document.getElementById("zip-name").value.trim() || nameFromHref(file.name);
        if (!name || !NAME_RE.test(name)) {
            App.alerts.inline("custom-alert", "danger", "Invalid package name",
                              "Letters, digits, dot, dash, underscore and plus only; can't start with a dot.");
            return;
        }
        if (file.size > 50 * 1024 * 1024) {
            App.alerts.inline("custom-alert", "danger", "File too large", "Cockpit packages are usually a few MB; this is " + Math.round(file.size / 1048576) + " MB.");
            return;
        }
        startInstall({ kind: "zip", name: name, file: file, version: "", upgrade: !!state.config.installed[name] });
    });

    var settingsForm = null;

    function showSettings() {
        renderHostInfo();
        if (settingsForm || !state.config)
            return;
        settingsForm = App.settings.form({
            container: "settings-form",
            fields: [
                { key: "registryUrl", label: "Registry URL", help: "registry.json listing the installable apps." },
                {
                    key: "method", label: "Transfer Method", type: "select",
                    options: [
                        { value: "auto", label: "Automatic: git → curl → wget → openssl → /dev/tcp" },
                        { value: "git", label: "git only" },
                        { value: "curl", label: "curl only" },
                        { value: "wget", label: "wget only" },
                        { value: "openssl", label: "openssl s_client only (raw HTTPS)" },
                        { value: "devtcp", label: "bash /dev/tcp only (plain HTTP)" },
                    ],
                    help: "Forcing a single method is useful for testing the fallbacks.",
                },
                {
                    key: "dryRun", label: "Dry Run", type: "checkbox",
                    help: "For debugging. Downloads and checks run for real, but installs go into " + DRY_ROOT +
                          " and package-manager and removal commands outside it are only logged. Changing it reloads Crewmate.",
                },
            ],
            load: function () { return Object.assign({}, state.config.settings) },
            save: function (values, changes) {
                state.config.settings = Object.assign({}, state.config.settings, values);
                return saveSettingsFile().then(function () {
                    if (!changes.some(function (c) { return c.key === "dryRun" }))
                        return;
                    Log.add("config", "Dry Run turned " + (values.dryRun ? "on" : "off") + "; reloading Crewmate");
                    window.setTimeout(function () { window.location.reload() }, 2000);
                });
            },
            notice: { seconds: 5 },
        });
    }

    document.getElementById("cleanup-btn").addEventListener("click", function () {
        if (state.busy) {
            App.alerts.toast("warning", "Let the running install finish first");
            return;
        }
        helper(["cleanup-all"])
                .then(function () { App.alerts.toast("success", "Staging folders removed") })
                .catch(function (ex) { App.alerts.toast("danger", "Cleanup failed", { description: errorText(ex) }) });
    });

    document.getElementById("log-copy").addEventListener("click", function () {
        App.clipboard.copy(Log.text())
                .then(function () { App.alerts.toast("success", "Log copied") })
                .catch(function (ex) { App.alerts.toast("danger", "Copy failed", { description: ex.message }) });
    });
    document.getElementById("log-clear").addEventListener("click", Log.clear);

    function busyButton(btn, label, work) {
        var old = btn.textContent;
        btn.disabled = true;
        btn.textContent = label;
        return work().finally(function () {
            btn.disabled = false;
            btn.textContent = old;
        });
    }

    // Refresh re-reads the registry, which doubles as the upgrade check.
    document.getElementById("gallery-refresh").addEventListener("click", function (ev) {
        busyButton(ev.currentTarget, "Refreshing...", function () {
            return Promise.all([fetchRegistry(), refreshInventory()]);
        });
    });
    document.getElementById("installed-refresh").addEventListener("click", function (ev) {
        busyButton(ev.currentTarget, "Refreshing...", function () {
            return Promise.all([fetchRegistry(), refreshInventory()]).then(function () {
                var installed = allInstalled();
                var n = Object.keys(installed).filter(function (k) {
                    return upgradeFor(Object.assign({ name: k }, installed[k]));
                }).length;
                App.alerts.toast(n ? "info" : "success", n ? n + " upgrade(s) available" : "Everything is up to date");
            });
        });
    });

    var MENU = {
        label: "Crewmate",
        items: [
            { label: "Installed", path: "/", pane: "pane-installed" },
            {
                label: "Gallery", path: "/gallery", pane: "pane-gallery",
                children: [
                    { label: "Custom Sources", path: "/custom", pane: "pane-custom" },
                ],
            },
            {
                label: "Settings", path: "/settings", pane: "pane-settings", onShow: showSettings,
                children: [
                    { label: "Debug Log", path: "/log", pane: "pane-log" },
                ],
            },
        ],
    };

    App.menu.mount(MENU, { nav: "app-menu", startExpanded: true });

    // Name animation in the menu bar (styles at the end of index.css). Pauses
    // while the page is hidden and is skipped for reduced motion.
    (function startNameFx() {
        var nameEl = document.querySelector(".app-menubar__label");
        if (!nameEl || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
            return;
        var STEPS = [["fx-contrail", 3], ["fx-horizon", 4], [null, 10]];
        var i = 0;

        function next() {
            nameEl.classList.remove("fx-contrail", "fx-horizon");
            if (cockpit.hidden) {
                cockpit.addEventListener("visibilitychange", function resume() {
                    if (cockpit.hidden)
                        return;
                    cockpit.removeEventListener("visibilitychange", resume);
                    next();
                });
                return;
            }
            var stepNow = STEPS[i];
            i = (i + 1) % STEPS.length;
            if (stepNow[0]) {
                void nameEl.offsetWidth;
                nameEl.classList.add(stepNow[0]);
            }
            window.setTimeout(next, stepNow[1] * 1000);
        }

        window.setTimeout(next, 1000);
    }());

    function showModeBanner() {
        if (!DRY) {
            App.alerts.inline("dry-banner");
            return;
        }
        App.alerts.inline("dry-banner", "warning", "Dry Run is on", [
            "Downloads, unpacking and requirement checks are real, but nothing is written outside /tmp.",
            "Installs go into the fake root " + DRY_ROOT + ", and package-manager and removal commands are only logged. " +
            "The Debug Log shows everything Crewmate does. Turn Dry Run off in Settings.",
        ]);
    }

    Log.add("crewmate", "starting");
    setPending("Reading settings and the install record...");
    loadConfig()
            .then(function () {
                showModeBanner();
                if (location.hash === "#/settings")
                    showSettings();
                setPending("Checking the host, installed packages and the registry...");
                return Promise.all([detectEnv(), refreshInventory(), fetchRegistry(), healthCheck()]);
            })
            .catch(function (ex) {
                console.error("Crewmate startup failed:", ex);
                Log.add("crewmate", "startup failed: " + errorText(ex), "error");
                App.alerts.inline("installed-alert", "danger", "Crewmate couldn't start", errorText(ex));
            })
            .then(function () {
                if (state.config)
                    setLoaded();
                else
                    document.getElementById("installed-table").replaceChildren();
                return runHealthChecks();
            });
}());
