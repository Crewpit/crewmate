#!/bin/sh
# crewmate.sh: host-side helper for the Crewmate Cockpit page (POSIX sh).
#
# stdout carries "@log <stage> <message>" progress lines and
# "@kv <key> <value>" results for index.js; anything else is raw tool output.
#
# Environment (set by index.js):
#   CREWMATE_DRY     1 = dry run, everything under CREWMATE_ROOT; 0 = live (root)
#   CREWMATE_ROOT    fake root for dry runs (default /tmp/crewmate-dryroot)
#   CREWMATE_METHOD  auto | git | curl | wget | openssl | devtcp
#
# Subcommands: env, check, init, get, fetch, mkstage, unpack, probe, pkgcheck,
#              install, uninstall, list, cleanup, cleanup-all

set -u
LC_ALL=C
export LC_ALL

DRY="${CREWMATE_DRY:-1}"
if [ "$DRY" = 1 ]; then
    ROOT="${CREWMATE_ROOT:-/tmp/crewmate-dryroot}"
else
    DRY=0
    ROOT=""
fi
METHOD="${CREWMATE_METHOD:-auto}"
case $METHOD in
    auto|git|curl|wget|openssl|devtcp) ;;
    *) METHOD=auto ;;
esac
PKGDIR="$ROOT/usr/share/cockpit"
ETCDIR="$ROOT/etc/cockpit"
# Outside the package dir: Cockpit would load a backup folder there as a package.
BAKDIR="$ROOT/var/lib/crewmate/backup"

log() { _s=$1; shift; printf '@log %s %s\n' "$_s" "$*"; }
kv() { printf '@kv %s %s\n' "$1" "$2"; }
die() { log error "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

valid_name() {
    case $1 in
        ''|.*|*[!A-Za-z0-9._+-]*) die "invalid name: '$1'" ;;
    esac
}

valid_stage() {
    case $1 in
        /tmp/crewmate.??????|/tmp/crewmate.??????/*) ;;
        *) die "not a crewmate stage path: '$1'" ;;
    esac
    case $1 in *..*) die "refusing path with '..': '$1'" ;; esac
}

# Dry run: the fake root must be a real directory under /tmp that we own
# (guards against a planted symlink). Live: must be root.
check_root() {
    if [ "$DRY" = 0 ]; then
        [ "$(id -u)" = 0 ] || die "installing system-wide needs administrative access (run as root / turn on admin access in Cockpit)"
        return 0
    fi
    case $ROOT in
        /tmp/?*) ;;
        *) die "dry root must be under /tmp, got '$ROOT'" ;;
    esac
    case $ROOT in *..*) die "dry root may not contain '..'" ;; esac
    [ -L "$ROOT" ] && die "$ROOT is a symlink; refusing to use it"
    if [ -e "$ROOT" ] && [ ! -O "$ROOT" ]; then
        die "$ROOT is owned by another user; refusing to use it"
    fi
}

# The legacy name is still recognised for listing, upgrading and removing.
PREFLIGHT=preflight.json
LEGACY_PREFLIGHT=pre.flight

pf_file() {
    if [ -e "$1/$PREFLIGHT" ]; then
        echo "$1/$PREFLIGHT"
    elif [ -e "$1/$LEGACY_PREFLIGHT" ]; then
        echo "$1/$LEGACY_PREFLIGHT"
    fi
}

is_crewpit() { [ -n "$(pf_file "$1")" ]; }

pf_version() {
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}

new_stage() {
    STAGE=$(mktemp -d /tmp/crewmate.XXXXXX) || die "mktemp failed"
    chmod 700 "$STAGE"
    log stage "created stage dir $STAGE (mode 700, random name)"
    kv stage "$STAGE"
}

# Raw HTTP/1.0 for hosts without curl/wget. HTTP/1.0 avoids chunked encoding,
# so the body is everything after the blank line. Redirects are followed by hand.
send_request() {
    printf 'GET %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: crewmate\r\nAccept: */*\r\nConnection: close\r\n\r\n' "$1" "$2"
}

