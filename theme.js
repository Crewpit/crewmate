(function () {
    "use strict";

    // Mirrors the shell's own dark/light theme logic. Lives in its own file since Cockpit's default CSP blocks inline <script> blocks.

    function setTheme(el, dark) {
        el.classList.toggle("pf-v6-theme-dark", !!dark);
    }

    function apply(pref) {
        var mode = pref || localStorage.getItem("shell:style") || "auto";
        var osDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        var dark = (osDark && mode === "auto") || mode === "dark";
        setTheme(document.documentElement, dark);
    }

    window.addEventListener("storage", function (e) {
        if (e.key === "shell:style") apply();
    });
    window.addEventListener("cockpit-style", function (e) {
        apply(e instanceof CustomEvent ? e.detail && e.detail.style : undefined);
    });
    if (window.matchMedia) {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
            apply();
        });
    }

    apply();
}());
