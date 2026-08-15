#!/usr/bin/env bash
#
# dsh-easyvision — one-command install for the DeepSeek Harness.
#
#   ./install.sh                        install into the desktop profile
#   curl -fsSL https://raw.githubusercontent.com/s3yf1337/dsh-easyvision/main/install.sh | bash
#
# Options:
#   --profile NAME   profile to install into (default: desktop)
#   --link           symlink the plugin into $DSH_HOME/plugins instead of copying
#                    (for development checkouts)
#   --no-restart     do not restart the harness after installing
#   --repo URL       git URL to fetch when run outside a checkout
#
# What it does (all idempotent, safe to re-run):
#   1. puts the plugin at $DSH_HOME/plugins/dsh-easyvision
#   2. registers it in the profile's package.json + node_modules
#   3. adds the easyvision row to the profile's cordis.patch.yml
#   4. patches the installed dsh-host-apiproxy so the Settings page can
#      expose the easyvision namespace (scripts/patch-dsh-host.mjs)
#   5. restarts the profile (unless --no-restart)
#
set -euo pipefail

REPO_URL="https://github.com/s3yf1337/dsh-easyvision.git"
PROFILE="desktop"
LINK_MODE=0
RESTART=1

while [ "$#" -gt 0 ]; do
	case "$1" in
		--profile) PROFILE="${2:?--profile needs a name}"; shift 2 ;;
		--link) LINK_MODE=1; shift ;;
		--no-restart) RESTART=0; shift ;;
		--repo) REPO_URL="${2:?--repo needs a URL}"; shift 2 ;;
		-h|--help)
			if [ -f "$0" ]; then sed -n '2,24p' "$0"; else echo "usage: curl -fsSL <install.sh> | bash [--profile NAME] [--no-restart]"; fi
			exit 0 ;;
		*) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
	esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_DIR="$DSH_HOME/plugins/dsh-easyvision"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
MANIFEST="$PROFILE_DIR/package.json"

command -v node >/dev/null 2>&1 || { echo "error: node is required (dsh runs on node)" >&2; exit 1; }
command -v dsh >/dev/null 2>&1 || { echo "error: dsh not found on PATH" >&2; exit 1; }

# ── 1. source + destination ───────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN_CHECKOUT=0
if [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"dsh-easyvision"' "$SCRIPT_DIR/package.json"; then
	IN_CHECKOUT=1
fi

mkdir -p "$DSH_HOME/plugins"
if [ "$IN_CHECKOUT" -eq 1 ] && [ "$SCRIPT_DIR" = "$PLUGIN_DIR" ]; then
	: # already installed in place
elif [ "$IN_CHECKOUT" -eq 1 ] && [ "$LINK_MODE" -eq 1 ]; then
	rm -rf "$PLUGIN_DIR"
	ln -s "$SCRIPT_DIR" "$PLUGIN_DIR"
	echo "linked $PLUGIN_DIR -> $SCRIPT_DIR"
elif [ "$IN_CHECKOUT" -eq 1 ]; then
	rm -rf "$PLUGIN_DIR"
	mkdir -p "$PLUGIN_DIR"
	tar -C "$SCRIPT_DIR" --exclude=.git --exclude=node_modules --exclude=testpics -cf - . | tar -C "$PLUGIN_DIR" -xf -
	echo "copied plugin to $PLUGIN_DIR"
else
	# run from a pipe (curl | bash): clone or update the checkout
	if [ -d "$PLUGIN_DIR/.git" ]; then
		git -C "$PLUGIN_DIR" pull --ff-only --quiet
		echo "updated $PLUGIN_DIR"
	else
		git clone --depth 1 "$REPO_URL" "$PLUGIN_DIR"
		echo "cloned $REPO_URL -> $PLUGIN_DIR"
	fi
fi

# ── 2. profile: ensure it exists ──────────────────────────────────────────
if [ ! -f "$MANIFEST" ]; then
	echo "initializing profile '$PROFILE'…"
	if ! dsh --profile "$PROFILE" --help >/dev/null 2>&1; then
		# No shipped template for this name: create the minimal base profile.
		mkdir -p "$PROFILE_DIR"
		cat > "$MANIFEST" <<EOF
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base"
      ]
    }
  }
}
EOF
		cat > "$PROFILE_DIR/cordis.patch.yml" <<'EOF'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
EOF
		cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
EOF
		echo "created minimal profile at $PROFILE_DIR"
	fi
fi
if [ ! -f "$MANIFEST" ]; then
	echo "error: profile '$PROFILE' did not initialize (check dsh --profile $PROFILE --help)" >&2
	exit 1
fi
mkdir -p "$PROFILE_DIR/node_modules"

# ── 3. register the plugin in the profile ─────────────────────────────────
node - "$MANIFEST" "$PLUGIN_DIR" <<'EOF'
const [manifestPath, pluginDir] = process.argv.slice(2);
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.dependencies = manifest.dependencies ?? {};
manifest.dependencies["dsh-easyvision"] = `file:${pluginDir}`;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("profile dependency set: dsh-easyvision -> file:" + pluginDir);
EOF

if [ -e "$PROFILE_DIR/node_modules/dsh-easyvision" ]; then
	rm -rf "$PROFILE_DIR/node_modules/dsh-easyvision"
fi
ln -s "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/dsh-easyvision"

# ── 4. cordis.patch.yml row (idempotent) ──────────────────────────────────
if grep -q "dsh-easyvision" "$PATCH_FILE" 2>/dev/null; then
	echo "patch row already present"
else
	# A fresh profile patch is just `[]` — drop the bare line so appending
	# the insert list keeps the file valid YAML.
	if grep -q '^\[ *\]$' "$PATCH_FILE"; then
		sed -i '/^\[ *\]$/d' "$PATCH_FILE"
	fi
	cat >> "$PATCH_FILE" <<'PATCH'

# dsh-easyvision: describe images through the dedicated vision model.
# The model is chosen in Settings → EasyVision (the config here is only the
# base layer, inherited by anything not overridden in Settings).
- insert:
    - id: easyvision
      name: 'dsh-easyvision'
PATCH
	echo "patch row added"
fi

# ── 5. expose the settings namespace to the web client ────────────────────
(cd "$PLUGIN_DIR" && node scripts/patch-dsh-host.mjs)

# ── 6. restart ────────────────────────────────────────────────────────────
if [ "$RESTART" -eq 1 ]; then
	echo "restarting profile '$PROFILE'…"
	pkill -f "dsh --profile $PROFILE" 2>/dev/null || true
	sleep 1
	DSH_HOME="$DSH_HOME" nohup dsh --profile "$PROFILE" >"$DSH_HOME/dsh-install-restart.log" 2>&1 &
	disown 2>/dev/null || true
	sleep 2
	echo "restarted (log: $DSH_HOME/dsh-install-restart.log)"
else
	echo "installed; restart the harness when ready:"
	echo "  pkill -f \"dsh --profile $PROFILE\" && dsh --profile $PROFILE"
fi

echo
echo "done. The vision model is now configurable in Settings → EasyVision."