raw_get() {
    _ru=$1 _out=$2 _how=$3 _hops=${4:-0}
    [ "$_hops" -gt 5 ] && { log fetch "too many redirects"; return 1; }

    case $_ru in
        https://*) _scheme=https _rest=${_ru#https://} _port=443 ;;
        http://*) _scheme=http _rest=${_ru#http://} _port=80 ;;
        *) log fetch "unsupported URL scheme: $_ru"; return 1 ;;
    esac
    _hostport=${_rest%%/*}
    if [ "$_hostport" = "$_rest" ]; then _path=/; else _path=/${_rest#*/}; fi
    _host=${_hostport%%:*}
    [ "$_host" != "$_hostport" ] && _port=${_hostport#*:}

    _resp="$_out.http"
    if [ "$_how" = openssl ]; then
        if [ "$_scheme" != https ]; then
            log fetch "openssl tier is only used for https:// (this URL is $_scheme)"
            return 1
        fi
        have openssl || { log fetch "openssl not found"; return 1; }
        log fetch "openssl s_client -connect $_host:$_port (certificate + hostname verified), sending: GET $_path HTTP/1.0"
        send_request "$_path" "$_host" |
            openssl s_client -quiet -verify_return_error -verify_hostname "$_host" -connect "$_host:$_port" -servername "$_host" >"$_resp" 2>/dev/null
    else
        if [ "$_scheme" != http ]; then
            log fetch "bash /dev/tcp can't do TLS; it only works for plain http:// sources"
            return 1
        fi
        have bash || { log fetch "bash not found (needed for /dev/tcp)"; return 1; }
        log fetch "bash /dev/tcp/$_host/$_port, sending: GET $_path HTTP/1.0 (no TLS)"
        # shellcheck disable=SC2016
        send_request "$_path" "$_host" |
            bash -c 'exec 3<>"/dev/tcp/$1/$2" || exit 1; cat >&3; cat <&3' _ "$_host" "$_port" >"$_resp"
    fi

    [ -s "$_resp" ] || { log fetch "empty response (connection refused, or TLS certificate/hostname verification failed)"; rm -f "$_resp"; return 1; }

    _status=$(head -n 1 "$_resp" | tr -d '\r')
    log fetch "response: $_status"
    case $_status in
        "HTTP/1."?" 2"*) ;;
        "HTTP/1."?" 30"[1278]*)
            _loc=$(sed -n '2,/^\r*$/p' "$_resp" | tr -d '\r' | sed -n 's/^[Ll][Oo][Cc][Aa][Tt][Ii][Oo][Nn]: *//p' | head -n 1)
            rm -f "$_resp"
            [ -n "$_loc" ] || { log fetch "redirect without a Location header"; return 1; }
            case $_loc in /*) _loc="$_scheme://$_hostport$_loc" ;; esac
            log fetch "redirect -> $_loc"
            raw_get "$_loc" "$_out" "$_how" $((_hops + 1))
            return $?
            ;;
        *) rm -f "$_resp"; return 1 ;;
    esac

    # Header length in bytes (LC_ALL=C makes ${#} count bytes).
    _n=0
    while IFS= read -r _line; do
        _n=$((_n + ${#_line} + 1))
        [ -z "$(printf '%s' "$_line" | tr -d '\r')" ] && break
    done <"$_resp"
    tail -c +$((_n + 1)) "$_resp" >"$_out"
    rm -f "$_resp"
    log fetch "body: $(wc -c <"$_out" | tr -d ' ') bytes after stripping $_n header bytes"
    return 0
}

http_get() {
    _u=$1 _o=$2
    for _hm in $(methods_for_file); do
        case $_hm in
            curl)
                have curl || { log fetch "curl: not installed, next"; continue; }
                log fetch "curl -fsSL -o $_o $_u"
                curl -fsSL -o "$_o" "$_u" && { kv method curl; return 0; }
                log fetch "curl failed"
                ;;
            wget)
                have wget || { log fetch "wget: not installed, next"; continue; }
                log fetch "wget -q -O $_o $_u"
                wget -q -O "$_o" "$_u" && { kv method wget; return 0; }
                log fetch "wget failed"
                ;;
            openssl|devtcp)
                raw_get "$_u" "$_o" "$_hm" && { kv method "$_hm"; return 0; }
                log fetch "$_hm failed"
                ;;
        esac
    done
    return 1
}

methods_for_file() {
    case $METHOD in
        auto) echo "curl wget openssl devtcp" ;;
        git) echo "curl wget openssl devtcp" ;;  # git can't fetch a single file
        *) echo "$METHOD" ;;
    esac
}

methods_for_pkg() {
    case $METHOD in
        auto) echo "git curl wget openssl devtcp" ;;
        *) echo "$METHOD" ;;
    esac
}

archive_url() {
    _u=${1%/}
    _r=${2:-HEAD}
    case $_u in
        *.tar.gz|*.tgz|*.zip) echo "$_u"; return 0 ;;
    esac
    _u=${_u%.git}
    case $_u in
        https://github.com/*/*)
            _p=${_u#https://github.com/}
            echo "https://codeload.github.com/$_p/tar.gz/$_r"
            ;;
        http*://*gitlab*/*/*)
            echo "$_u/-/archive/$_r/${_u##*/}-$_r.tar.gz"
            ;;
        *) return 1 ;;
    esac
}

