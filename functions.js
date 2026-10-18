// ------------------------------------------------------------------
// functions.js: reusable building blocks, exposed as window.App.
// Loaded after cockpit.js and before index.js (see index.html).
//
//   App.el(tag, attrs, children)      tiny DOM builder (textContent only)
//   App.uuid.v4() / .fromBytes(bytes) UUIDv4 that works over http:// too
//   App.clipboard.copy(text)          copy with a non-HTTPS fallback
//   App.poll(fn, ms)                  visibility-aware polling loop
//   App.alerts.inline(...) / .toast() PatternFly inline + toast alerts
//   App.run(args, opts)               cockpit.spawn with busy state + alerts
//   App.modals.open / notice / confirm / changeList
//   App.settings.form(opts)           form -> diff -> "Applying changes" modal
//   App.table.create(opts)            sortable PatternFly table
//   App.menu.mount(MENU, opts)        the in-page menu bar + hash router
//   App.manifest.entry()              this page's manifest.json entry (label...)
//   App.widgets                       tabs + expandable sections from data-attributes
//
// Every section below starts with its options and a usage example.
// ------------------------------------------------------------------

(function () {
    "use strict";

    var App = {};

    // ------------------------------------------------------------------
    // App.el(tag, attrs, children)
    //
    // attrs: "text" sets textContent, "class" sets className, anything else
    // is setAttribute. children: array of Nodes. Never parses HTML.
    //
    //   App.el("p", { class: "note", text: "Hello" })
    // ------------------------------------------------------------------
    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            if (k === "text")
                node.textContent = attrs[k];
            else if (k === "class")
                node.className = attrs[k];
            else
                node.setAttribute(k, attrs[k]);
        });
        (children || []).forEach(function (c) {
            node.appendChild(c);
        });
        return node;
    }
    App.el = el;

    // string | Node | array of those -> array of Nodes (strings become <p>)
    function toNodes(content) {
        if (content === undefined || content === null)
            return [];
        return [].concat(content).map(function (c) {
            return typeof c === "string" ? el("p", { text: c }) : c;
        });
    }

    function byId(elOrId) {
        return typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
    }

    function errorText(ex) {
        return (ex && (ex.message || ex.problem)) || String(ex);
    }

    // ------------------------------------------------------------------
    // App.uuid
    //
    // Not crypto.randomUUID(): it only exists in secure contexts (HTTPS or
    // localhost), and Cockpit is often reached over plain http://.
    // getRandomValues works in both.
    //
    //   App.uuid.v4()                    -> "3f1c...-4...-..."
    //   App.uuid.fromBytes(sixteenBytes) -> same format, from your own bytes
    //                                       (e.g. read from /dev/urandom)
    // ------------------------------------------------------------------
    App.uuid = {
        fromBytes: function (bytes) {
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;

            var hex = Array.prototype.map.call(bytes, function (b) {
                return b.toString(16).padStart(2, "0");
            }).join("");
            return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
                hex.slice(16, 20), hex.slice(20, 32)].join("-");
        },
        v4: function () {
            return App.uuid.fromBytes(crypto.getRandomValues(new Uint8Array(16)));
        },
    };

    // ------------------------------------------------------------------
    // App.clipboard.copy(text) -> Promise
    //
    // Uses navigator.clipboard when allowed, otherwise execCommand("copy")
    // (navigator.clipboard doesn't exist over plain http://, and can be
    // refused on https://). Must be called from a click handler.
    //
    //   App.clipboard.copy(value)
    //       .then(function () { App.alerts.toast("success", "Copied") })
    //       .catch(function () { App.alerts.toast("danger", "Copy failed") });
    // ------------------------------------------------------------------
    App.clipboard = {
        copy: function (text) {
            if (window.isSecureContext && navigator.clipboard)
                return navigator.clipboard.writeText(text).catch(function () {
                    return legacyCopy(text);
                });
            return legacyCopy(text);
        },
    };

    // Deprecated, but the only option on non-secure pages.
    function legacyCopy(text) {
        return new Promise(function (resolve, reject) {
            var ta = el("textarea", { readonly: "", "aria-hidden": "true" });
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            var ok = false;
            try {
                ok = document.execCommand("copy");
            } catch (ex) {
                ok = false;
            }
            document.body.removeChild(ta);
            if (ok)
                resolve();
            else
                reject(new Error("copy command was rejected"));
        });
    }

    // ------------------------------------------------------------------
    // App.poll(fn, intervalMs) -> { refresh, stop }
    //
    // Use this instead of window.setInterval() for anything that refreshes
    // on a timer (cockpit.spawn / cockpit.file / cockpit.dbus calls).
    //
    // Why: Cockpit's shell keeps every visited page's iframe alive, and a
    // plain setInterval keeps firing while you're on another page or the
    // browser tab is in the background. That steady background work gets the
    // tab throttled/frozen by the browser; a frozen tab misses the shell's
    // 30s transport health check and the whole session drops with
    // "Disconnected: Connection has timed out." (Reconnect + log in again).
    //
    // What it does:
    //   - pauses while cockpit.hidden is true (background browser tab OR the
    //     shell showing another page) and resumes when shown again, running
    //     fn right away only if the data is older than intervalMs
    //   - arms the next run only after the previous one has finished, so a
    //     slow run never overlaps with the next one
    //   - single-flight: refresh() during a running fn joins it instead of
    //     starting a second batch of channels
    //
    // How to use it:
    //   var poller = App.poll(function () {
    //       return cockpit.spawn(["some", "command"], { superuser: "try" })
    //               .then(render)
    //               .catch(showError);   // handle your own errors in fn
    //   }, 10000);
    //   refreshButton.addEventListener("click", poller.refresh);
    //
    //   - fn MUST return a promise that settles (or a plain value), otherwise
    //     the loop has no way to know when to arm the next run. Never leave
    //     a long-lived channel (e.g. spawn of "tail -f") inside fn; open
    //     those once, outside the poller.
    //   - Don't pick intervals below a few seconds - each run usually opens
    //     several channels to the bridge.
    //   - One poller per data source. It doesn't know about in-page panes:
    //     start it in a MENU page's onShow and stop() it in onHide (see the
    //     Process Table demo in index.js).
    // ------------------------------------------------------------------
    App.poll = function (fn, intervalMs) {
        var timer = null;
        var inFlight = null;
        var lastRunAt = 0;
        var stopped = false;

        function refresh() {
            if (!inFlight) {
                var done = function () { inFlight = null; lastRunAt = Date.now() };
                inFlight = Promise.resolve().then(fn).then(done, done);
            }
            return inFlight;
        }

        function schedule(delay) {
            window.clearTimeout(timer);
            timer = null;
            if (stopped || cockpit.hidden)
                return;
            timer = window.setTimeout(function () {
                timer = null;
                refresh().then(function () { schedule(intervalMs) });
            }, delay);
        }

        function onVisibilityChange() {
            if (cockpit.hidden) {
                schedule(); // clears the pending timer; no new one while hidden
                return;
            }
            var age = Date.now() - lastRunAt;
            if (age >= intervalMs)
                refresh().then(function () { schedule(intervalMs) });
            else
                schedule(intervalMs - age);
        }

        cockpit.addEventListener("visibilitychange", onVisibilityChange);
        refresh().then(function () { schedule(intervalMs) });

        return {
            refresh: refresh,
            stop: function () {
                stopped = true;
                window.clearTimeout(timer);
                timer = null;
                cockpit.removeEventListener("visibilitychange", onVisibilityChange);
            },
        };
    };

    // ------------------------------------------------------------------
    // App.alerts
    //
    //   inline(container, variant, title, description)
    //       Replaces container's content with one PatternFly inline alert.
    //       A falsy title just clears it. Returns the alert element.
    //   toast(variant, title, opts) -> { close }
    //       Stacks a toast in the bottom-right corner (bottom so it never
    //       covers the menu bar). opts: description, timeout (ms, default
    //       8000; 0 = stays until closed), onClose.
    //
    //   variant: "success" | "danger" | "warning" | "info" | "custom"
    //
    //   App.alerts.inline("settings-alert", "danger", "Save failed", ex.message);
    //   App.alerts.inline("settings-alert");          // clear
    //   App.alerts.toast("success", "Saved", { description: "3 settings changed" });
    // ------------------------------------------------------------------
    var ALERT_ICONS = { success: "✓", danger: "!", warning: "!", info: "i", custom: "•" };

    function buildAlert(variant, title, description, extraClass, onClose) {
        variant = ALERT_ICONS[variant] ? variant : "info";
        var children = [
            el("div", { class: "pf-v6-c-alert__icon app-alert__icon", "aria-hidden": "true", text: ALERT_ICONS[variant] }),
            el("p", { class: "pf-v6-c-alert__title" }, [
                el("span", { class: "pf-v6-screen-reader", text: variant + " alert: " }),
                document.createTextNode(title),
            ]),
        ];
        if (onClose) {
            var x = el("button", { class: "pf-v6-c-button pf-m-plain", type: "button", "aria-label": "Close alert" },
                       [el("span", { text: "×" })]);
            x.addEventListener("click", onClose);
            children.push(el("div", { class: "pf-v6-c-alert__action" }, [x]));
        }
        if (description)
            children.push(el("div", { class: "pf-v6-c-alert__description" }, toNodes(description)));
        return el("div", { class: "pf-v6-c-alert pf-m-" + variant + " " + (extraClass || ""), "aria-label": variant + " alert" }, children);
    }

    var toastGroup = null;

    App.alerts = {
        inline: function (container, variant, title, description) {
            container = byId(container);
            container.replaceChildren();
            if (!title)
                return null;
            var alert = buildAlert(variant, title, description, "pf-m-inline");
            container.appendChild(alert);
            return alert;
        },
        toast: function (variant, title, opts) {
            opts = opts || {};
            if (!toastGroup || !toastGroup.isConnected) {
                toastGroup = el("ul", { class: "pf-v6-c-alert-group pf-m-toast app-toasts", role: "list", "aria-live": "polite" });
                document.body.appendChild(toastGroup);
            }
            var timer = null;
            var li = el("li", { class: "pf-v6-c-alert-group__item" });

            function close() {
                window.clearTimeout(timer);
                if (!li.isConnected)
                    return;
                li.remove();
                if (opts.onClose)
                    opts.onClose();
            }

            li.appendChild(buildAlert(variant, title, opts.description, "", close));
            toastGroup.appendChild(li);
            var timeout = opts.timeout === undefined ? 8000 : opts.timeout;
            if (timeout > 0)
                timer = window.setTimeout(close, timeout);
            return { close: close };
        },
    };

    // ------------------------------------------------------------------
    // App.run(args, opts) -> Promise<output | null>
    //
    // cockpit.spawn that marks a button busy while running and reports the
    // result as a toast or inline alert.
    //
    // opts:
    //   superuser     passed to cockpit.spawn ("try" | "require"); default none
    //   spawn         extra cockpit.spawn options (err, environ, directory...)
    //   button        element to disable + mark busy while running
    //   busyLabel     text to show on the button while running
    //   alert         container (element/id) for an inline alert; default: toast
    //   success       string or function(output) -> string; omit = no message
    //   failure       title for the error message (default "Command failed")
    //   throw         true = reject on failure. Default: report it and resolve
    //                 null, since an uncaught rejection shows Cockpit's "Ooops!"
    //
    //   App.run(["systemctl", "restart", "foo"], {
    //       superuser: "require",
    //       button: restartBtn, busyLabel: "Restarting...",
    //       success: "foo restarted",
    //   });
    //
    //   App.run(["hostname"], { success: function (out) { return "Host: " + out.trim() } });
    // ------------------------------------------------------------------
    App.run = function (args, opts) {
        opts = opts || {};
        var button = byId(opts.button);
        var oldLabel = null;
        if (button) {
            button.disabled = true;
            button.setAttribute("aria-busy", "true");
            button.classList.add("app-is-busy");
            if (opts.busyLabel) {
                oldLabel = button.textContent;
                button.textContent = opts.busyLabel;
            }
        }

        function report(variant, title, description) {
            if (opts.alert)
                App.alerts.inline(opts.alert, variant, title, description);
            else
                App.alerts.toast(variant, title, { description: description });
        }

        function restore() {
            if (!button)
                return;
            button.disabled = false;
            button.removeAttribute("aria-busy");
            button.classList.remove("app-is-busy");
            if (oldLabel !== null)
                button.textContent = oldLabel;
        }

        var spawnOpts = Object.assign({ err: "message" }, opts.spawn || {});
        if (opts.superuser)
            spawnOpts.superuser = opts.superuser;

        return cockpit.spawn(args, spawnOpts)
                .then(function (output) {
                    restore();
                    if (opts.success)
                        report("success", typeof opts.success === "function" ? opts.success(output) : opts.success);
                    return output;
                }, function (ex) {
                    restore();
                    console.error("App.run failed:", args, ex);
                    report("danger", opts.failure || "Command failed", errorText(ex));
                    if (opts.throw)
                        throw ex;
                    return null;
                });
    };

    // ------------------------------------------------------------------
    // App.modals
    //
    //   open(opts)       bare modal shell; everything is up to you
    //   notice(opts)     no action buttons, closes itself on a countdown
    //   confirm(opts)    action buttons that each run a callback
    //   changeList(changes)  <ul> of "Label: old → new" lines for a modal body.
    //                        changes: [{ label, before, after }]
    //
    // Every open/notice/confirm returns a controller:
    //   close()            closes it (runs onClose once, on any close path)
    //   setTitle(text)     replaces the title
    //   setStatus(text)    sets the highlighted status line in the body
    //                      (empty string hides it; announced to screen readers)
    //   isOpen()           false once closed
    //   box                the .pf-v6-c-modal-box element, for anything custom
    // notice() adds:
    //   setSeconds(n)      restarts the countdown from n
    //
    // `body` accepts a string, a DOM node, or an array of either; strings
    // become <p> elements via textContent (never parsed as HTML).
    //
    // Examples:
    //
    // Notice that closes after 30s, flipped to "done" when real work finishes:
    //
    //   var n = App.modals.notice({
    //       title: "Applying changes",
    //       body: "Restarting the service...",
    //       seconds: 30,
    //   });
    //   cockpit.spawn(["systemctl", "restart", "foo"], { superuser: "require" })
    //           .then(function () {
    //               n.setTitle("Changes applied");
    //               n.setStatus("The service restarted.");
    //           })
    //           .catch(function (ex) { n.setStatus("Failed: " + ex.message) });
    //
    // Notice with no X and no Escape (user must wait), plus a timeout callback:
    //
    //   App.modals.notice({
    //       title: "Rebooting",
    //       body: "Please wait.",
    //       seconds: 15,
    //       closable: false,
    //       onTimeout: function () { location.reload() },
    //   });
    //
    // Classic confirm: Cancel just closes, Delete runs the work then closes:
    //
    //   App.modals.confirm({
    //       title: "Delete host?",
    //       body: "This removes \"router1\" permanently.",
    //       buttons: [
    //           { label: "Delete", variant: "danger", action: function (m) { deleteHost(); m.close() } },
    //           { label: "Cancel", variant: "link", action: function (m) { m.close() } },
    //       ],
    //       focus: 1, // Cancel, so a stray Enter is harmless
    //   });
    //
    // Confirm that stays open and reports progress in its status line:
    //
    //   App.modals.confirm({
    //       title: "Run test?",
    //       body: "Runs the self-test on the server.",
    //       buttons: [{
    //           label: "Run", variant: "primary",
    //           action: function (m) {
    //               m.setStatus("Running...");
    //               return cockpit.spawn(["/usr/bin/selftest"])
    //                       .then(function () { m.setStatus("Passed") },
    //                             function (ex) { m.setStatus("Failed: " + ex.message) });
    //           },
    //       }],
    //   });
    //   (While a returned promise is pending, that modal's buttons are disabled.)
    //
    // Fully custom content with the bare shell:
    //
    //   var input = App.el("input", { class: "pf-v6-c-form-control" });
    //   var save = App.el("button", { class: "pf-v6-c-button pf-m-primary", text: "Save" });
    //   var m = App.modals.open({ title: "Rename", body: input, footer: [save] });
    //   save.addEventListener("click", function () { rename(input.value); m.close() });
    // ------------------------------------------------------------------

    var BUTTON_VARIANTS = ["primary", "secondary", "danger", "link", "plain", "tertiary"];

    // opts:
    //   title       string (required)
    //   body        string | Node | array; main content
    //   footer      Node | array; footer content (buttons, countdown, ...)
    //   closable    show the X and allow Escape (default true)
    //   size        "sm" | "md" | "lg" (default "md")
    //   onClose     function(), runs once on any close path
    function openModal(opts) {
        var closable = opts.closable !== false;
        var size = opts.size || "md";

        var titleText = el("span", { class: "pf-v6-c-modal-box__title-text", text: opts.title });
        var status = el("p", { class: "app-modal__status", "aria-live": "polite" });
        status.hidden = true;

        var children = [];
        var btnX = null;
        if (closable) {
            btnX = el("button", { class: "pf-v6-c-button pf-m-plain", type: "button", "aria-label": "Close" },
                      [el("span", { text: "×" })]);
            children.push(el("div", { class: "pf-v6-c-modal-box__close" }, [btnX]));
        }
        children.push(
            el("div", { class: "pf-v6-c-modal-box__header" }, [
                el("div", { class: "pf-v6-c-modal-box__title" }, [titleText]),
            ]),
            el("div", { class: "pf-v6-c-modal-box__body" }, toNodes(opts.body).concat([status]))
        );
        var footerNodes = [].concat(opts.footer || []);
        if (footerNodes.length)
            children.push(el("div", { class: "pf-v6-c-modal-box__footer" }, footerNodes));

        var box = el("div", {
            class: "pf-v6-c-modal-box pf-m-" + size + " app-modal",
            role: "dialog", "aria-modal": "true", "aria-label": opts.title,
        }, children);
        var backdrop = el("div", { class: "pf-v6-c-backdrop" }, [el("div", { class: "pf-v6-l-bullseye" }, [box])]);
        var closed = false;

        function close() {
            if (closed)
                return;
            closed = true;
            document.removeEventListener("keydown", onKey);
            if (backdrop.parentNode)
                backdrop.parentNode.removeChild(backdrop);
            if (opts.onClose)
                opts.onClose();
        }

        function onKey(ev) {
            if (ev.key === "Escape" && closable)
                close();
        }

        if (btnX)
            btnX.addEventListener("click", close);
        document.addEventListener("keydown", onKey);
        document.body.appendChild(backdrop);

        return {
            box: box,
            close: close,
            isOpen: function () { return !closed },
            setTitle: function (text) {
                titleText.textContent = text;
                box.setAttribute("aria-label", text);
            },
            setStatus: function (text) {
                status.textContent = text || "";
                status.hidden = !text;
            },
        };
    }

    // opts: everything open() takes (except footer), plus
    //   seconds        countdown length (default 10)
    //   countdownText  function(seconds) -> string (default "Closing in N sec")
    //   onTimeout      function(), runs only when the countdown reaches 0,
    //                  before onClose
    function notice(opts) {
        var seconds = opts.seconds === undefined ? 10 : opts.seconds;
        var countdownText = opts.countdownText || function (n) { return "Closing in " + n + " sec" };
        var timer = null;
        var countdown = el("span", { class: "app-modal__countdown" });

        var modal = openModal(Object.assign({}, opts, {
            footer: [countdown],
            onClose: function () {
                window.clearInterval(timer);
                if (opts.onClose)
                    opts.onClose();
            },
        }));

        function start(n) {
            seconds = n;
            window.clearInterval(timer);
            countdown.textContent = countdownText(seconds);
            timer = window.setInterval(function () {
                seconds -= 1;
                if (seconds > 0) {
                    countdown.textContent = countdownText(seconds);
                    return;
                }
                window.clearInterval(timer);
                if (opts.onTimeout)
                    opts.onTimeout();
                modal.close();
            }, 1000);
        }

        start(seconds);
        modal.setSeconds = start;
        return modal;
    }

    // opts: everything open() takes (except footer), plus
    //   buttons   array of { label, variant, action }
    //               variant: "primary" | "secondary" | "danger" | "link" |
    //                        "tertiary" | "plain" (default "secondary")
    //               action:  function(modal); doesn't close the modal unless
    //                        it calls modal.close(). If it returns a promise,
    //                        all buttons are disabled until it settles.
    //   focus     index of the button to focus on open (default: last one)
    function confirm(opts) {
        var buttons = opts.buttons || [];
        var modal;

        var nodes = buttons.map(function (b) {
            var variant = BUTTON_VARIANTS.indexOf(b.variant) !== -1 ? b.variant : "secondary";
            var btn = el("button", { class: "pf-v6-c-button pf-m-" + variant, type: "button" },
                         [el("span", { text: b.label })]);
            btn.addEventListener("click", function () {
                if (!b.action)
                    return;
                var result = b.action(modal);
                if (result && typeof result.then === "function") {
                    nodes.forEach(function (n) { n.disabled = true });
                    var reenable = function () { nodes.forEach(function (n) { n.disabled = false }) };
                    result.then(reenable, reenable);
                }
            });
            return btn;
        });

        modal = openModal(Object.assign({}, opts, { footer: nodes }));

        var focusIndex = opts.focus === undefined ? nodes.length - 1 : opts.focus;
        if (nodes[focusIndex])
            nodes[focusIndex].focus();

        return modal;
    }

    function changeList(changes) {
        var list = el("ul", { class: "app-changes" });
        changes.forEach(function (c) {
            list.appendChild(el("li", {}, [
                el("span", { text: c.label + ": " }),
                el("span", { class: "app-changes__old", text: c.before }),
                el("span", { class: "app-changes__arrow", text: " → " }),
                el("span", { class: "app-changes__new", text: c.after }),
            ]));
        });
        return list;
    }

    App.modals = { open: openModal, notice: notice, confirm: confirm, changeList: changeList };

    // ------------------------------------------------------------------
    // App.settings.form(opts) -> { reload, values, changes }
    //
    // PatternFly horizontal form from a field list. Apply diffs it against
    // the last loaded/saved values, lists the changes in an App.modals.notice
    // and calls save().
    //
    // opts:
    //   container   element/id to render into (required)
    //   fields      [{ key, label, type, options, placeholder, help }]
    //                 type: "text" (default) | "number" | "checkbox" | "select"
    //                 options (select): ["a", "b"] or [{ value, label }]
    //   load        function() -> values object (or promise of one)
    //   save        function(values, changes) -> promise (or nothing)
    //   applyLabel  default "Apply"
    //   notice      options merged into the notice (title, seconds, ...);
    //               false = no modal, just a success toast
    //
    //   App.settings.form({
    //       container: "my-settings",
    //       fields: [
    //           { key: "hostname", label: "Hostname" },
    //           { key: "verbose", label: "Verbose logging", type: "checkbox" },
    //           { key: "level", label: "Level", type: "select", options: ["low", "high"] },
    //       ],
    //       load: function () {
    //           return cockpit.file("/etc/foo.json", { syntax: JSON }).read();
    //       },
    //       save: function (values) {
    //           return cockpit.file("/etc/foo.json", { syntax: JSON, superuser: "require" }).replace(values);
    //       },
    //   });
    // ------------------------------------------------------------------
    function fmtValue(field, v) {
        if (field.type === "checkbox")
            return v ? "on" : "off";
        return v === "" || v === undefined || v === null ? "(empty)" : String(v);
    }

    App.settings = {
        form: function (opts) {
            var container = byId(opts.container);
            var fields = opts.fields || [];
            var inputs = {};
            var baseline = {};
            var idPrefix = "app-set-" + Math.random().toString(36).slice(2, 8) + "-";

            var alertBox = el("div", { class: "app-settings__alert" });
            var form = el("form", { class: "pf-v6-c-form pf-m-horizontal app-settings", novalidate: "" });

            fields.forEach(function (f) {
                var id = idPrefix + f.key;
                var control;
                var input;
                if (f.type === "checkbox") {
                    input = el("input", { class: "pf-v6-c-check__input", type: "checkbox", id: id });
                    control = el("div", { class: "pf-v6-c-check" }, [
                        input,
                        el("label", { class: "pf-v6-c-check__label", for: id, text: f.help || "" }),
                    ]);
                } else if (f.type === "select") {
                    input = el("select", { id: id });
                    (f.options || []).forEach(function (o) {
                        var opt = typeof o === "string" ? { value: o, label: o } : o;
                        input.appendChild(el("option", { value: opt.value, text: opt.label }));
                    });
                    // PF draws the dropdown caret from this utilities slot.
                    var caret = el("span", { class: "pf-v6-c-form-control__toggle-icon" });
                    caret.insertAdjacentHTML("beforeend",
                        '<svg viewBox="0 0 320 512" width="1em" height="1em" fill="currentColor" aria-hidden="true">' +
                        '<path d="M31.3 192h257.3c17.8 0 26.7 21.5 14.1 34.1L174.1 354.8c-7.8 7.8-20.5 7.8-28.3 0L17.2 226.1C4.6 213.5 13.5 192 31.3 192z"/></svg>');
                    control = el("span", { class: "pf-v6-c-form-control" }, [
                        input,
                        el("span", { class: "pf-v6-c-form-control__utilities" }, [caret]),
                    ]);
                } else {
                    input = el("input", { id: id, type: f.type === "number" ? "number" : "text" });
                    if (f.placeholder)
                        input.placeholder = f.placeholder;
                    control = el("span", { class: "pf-v6-c-form-control" }, [input]);
                }
                inputs[f.key] = input;

                var groupControl = el("div", { class: "pf-v6-c-form__group-control" }, [control]);
                if (f.help && f.type !== "checkbox")
                    groupControl.appendChild(el("div", { class: "pf-v6-c-helper-text" }, [
                        el("div", { class: "pf-v6-c-helper-text__item" }, [
                            el("span", { class: "pf-v6-c-helper-text__item-text", text: f.help }),
                        ]),
                    ]));

                form.appendChild(el("div", { class: "pf-v6-c-form__group" }, [
                    el("div", { class: "pf-v6-c-form__group-label" }, [
                        el("label", { class: "pf-v6-c-form__label", for: id }, [
                            el("span", { class: "pf-v6-c-form__label-text", text: f.label }),
                        ]),
                    ]),
                    groupControl,
                ]));
            });

            var applyBtn = el("button", { class: "pf-v6-c-button pf-m-primary", type: "submit", text: opts.applyLabel || "Apply" });
            var resetBtn = el("button", { class: "pf-v6-c-button pf-m-link", type: "button", text: "Reset" });
            // group-control puts the buttons in the input column of the horizontal form.
            form.appendChild(el("div", { class: "pf-v6-c-form__group pf-m-action" }, [
                el("div", { class: "pf-v6-c-form__group-control" }, [
                    el("div", { class: "pf-v6-c-form__actions" }, [applyBtn, resetBtn]),
                ]),
            ]));

            container.replaceChildren(alertBox, form);

            function read() {
                var values = {};
                fields.forEach(function (f) {
                    var input = inputs[f.key];
                    if (f.type === "checkbox")
                        values[f.key] = input.checked;
                    else if (f.type === "number")
                        values[f.key] = input.value === "" ? "" : Number(input.value);
                    else
                        values[f.key] = f.type === "select" ? input.value : input.value.trim();
                });
                return values;
            }

            function write(values) {
                fields.forEach(function (f) {
                    var v = values[f.key];
                    if (f.type === "checkbox")
                        inputs[f.key].checked = !!v;
                    else
                        inputs[f.key].value = v === undefined || v === null ? "" : v;
                });
            }

            function changes() {
                var now = read();
                var out = [];
                fields.forEach(function (f) {
                    var before = f.type === "checkbox" ? !!baseline[f.key] : (baseline[f.key] === undefined ? "" : baseline[f.key]);
                    if (now[f.key] !== before)
                        out.push({ key: f.key, label: f.label, before: fmtValue(f, before), after: fmtValue(f, now[f.key]) });
                });
                return out;
            }

            function reload() {
                App.alerts.inline(alertBox);
                return Promise.resolve(opts.load ? opts.load() : {})
                        .then(function (values) {
                            baseline = Object.assign({}, values || {});
                            write(baseline);
                        })
                        .catch(function (ex) {
                            App.alerts.inline(alertBox, "danger", "Couldn't load settings", errorText(ex));
                        });
            }

            form.addEventListener("submit", function (ev) {
                ev.preventDefault();
                App.alerts.inline(alertBox);
                var diff = changes();
                if (!diff.length) {
                    App.alerts.inline(alertBox, "info", "No changes to apply");
                    return;
                }
                var values = read();
                var modal = null;
                if (opts.notice !== false) {
                    modal = notice(Object.assign({
                        title: "Applying changes",
                        body: [el("p", { class: "app-settings__heading", text: "Changes:" }), changeList(diff)],
                        seconds: 30,
                    }, opts.notice || {}));
                    modal.setStatus("Saving...");
                }
                applyBtn.disabled = true;
                Promise.resolve()
                        .then(function () { return opts.save ? opts.save(values, diff) : undefined })
                        .then(function () {
                            baseline = values;
                            if (modal) {
                                modal.setTitle("Changes applied");
                                modal.setStatus("Saved.");
                            } else {
                                App.alerts.toast("success", "Changes applied");
                            }
                        }, function (ex) {
                            if (modal)
                                modal.close();
                            App.alerts.inline(alertBox, "danger", "Couldn't apply changes", errorText(ex));
                        })
                        .finally(function () { applyBtn.disabled = false });
            });

            resetBtn.addEventListener("click", function () {
                App.alerts.inline(alertBox);
                write(baseline);
            });

            reload();
            return { reload: reload, values: read, changes: changes };
        },
    };

    // ------------------------------------------------------------------
    // App.table.create(opts) -> { setRows, rows }
    //
    // PatternFly compact table with click-to-sort headers. The sort order
    // survives setRows(), so it can be fed from App.poll.
    //
    // opts:
    //   container   element/id to render into (required)
    //   columns     [{ key, label, numeric, sortable (default true), format, render }]
    //                 numeric: sort as numbers, right-align
    //                 format:  function(value, row) -> string for display
    //                 render:  function(value, row) -> Node or array of Nodes (wins over
    //                          format; use for buttons, labels, links)
    //   sort        { key, dir: "asc" | "desc" } initial sort (optional)
    //   emptyText   shown when there are no rows (default "No data")
    //   caption     optional table caption for screen readers
    //
    //   var t = App.table.create({
    //       container: "proc-table",
    //       columns: [
    //           { key: "pid", label: "PID", numeric: true },
    //           { key: "cmd", label: "Command" },
    //           { key: "cpu", label: "CPU %", numeric: true, format: function (v) { return v.toFixed(1) } },
    //       ],
    //       sort: { key: "cpu", dir: "desc" },
    //   });
    //   t.setRows([{ pid: 1, cmd: "systemd", cpu: 0.1 }, ...]);
    // ------------------------------------------------------------------
    App.table = {
        create: function (opts) {
            var container = byId(opts.container);
            var columns = opts.columns || [];
            var sort = Object.assign({ key: null, dir: "asc" }, opts.sort || {});
            var rows = [];

            var thead = el("thead", { class: "pf-v6-c-table__thead" });
            var tbody = el("tbody", { class: "pf-v6-c-table__tbody" });
            var table = el("table", { class: "pf-v6-c-table pf-m-compact pf-m-grid-md app-table", role: "grid" },
                           (opts.caption ? [el("caption", { class: "pf-v6-c-table__caption", text: opts.caption })] : []).concat([thead, tbody]));
            container.replaceChildren(table);

            function renderHead() {
                var tr = el("tr", { class: "pf-v6-c-table__tr" });
                columns.forEach(function (c) {
                    var th = el("th", { class: "pf-v6-c-table__th", scope: "col" });
                    if (c.numeric)
                        th.classList.add("app-table__num");
                    if (c.sortable === false) {
                        th.textContent = c.label;
                    } else {
                        var selected = sort.key === c.key;
                        th.classList.add("pf-v6-c-table__sort");
                        if (selected) {
                            th.classList.add("pf-m-selected");
                            th.setAttribute("aria-sort", sort.dir === "asc" ? "ascending" : "descending");
                        } else {
                            th.setAttribute("aria-sort", "none");
                        }
                        var btn = el("button", { class: "pf-v6-c-table__button", type: "button" }, [
                            el("div", { class: "pf-v6-c-table__button-content" }, [
                                el("span", { class: "pf-v6-c-table__text", text: c.label }),
                                el("span", { class: "pf-v6-c-table__sort-indicator", "aria-hidden": "true",
                                             text: selected ? (sort.dir === "asc" ? "↑" : "↓") : "↕" }),
                            ]),
                        ]);
                        btn.addEventListener("click", function () {
                            if (sort.key === c.key)
                                sort.dir = sort.dir === "asc" ? "desc" : "asc";
                            else
                                sort = { key: c.key, dir: c.numeric ? "desc" : "asc" };
                            render();
                        });
                        th.appendChild(btn);
                    }
                    tr.appendChild(th);
                });
                thead.replaceChildren(tr);
            }

            function sorted() {
                if (!sort.key)
                    return rows;
                var col = columns.find(function (c) { return c.key === sort.key }) || {};
                var mul = sort.dir === "asc" ? 1 : -1;
                return rows.slice().sort(function (a, b) {
                    var x = a[sort.key];
                    var y = b[sort.key];
                    if (col.numeric)
                        return (Number(x) - Number(y)) * mul;
                    return String(x).localeCompare(String(y), undefined, { numeric: true }) * mul;
                });
            }

            function renderBody() {
                if (!rows.length) {
                    tbody.replaceChildren(el("tr", { class: "pf-v6-c-table__tr" }, [
                        el("td", { class: "pf-v6-c-table__td app-table__empty", colspan: String(columns.length),
                                   text: opts.emptyText || "No data" }),
                    ]));
                    return;
                }
                tbody.replaceChildren.apply(tbody, sorted().map(function (row) {
                    return el("tr", { class: "pf-v6-c-table__tr" }, columns.map(function (c) {
                        var v = row[c.key];
                        var td = el("td", {
                            class: "pf-v6-c-table__td" + (c.numeric ? " app-table__num" : ""),
                            "data-label": c.label,
                        });
                        if (c.render)
                            [].concat(c.render(v, row)).forEach(function (node) { td.appendChild(node) });
                        else
                            td.textContent = c.format ? c.format(v, row) : (v === undefined || v === null ? "" : String(v));
                        return td;
                    }));
                }));
            }

            function render() {
                renderHead();
                renderBody();
            }

            render();
            return {
                setRows: function (newRows) {
                    rows = newRows || [];
                    renderBody();
                },
                rows: function () { return rows },
            };
        },
    };

    // ------------------------------------------------------------------
    // App.manifest.entry(page) -> Promise<entry | null>
    //
    // A package's own manifest.json 404s, but Cockpit serves all of them
    // merged at ../manifests.json. Returns this package's entry for `page`
    // (default: current file name, e.g. "index"), or null.
    //
    //   App.manifest.entry().then(function (e) { document.title = e.label });
    // ------------------------------------------------------------------
    App.manifest = {
        entry: function (page) {
            // .../cockpit/@localhost/<package>/<page>.html
            var parts = location.pathname.split("/");
            var pkg = parts[parts.length - 2];
            page = page || (parts[parts.length - 1] || "index.html").replace(/\.html$/, "");
            return fetch("../manifests.json", { credentials: "same-origin" })
                    .then(function (r) { return r.ok ? r.json() : {} })
                    .then(function (all) {
                        var m = all[pkg] || {};
                        var sections = ["tools", "menu", "dashboard"];
                        for (var i = 0; i < sections.length; i++) {
                            if (m[sections[i]] && m[sections[i]][page])
                                return m[sections[i]][page];
                        }
                        return null;
                    })
                    .catch(function (ex) {
                        console.warn("App.manifest.entry failed:", ex);
                        return null;
                    });
        },
    };

    // ------------------------------------------------------------------
    // App.menu.mount(menu, opts) -> { setExpanded, setLabel, setItems, currentPage }
    //
    // Builds the menu bar (plus a sub-bar per item with children) and runs
    // the hash router. Item fields are documented at MENU in index.js.
    // Without menu.label, the label from manifest.json is used.
    //
    // opts:
    //   nav             element/id of the <nav> to build into (default "app-menu")
    //   startExpanded   whether the menu starts open (default true)
    //
    //   var m = App.menu.mount(MENU, { startExpanded: true });
    //
    // Menus that depend on runtime data (e.g. a saved list) call
    // m.setItems(items) whenever it changes. The bar is rebuilt; the current
    // page keeps its state (onShow/onHide only fire when the route changes,
    // matched by `path`, so rebuilt item objects don't re-trigger them).
    //
    // Extra item fields, for dynamic menus:
    //   href      external URL: opens in a new tab instead of routing
    //   title     tooltip for the item
    //   decorate  function(linkElement, item) run when the item is built
    //             (add a status dot, badge, ...)
    // Several items may share one `pane` (e.g. routes that open a modal over
    // the same pane).
    // ------------------------------------------------------------------
    App.menu = {
        mount: function (menu, opts) {
            opts = opts || {};

            var pages = [];     // items with a path, from both levels
            var top = null;     // makeList() of the top-level items
            var subbars = [];   // [{ parent, nav, links }]
            var spacer = null;  // invisible sub-bar that keeps the sub-bar row on pages without one

            // Hash-based routing: Cockpit's shell passes the URL fragment
            // through to this iframe untouched, so a link to #/debug lands
            // here with location.hash already set on first load.
            function currentPage() {
                // location.hash includes the leading "#"; strip it down to the path.
                var path = location.hash.replace(/^#/, "");
                return pages.find(function (page) { return page.path === path }) || pages[0];
            }

            // The last action item clicked (null after navigating to another page).
            var activeAction = null;
            var shownPage = null;

            function makeLink(item) {
                var link;
                if (item.action) {
                    link = el("button", { class: "app-menubar__item", type: "button", text: item.label });
                    link.addEventListener("click", function () {
                        activeAction = item;
                        render();
                        item.action(link);
                    });
                } else if (item.href) {
                    link = el("a", { class: "app-menubar__item", text: item.label });
                    link.href = item.href;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                } else {
                    link = el("a", { class: "app-menubar__item", text: item.label });
                    link.href = "#" + (item.path !== undefined ? item.path : "");
                    if (item.path === undefined) {
                        // Placeholder: a bare "#" would route to the default page, so stop it.
                        link.classList.add("is-placeholder");
                        link.addEventListener("click", function (ev) { ev.preventDefault() });
                    }
                }
                if (item.title)
                    link.title = item.title;
                if (item.decorate)
                    item.decorate(link, item);
                return link;
            }

            function makeList(items) {
                var list = el("ul", { class: "app-menubar__items" });
                var links = items.map(function (item) {
                    var a = makeLink(item);
                    list.appendChild(el("li", {}, [a]));
                    return { item: item, link: a };
                });
                return { list: list, links: links };
            }

            var nav = byId(opts.nav || "app-menu");
            var labelEl = el("span", { class: "app-menubar__label" });
            var toggle = el("button", { class: "app-menubar__toggle", type: "button", "aria-controls": "app-menu-items" },
                            [labelEl]);
            var collapse = el("div", { class: "app-menubar__collapse" });

            function setLabel(text) {
                labelEl.textContent = text || "";
                labelEl.hidden = !text;
                nav.setAttribute("aria-label", text || "Menu");
            }
            // "|>" when collapsed (expand), "|<" when expanded (hide); CSS picks
            // which one is visible from aria-expanded.
            toggle.insertAdjacentHTML("beforeend",
                '<svg class="app-menubar__glyph" viewBox="0 0 16 16" aria-hidden="true">' +
                '<path class="app-menubar__glyph-expand" d="M3 3v10M7 4l4 4-4 4" />' +
                '<path class="app-menubar__glyph-hide" d="M3 3v10M11 4l-4 4 4 4" />' +
                '</svg>');

            nav.appendChild(toggle);
            nav.appendChild(collapse);

            // Hover/focus preview: the top-level item whose sub-bar is shown
            // without navigating (null = show the current branch's).
            var previewParent = null;
            var previewTimer = null;
            // The sub-bar is a separate element with a gap after the main bar,
            // so leaving the bar must not hide it at once: wait a moment, and
            // cancel if the pointer/focus arrives on the bar or any sub-bar.
            var PREVIEW_CLOSE_DELAY = 250;

            // EXPERIMENT (sub-bar fade): sub-bars fade in and out instead of popping.
            // The bar stays in the layout while it fades and is only hidden once the
            // fade-out has finished. FADE_MS must match --app-submenu-fade in index.css.
            var FADE_MS = 450;
            var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");

            function setSubVisible(sub, show, immediate) {
                if (sub.shown === show)
                    return;
                var first = sub.shown === undefined;
                sub.shown = show;
                clearTimeout(sub.fadeTimer);
                if (first || immediate || (reduceMotion && reduceMotion.matches)) {
                    sub.nav.classList.remove("is-fading");
                    sub.nav.hidden = !show;
                } else if (show) {
                    sub.nav.classList.add("is-fading");     // start transparent...
                    sub.nav.hidden = false;
                    void sub.nav.offsetWidth;                // ...commit that state...
                    sub.nav.classList.remove("is-fading");  // ...then fade in
                } else {
                    sub.nav.classList.add("is-fading");     // fade out, then hide
                    sub.fadeTimer = setTimeout(function () {
                        sub.nav.hidden = true;
                        updateSpacer(); // the row it leaves behind is taken over by the spacer
                    }, FADE_MS);
                }
            }

            // The spacer keeps the sub-bar row on pages without one. It must not appear
            // while a sub-bar that sits in the layout is still fading out, or the page
            // would briefly have two rows.
            function updateSpacer() {
                // A bar fading out while another fades in would stack two rows and push
                // the page down for the length of the fade. Cancel the leaving bar's
                // layout height with a negative margin so the two cross-fade in place.
                var inRow = function (sub) {
                    return !sub.nav.hidden && !sub.nav.classList.contains("is-preview");
                };
                var entering = subbars.some(function (sub) { return sub.shown && inRow(sub); });
                subbars.forEach(function (sub) {
                    var overlap = entering && sub.shown === false && inRow(sub);
                    sub.nav.style.marginBlockEnd = overlap
                        ? -(sub.nav.offsetHeight + parseFloat(window.getComputedStyle(sub.nav).marginTop)) + "px"
                        : "";
                });
                if (!spacer)
                    return;
                var expanded = toggle.getAttribute("aria-expanded") !== "false";
                var rowTaken = subbars.some(function (sub) {
                    return !sub.nav.hidden && !sub.nav.classList.contains("is-preview");
                });
                spacer.hidden = !expanded || rowTaken;
            }

            // Sub-bars sit centered under the top-level item that opens them (kept inside
            // the bar's container), not pinned to the right edge. Measured from the
            // item's real position, so it follows window resizes, the menu expanding
            // and collapsing, and a top bar that scrolls sideways.
            //
            // The shift is applied with `translate`, which moves the bar without touching
            // layout. Using margins or `left` instead would shrink the width the bar may
            // use, make its items wrap, make it narrower, and re-center it again: an
            // endless loop that stacks the items vertically and floods the page with
            // "ResizeObserver loop" errors (which Cockpit reports as "Oops!").
            var EDGE = 16; // fallback gap to the container's edges; normally the bar's own margin is used
            var positionFrame = null;
            var resizeWatch = window.ResizeObserver ? new ResizeObserver(schedulePosition) : null;

            function positionSub(sub) {
                if (sub.nav.hidden || window.getComputedStyle(document.documentElement).direction === "rtl")
                    return; // right-to-left pages keep the stylesheet's alignment
                var entry = top.links.filter(function (e) { return e.item === sub.parent })[0];
                if (!entry)
                    return;
                var st = sub.nav.style;
                var overlay = sub.nav.classList.contains("is-preview");
                // Natural position: left edge of the container plus the bar's own margin.
                st.alignSelf = "flex-start";
                st.left = overlay ? "0px" : "";
                st.right = overlay ? "auto" : "";
                st.translate = "";
                var holder = nav.parentElement;
                // The container's inner edges (inside its border), where the page content starts.
                var outer = holder.getBoundingClientRect();
                var box = { left: outer.left + holder.clientLeft, width: holder.clientWidth };
                box.right = box.left + box.width;
                var bar = sub.nav.getBoundingClientRect();
                var link = entry.link.getBoundingClientRect();
                // Keep the gap the stylesheet gives the bar (it is smaller on narrow windows).
                var edge = parseFloat(window.getComputedStyle(sub.nav).marginLeft);
                if (isNaN(edge))
                    edge = EDGE;
                var want = link.left + link.width / 2 - bar.width / 2; // viewport x of the bar's left edge
                if (bar.width > box.width - 2 * edge)
                    want = box.left + (box.width - bar.width) / 2;     // too wide to clamp: center in the container
                else
                    want = Math.max(box.left + edge, Math.min(want, box.right - bar.width - edge));
                st.translate = Math.round((want - bar.left) * 10) / 10 + "px";
            }

            function positionSubs() {
                subbars.forEach(positionSub);
            }

            // Resize notifications are handled on the next frame, never inside the observer
            // callback, so repositioning can't trigger a "ResizeObserver loop" error.
            function schedulePosition() {
                if (positionFrame !== null)
                    return;
                positionFrame = window.requestAnimationFrame(function () {
                    positionFrame = null;
                    positionSubs();
                });
            }

            function setPreview(parent) {
                clearTimeout(previewTimer);
                if (previewParent === parent)
                    return;
                previewParent = parent;
                render();
            }

            function schedulePreviewClose() {
                clearTimeout(previewTimer);
                if (previewParent === null)
                    return;
                previewTimer = setTimeout(function () { setPreview(null) }, PREVIEW_CLOSE_DELAY);
            }

            function inMenu(node) {
                return !!node && (nav.contains(node) || subbars.some(function (sub) { return sub.nav.contains(node) }));
            }

            // Moving between the bar and a sub-bar (across the gap) cancels the pending close.
            function watchBar(bar) {
                bar.addEventListener("mouseenter", function () { clearTimeout(previewTimer) });
                bar.addEventListener("mouseleave", schedulePreviewClose);
                bar.addEventListener("focusin", function () { clearTimeout(previewTimer) });
                bar.addEventListener("focusout", function (ev) {
                    if (!inMenu(ev.relatedTarget))
                        schedulePreviewClose();
                });
            }
            watchBar(nav);

            // (Re)builds the top bar, the sub-bars and the route table from `items`.
            function build(items) {
                clearTimeout(previewTimer);
                previewParent = null;

                pages = [];
                items.forEach(function (item) {
                    [item].concat(item.children || []).forEach(function (page) {
                        if (page.path !== undefined)
                            pages.push(page);
                    });
                });

                subbars.forEach(function (sub) { sub.nav.remove() });
                subbars = [];
                if (spacer)
                    spacer.remove();
                spacer = null;
                collapse.textContent = "";

                top = makeList(items);
                top.list.id = "app-menu-items";
                top.list.inert = toggle.getAttribute("aria-expanded") === "false";
                top.list.addEventListener("scroll", schedulePosition);
                collapse.appendChild(top.list);

                // Sub-bars, inserted in reverse so they end up in item order after nav.
                items.slice().reverse().forEach(function (item) {
                    if (!item.children || !item.children.length)
                        return;
                    var built = makeList(item.children);
                    var sub = el("nav", { class: "app-submenu", "aria-label": item.label }, [built.list]);
                    sub.hidden = true;
                    nav.after(sub);
                    subbars.unshift({ parent: item, nav: sub, links: built.links });
                    watchBar(sub);
                    if (resizeWatch)
                        resizeWatch.observe(sub);
                });

                // Pages without a sub-bar of their own still reserve its row (an invisible
                // copy of the tallest one), so hovering a top-level item that has children
                // previews its sub-bar in that empty row instead of over the page content.
                if (subbars.length) {
                    var tallest = subbars.reduce(function (a, b) {
                        return b.parent.children.length > a.parent.children.length ? b : a;
                    });
                    spacer = el("nav", { class: "app-submenu is-covered", "aria-hidden": "true" }, [makeList(tallest.parent.children).list]);
                    spacer.inert = true;
                    spacer.hidden = true;
                    nav.after(spacer);
                }

                top.links.forEach(function (entry) {
                    var hasChildren = !!(entry.item.children && entry.item.children.length);
                    function enter() {
                        if (hasChildren)
                            setPreview(entry.item);
                        else
                            schedulePreviewClose(); // childless sibling: fall back to the current branch
                    }
                    entry.link.addEventListener("mouseenter", enter);
                    entry.link.addEventListener("focus", enter);
                });
            }

            // value: "page" for the current page, "true" for the active action item.
            function setCurrent(link, isCurrent, value) {
                if (isCurrent)
                    link.setAttribute("aria-current", value || "page");
                else
                    link.removeAttribute("aria-current");
            }

            function render() {
                var current = currentPage();
                var expanded = toggle.getAttribute("aria-expanded") !== "false";

                // Show the current page's pane; routes may share one.
                pages.forEach(function (page) {
                    if (page.pane)
                        document.getElementById(page.pane).hidden = page.pane !== current.pane;
                });

                // onShow / onHide, only when the route itself changes (matched by
                // path, so a rebuilt menu doesn't re-trigger them).
                var changed = !shownPage || shownPage.path !== current.path;
                if (changed && shownPage && shownPage.onHide)
                    shownPage.onHide();
                shownPage = current;
                if (changed && current.onShow)
                    current.onShow();

                // A top-level item stays highlighted while one of its children is open.
                top.links.forEach(function (entry) {
                    var children = entry.item.children || [];
                    var isCurrent = entry.item === current || children.indexOf(current) !== -1;
                    setCurrent(entry.link, isCurrent);
                    // Keep the active item visible when the bar scrolls sideways.
                    if (isCurrent && changed && entry.link.scrollIntoView)
                        entry.link.scrollIntoView({ block: "nearest", inline: "nearest" });
                });

                subbars.forEach(function (sub) {
                    var inBranch = sub.parent === current || sub.parent.children.indexOf(current) !== -1;
                    // A hovered/focused top-level item previews its own sub-bar
                    // as an overlay (no layout shift). The current branch's bar
                    // stays in flow but invisible, so its row keeps its height.
                    var previewing = previewParent !== null && sub.parent === previewParent;
                    var overlay = previewing && !inBranch;
                    var covered = previewParent !== null && inBranch && !previewing;
                    var show = expanded && (inBranch || previewing);
                    // While fading out, the bar keeps the geometry it had (floating overlay
                    // or in the layout). Re-evaluating it here would turn a floating
                    // preview into a layout row mid-fade and push the page down.
                    var fadingOut = !show && expanded && !sub.nav.hidden;
                    if (!fadingOut) {
                        sub.nav.classList.toggle("is-preview", overlay);
                        sub.nav.classList.toggle("is-covered", covered);
                        // Absolute offsets are relative to the main container: sit right under the main bar.
                        sub.nav.style.top = overlay ? (nav.offsetTop + nav.offsetHeight) + "px" : "";
                    }
                    setSubVisible(sub, show, !expanded); // collapsing the whole menu hides at once: no row left fading
                    sub.links.forEach(function (entry) {
                        if (entry.item.action)
                            setCurrent(entry.link, entry.item === activeAction, "true");
                        else
                            setCurrent(entry.link, entry.item === current);
                    });
                    positionSub(sub); // last: the current-item dot changes the bar's width
                });
                updateSpacer();
            }

            function setExpanded(expanded) {
                nav.classList.toggle("is-collapsed", !expanded);
                toggle.setAttribute("aria-expanded", String(expanded));
                toggle.title = expanded ? "Hide menu" : "Show menu";
                // inert keeps collapsed links out of the tab order and screen readers.
                top.list.inert = !expanded;
                render(); // shows/hides the sub-bar along with the menu
            }

            function setItems(items) {
                build(items);
                render();
            }

            toggle.addEventListener("click", function () {
                setExpanded(toggle.getAttribute("aria-expanded") !== "true");
            });
            window.addEventListener("hashchange", function () {
                activeAction = null;
                render();
            });

            // Re-center the sub-bars whenever the bar, its container or a sub-bar itself
            // changes size (window resize, menu expand/collapse animation, web font loading).
            if (resizeWatch) {
                resizeWatch.observe(nav);
                resizeWatch.observe(nav.parentElement);
            } else {
                window.addEventListener("resize", schedulePosition);
            }

            build(menu.items);
            setExpanded(opts.startExpanded !== false);

            if (menu.label) {
                setLabel(menu.label);
            } else {
                setLabel("");
                App.manifest.entry().then(function (entry) {
                    setLabel(entry && entry.label ? entry.label : "Menu");
                });
            }

            return { setExpanded: setExpanded, setLabel: setLabel, setItems: setItems, currentPage: currentPage };
        },
    };

    // ------------------------------------------------------------------
    // App.widgets: behaviour for the static PatternFly markup that needs a
    // little JS. One delegated click listener, so it also works for panes
    // added later. Nothing to call; it is active as soon as functions.js loads.
    //
    //   Tabs: wrap the tab list and its panels in an element with
    //   `data-app-tabs`; each tab button carries `data-app-tab="<panel id>"`.
    //   The clicked tab gets `pf-m-current` / aria-selected, its panel is
    //   shown and the others are hidden.
    //
    //   Expandable section: the toggle button carries
    //   `data-app-expand="<content id>"`; the section element (its parent)
    //   gets `pf-m-expanded` and the content's `hidden` flips.
    //   Optional `data-app-text-expanded="Show Less"` on the toggle swaps its
    //   text while open; the markup's own text is restored when closed.
    //
    // See Elements -> Navigation in index.html for the markup.
    // ------------------------------------------------------------------
    App.widgets = {};

    document.addEventListener("click", function (ev) {
        var tab = ev.target.closest("[data-app-tab]");
        if (tab) {
            var root = tab.closest("[data-app-tabs]");
            if (root) {
                root.querySelectorAll("[data-app-tab]").forEach(function (t) {
                    var on = t === tab;
                    t.setAttribute("aria-selected", on ? "true" : "false");
                    t.parentElement.classList.toggle("pf-m-current", on);
                    var panel = document.getElementById(t.getAttribute("data-app-tab"));
                    if (panel)
                        panel.hidden = !on;
                });
            }
            return;
        }
        var exp = ev.target.closest("[data-app-expand]");
        if (exp) {
            var open = exp.getAttribute("aria-expanded") !== "true";
            exp.setAttribute("aria-expanded", open ? "true" : "false");
            exp.parentElement.classList.toggle("pf-m-expanded", open);
            var content = document.getElementById(exp.getAttribute("data-app-expand"));
            if (content)
                content.hidden = !open;
            var openText = exp.getAttribute("data-app-text-expanded");
            var label = exp.querySelector(".pf-v6-c-expandable-section__toggle-text");
            if (openText && label) {
                if (exp.dataset.appTextCollapsed === undefined)
                    exp.dataset.appTextCollapsed = label.textContent;
                label.textContent = open ? openText : exp.dataset.appTextCollapsed;
            }
        }
    });

    window.App = App;
}());