# Unpack into <dest>, dropping a single wrapping folder ("repo-main/" etc.).
unpack() {
    _a=$1 _dest=$2
    _x="$(dirname "$_a")/.unpack.$$"
    rm -rf "$_x"
    mkdir -p "$_x"

    _magic=$(head -c 4 "$_a" | od -An -tx1 | tr -d ' \n')
    case $_magic in
        1f8b*)
            log unpack "gzip'd tar detected -> gzip -dc | tar -xf -"
            gzip -dc "$_a" | tar -xf - -C "$_x" || { log unpack "tar failed"; return 1; }
            ;;
        504b0304*)
            log unpack "zip detected"
            if have unzip; then
                log unpack "unzip -q $_a -d $_x"
                unzip -q "$_a" -d "$_x"
            elif have python3; then
                log unpack "no unzip, using python3 -m zipfile -e"
                python3 -m zipfile -e "$_a" "$_x"
            elif have busybox && busybox unzip >/dev/null 2>&1; then
                log unpack "no unzip/python3, using busybox unzip"
                busybox unzip -q "$_a" -d "$_x"
            elif have bsdtar; then
                log unpack "no unzip/python3/busybox, using bsdtar"
                bsdtar -xf "$_a" -C "$_x"
            else
                log unpack "no zip extractor available (tried unzip, python3, busybox unzip, bsdtar)"
                false
            fi || { log unpack "unzip failed"; return 1; }
            ;;
        *)
            log unpack "unknown archive format (magic: $_magic)"
            return 1
            ;;
    esac

    # shellcheck disable=SC2012
    _count=$(ls -A "$_x" | wc -l | tr -d ' ')
    _only=$(ls -A "$_x" | head -n 1)
    if [ "$_count" = 1 ] && [ -d "$_x/$_only" ]; then
        log unpack "flattening wrapper folder '$_only/'"
        mv "$_x/$_only" "$_dest"
        rmdir "$_x"
    else
        mv "$_x" "$_dest"
    fi
}

describe_stage() {
    _d=$1
    if [ -f "$_d/manifest.json" ]; then
        log check "manifest.json found"
    else
        log check "no manifest.json in the package root: not a Cockpit package"
        return 1
    fi
    if [ -f "$_d/$PREFLIGHT" ]; then
        log check "$PREFLIGHT found"
        kv preflight yes
    else
        [ -e "$_d/$LEGACY_PREFLIGHT" ] && log error "found the old $LEGACY_PREFLIGHT: rename it to $PREFLIGHT"
        log error "no $PREFLIGHT in the package root: Crewmate won't install it"
        kv preflight no
    fi
    log check "files: $(find "$_d" -type f | wc -l | tr -d ' '), size: $(du -sk "$_d" | cut -f1) KiB"
    kv dir "$_d"
}

cmd_env() {
    for _t in git curl wget openssl bash tar gzip unzip python3 busybox bsdtar; do
        if _p=$(command -v "$_t" 2>/dev/null); then
            log env "found $_t at $_p"
            kv tool "$_t"
        else
            log env "missing $_t"
        fi
    done
    _v=$(cockpit-bridge --version 2>/dev/null | sed -n 's/^Version: *//p' | head -n 1)
    [ -z "$_v" ] && _v=$(/usr/libexec/cockpit-bridge --version 2>/dev/null | sed -n 's/^Version: *//p' | head -n 1)
    log env "cockpit-bridge version: ${_v:-unknown}"
    kv cockpit "${_v:-}"
    for _pm in apt-get dnf yum zypper apk pacman; do
        if have "$_pm"; then
            log env "package manager: $_pm"
            kv pm "$_pm"
            break
        fi
    done
    kv dry "$DRY"
    kv root "$ROOT"
}

# Read-only health check, run unprivileged on every page load. Reports files
# changed since this Cockpit session started (the session's file list is fixed
# at login, so new files can 404), unreadable files, and what exists on disk.
cmd_check() {
    _dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || die "can't locate the package folder"
    kv pkgdir "$_dir"

    # The parent is the session's cockpit-bridge, so its age is the session age.
    _sess=""
    case $(ps -o args= -p "$PPID" 2>/dev/null) in
        *cockpit*)
            _e=$(ps -o etimes= -p "$PPID" 2>/dev/null | tr -d ' ')
            case $_e in
                ''|*[!0-9]*)
                    _e=$(ps -o etime= -p "$PPID" 2>/dev/null | tr -d ' ')
                    case $_e in
                        ''|*[!0-9:-]*) _e="" ;;
                        *) _e=$(echo "$_e" | awk -F'[-:]' '{ if (index($0, "-")) s = $1 * 86400 + $2 * 3600 + $3 * 60 + $4; else if (NF == 3) s = $1 * 3600 + $2 * 60 + $3; else s = $1 * 60 + $2; print s }') ;;
                    esac
                    ;;
            esac
            _sess=$_e
            ;;
    esac
    if [ -n "$_sess" ]; then
        _start=$(( $(date +%s) - _sess + 2 ))
        log check "session is ${_sess}s old"
        kv session "$_sess"
        # ctime can't be preserved by rsync/cp -p, unlike mtime. Capped: a wholesale deploy has hundreds.
        find "$_dir" -type f -exec stat -c '%Z %n' {} + 2>/dev/null |
            awk -v s="$_start" '$1 > s { sub(/^[0-9]+ /, ""); print }' | head -n 61 |
            while IFS= read -r _f; do kv changed "${_f#"$_dir"/}"; done
    else
        log check "session age unknown, skipping the changed-files check"
    fi

    _bad=$(find "$_dir" \( -type f ! -perm -004 \) -o \( -type d ! -perm -005 \) 2>/dev/null)
    _n=0
    [ -n "$_bad" ] && _n=$(printf '%s\n' "$_bad" | wc -l | tr -d ' ')
    kv unreadable "$_n"
    [ "$_n" -gt 0 ] && kv unreadable_sample "$(printf '%s\n' "$_bad" | head -n 1 | sed "s|^$_dir/||")"

    if [ -d /etc/cockpit ]; then kv etcdir yes; else kv etcdir no; fi
    if [ -e /etc/cockpit/crewmate.json ]; then kv settings yes; else kv settings no; fi
    if [ -d "$ROOT/var/lib/crewmate" ]; then kv vardir yes; else kv vardir no; fi

    # Other Crewpit packages: tells an old machine from a fresh one.
    _self=$(basename "$_dir")
    _others=0
    for _d in /usr/share/cockpit/*/ /usr/local/share/cockpit/*/; do
        [ "$(basename "$_d")" = "$_self" ] && continue
        [ -f "$_d/manifest.json" ] && [ -n "$(pf_file "$_d")" ] && _others=$((_others + 1))
    done
    kv others "$_others"
}

cmd_init() {
    check_root
    if [ "$DRY" = 1 ] && [ ! -d "$ROOT" ]; then
        mkdir -m 700 "$ROOT" || die "couldn't create $ROOT"
        log init "created fake root $ROOT (mode 700)"
    fi
    mkdir -p "$PKGDIR" "$ETCDIR" "$BAKDIR" || die "couldn't create $PKGDIR / $ETCDIR / $BAKDIR"
    if [ "$DRY" = 1 ]; then
        log init "dry run: fake root ready ($PKGDIR)"
    else
        log init "live: installing into $PKGDIR, backups in $BAKDIR"
    fi
    kv root "${ROOT:-/}"
}

cmd_get() {
    new_stage
    _f="$STAGE/download"
    log fetch "GET $1 (methods: $(methods_for_file))"
    http_get "$1" "$_f" || die "all download methods failed for $1"
    kv file "$_f"
}

cmd_fetch() {
    _url=$1 _ref=$2 _name=$3
    valid_name "$_name"
    new_stage
    _dest="$STAGE/$_name"
    log fetch "source $_url${_ref:+ (ref $_ref)} -> $_dest (methods: $(methods_for_pkg))"

    for _m in $(methods_for_pkg); do
        if [ "$_m" = git ]; then
            have git || { log fetch "git: not installed, next"; continue; }
            log fetch "git clone --depth 1${_ref:+ --branch $_ref} $_url $_dest"
            # No prompt: a private repo should fail rather than hang.
            if GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 ${_ref:+--branch "$_ref"} -- "$_url" "$_dest"; then
                kv commit "$(git -C "$_dest" rev-parse HEAD 2>/dev/null)"
                rm -rf "$_dest/.git"
                log fetch "cloned; removed .git (commit recorded instead)"
                kv method git
                describe_stage "$_dest" || exit 1
                return 0
            fi
            rm -rf "$_dest"
            log fetch "git clone failed, next"
            continue
        fi

        _aurl=$(archive_url "$_url" "$_ref") || {
            log fetch "$_m: '$_url' isn't a GitHub/GitLab repo or a direct .tar.gz/.zip link; only git can fetch it"
            continue
        }
        _a="$STAGE/package.archive"
        rm -f "$_a"
        METHOD_SAVED=$METHOD
        METHOD=$_m
        log fetch "$_m: archive $_aurl"
        if http_get "$_aurl" "$_a" && unpack "$_a" "$_dest"; then
            METHOD=$METHOD_SAVED
            rm -f "$_a"
            describe_stage "$_dest" || exit 1
            return 0
        fi
        METHOD=$METHOD_SAVED
        rm -rf "$_dest"
    done
    die "every transfer method failed for $_url"
}

cmd_unpack() {
    valid_stage "$1"
    valid_name "$2"
    [ -f "$1" ] || die "archive not found: $1"
    _dest="$(dirname "$1")/$2"
    [ -e "$_dest" ] && die "$_dest already exists"
    log unpack "unpacking $1 -> $_dest"
    unpack "$1" "$_dest" || die "couldn't unpack $1"
    rm -f "$1"
    kv method upload
    describe_stage "$_dest" || exit 1
}

cmd_probe() {
    _name=$1 _mode=$2 _cmd=${3:-}
    valid_name "$_name"
    if _p=$(command -v "$_name" 2>/dev/null); then
        log probe "$_name: command -v -> $_p"
        kv found "$_p"
    else
        log probe "$_name: command -v -> not found"
        kv missing "$_name"
        return 0
    fi
    [ "$_mode" = version ] || return 0

    # A command from the package author: never run as root, always logged.
    if [ -z "$_cmd" ]; then
        _cmd="$_name --version"
        log probe "$_name: no probe given, trying: $_cmd"
    else
        log probe "$_name: running probe: $_cmd"
    fi
    _to=""
    have timeout && _to="timeout 5"
    _out=$($_to sh -c "$_cmd" 2>&1 </dev/null | head -n 1)
    log probe "$_name: probe said: ${_out:-(nothing)}"
    kv output "$_out"
}

cmd_pkgcheck() {
    _pm=$1 _pkg=$2
    case $_pkg in ''|-*|*[!A-Za-z0-9.+_:-]*) die "invalid package name: '$_pkg'" ;; esac
    _ok=unknown
    case $_pm in
        apt-get)
            # "Candidate: (none)" or no output at all = not in any configured repo.
            _c=$(apt-cache policy "$_pkg" 2>/dev/null | sed -n 's/^ *Candidate: *//p' | head -n 1)
            if [ -z "$_c" ] || [ "$_c" = "(none)" ]; then _ok=no; else _ok=yes; fi
            log pkgcheck "apt-cache policy $_pkg -> candidate: ${_c:-none}"
            ;;
        dnf|yum)
            if "$_pm" -q info "$_pkg" >/dev/null 2>&1; then _ok=yes; else _ok=no; fi
            log pkgcheck "$_pm -q info $_pkg -> $_ok"
            ;;
        zypper)
            if zypper --non-interactive search -x "$_pkg" >/dev/null 2>&1; then _ok=yes; else _ok=no; fi
            log pkgcheck "zypper search -x $_pkg -> $_ok"
            ;;
        apk)
            if [ -n "$(apk search -x "$_pkg" 2>/dev/null)" ]; then _ok=yes; else _ok=no; fi
            log pkgcheck "apk search -x $_pkg -> $_ok"
            ;;
        pacman)
            if pacman -Si "$_pkg" >/dev/null 2>&1; then _ok=yes; else _ok=no; fi
            log pkgcheck "pacman -Si $_pkg -> $_ok"
            ;;
        *) log pkgcheck "unknown package manager '$_pm'" ;;
    esac
    kv available "$_ok"
}

cmd_install() {
    check_root
    _src=$1 _name=$2
    valid_stage "$_src"
    valid_name "$_name"
    [ -f "$_src/manifest.json" ] || die "$_src has no manifest.json"
    [ -e "$_src/$PREFLIGHT" ] || die "$_src has no $PREFLIGHT; Crewmate only installs packages that ship one"
    cmd_init >/dev/null

    _t="$PKGDIR/$_name"
    _new="$PKGDIR/.$_name.crewmate-new"
    # Never overwrite something that isn't a Crewpit package (no preflight file).
    if [ -e "$_t" ] && ! is_crewpit "$_t"; then
        die "$_t exists and isn't a Crewpit package (no $PREFLIGHT); refusing to overwrite it"
    fi
    if [ "$DRY" = 1 ]; then
        log install "dry run: target $_t (live target would be /usr/share/cockpit/$_name)"
    else
        log install "live: target $_t"
    fi

    rm -rf "$_new"
    log install "cp -R $_src $_new"
    cp -R "$_src" "$_new" || die "copy failed"
    # Archives keep their own modes; Cockpit serves files as the logged-in user.
    chmod -R u=rwX,go=rX "$_new" || die "chmod failed"
    log install "chmod -R u=rwX,go=rX $_new"

    if [ -e "$_t" ]; then
        mkdir -p "$BAKDIR"
        rm -rf "${BAKDIR:?}/$_name"
        log install "previous version moved to $BAKDIR/$_name (rollback copy)"
        mv "$_t" "$BAKDIR/$_name" || die "couldn't move the old version aside"
    fi
    log install "mv $_new $_t"
    mv "$_new" "$_t" || die "couldn't move the new version into place"
    log install "done"
    kv installed "$_t"
}

cmd_uninstall() {
    check_root
    valid_name "$1"
    [ "$1" = crewmate ] && die "refusing to uninstall Crewmate itself"
    _t="$PKGDIR/$1"
    [ -e "$_t" ] || { log uninstall "$_t not present, nothing to remove"; return 0; }
    is_crewpit "$_t" || die "$_t isn't a Crewpit package (no $PREFLIGHT); refusing to remove it"
    log uninstall "rm -rf $_t $BAKDIR/$1"
    rm -rf "$_t" "${BAKDIR:?}/$1"
    log uninstall "done"
}

cmd_list() {
    [ "$DRY" = 1 ] && check_root
    # managed <name> <0|1> [version]: 1 = has a preflight file
    for _d in "$PKGDIR"/*/; do
        [ -f "$_d/manifest.json" ] || continue
        _n=$(basename "$_d")
        _pf=$(pf_file "$_d")
        if [ -n "$_pf" ]; then
            kv managed "$_n 1 $(pf_version "$_pf")"
        else
            kv managed "$_n 0"
        fi
    done
    # system <path> [version]: Crewpit packages in the other package dirs
    _dirs="/usr/local/share/cockpit/*/"
    [ "$DRY" = 1 ] && _dirs="/usr/share/cockpit/*/ $_dirs"
    for _d in $_dirs; do
        _pf=$(pf_file "$_d")
        [ -f "$_d/manifest.json" ] && [ -n "$_pf" ] || continue
        kv system "${_d%/} $(pf_version "$_pf")"
    done
}

cmd_cleanup() {
    valid_stage "$1"
    case $1 in /tmp/crewmate.??????) ;; *) die "cleanup takes a stage dir, got $1" ;; esac
    [ -d "$1" ] || return 0
    rm -rf "$1"
    log cleanup "removed $1"
}

cmd_cleanup_all() {
    _n=0
    for _d in /tmp/crewmate.??????; do
        [ -d "$_d" ] && [ -O "$_d" ] && [ ! -L "$_d" ] || continue
        rm -rf "$_d"
        log cleanup "removed $_d"
        _n=$((_n + 1))
    done
    log cleanup "$_n stage dir(s) removed"
}

[ $# -ge 1 ] || die "usage: crewmate.sh <subcommand> [args]"
_cmd=$1
shift
case $_cmd in
    env) cmd_env ;;
    check) cmd_check ;;
    init) cmd_init ;;
    get) [ $# -eq 1 ] || die "usage: get <url>"; cmd_get "$1" ;;
    fetch) [ $# -eq 3 ] || die "usage: fetch <url> <ref> <name>"; cmd_fetch "$1" "$2" "$3" ;;
    mkstage) new_stage ;;
    unpack) [ $# -eq 2 ] || die "usage: unpack <archive> <name>"; cmd_unpack "$1" "$2" ;;
    probe) [ $# -ge 2 ] || die "usage: probe <name> <exists|version> [cmd]"; cmd_probe "$@" ;;
    pkgcheck) [ $# -eq 2 ] || die "usage: pkgcheck <pm> <package>"; cmd_pkgcheck "$1" "$2" ;;
    install) [ $# -eq 2 ] || die "usage: install <stagedir> <name>"; cmd_install "$1" "$2" ;;
    uninstall) [ $# -eq 1 ] || die "usage: uninstall <name>"; cmd_uninstall "$1" ;;
    list) cmd_list ;;
    cleanup) [ $# -eq 1 ] || die "usage: cleanup <stage>"; cmd_cleanup "$1" ;;
    cleanup-all) cmd_cleanup_all ;;
    *) die "unknown subcommand: $_cmd" ;;
esac
