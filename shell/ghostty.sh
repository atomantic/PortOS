#!/bin/zsh
#########################################
# Ghostty Shell Integration for PortOS
# Source this file from ~/.zshrc to enable:
#   - proj <path> [theme]  — launch Ghostty with project theme
#   - proj-themes           — list available themes
#   - Auto-theme on cd      — OSC color changes when entering themed dirs
#########################################

# Find ghostty binary (shared helper)
function _ghostty_bin() {
  if command -v ghostty &>/dev/null; then
    echo "ghostty"
  elif [[ -x "/Applications/Ghostty.app/Contents/MacOS/ghostty" ]]; then
    echo "/Applications/Ghostty.app/Contents/MacOS/ghostty"
  elif [[ -x "$HOME/Applications/Ghostty.app/Contents/MacOS/ghostty" ]]; then
    echo "$HOME/Applications/Ghostty.app/Contents/MacOS/ghostty"
  elif [[ -x "$HOME/Documents/Ghostty.app/Contents/MacOS/ghostty" ]]; then
    echo "$HOME/Documents/Ghostty.app/Contents/MacOS/ghostty"
  fi
}

# Map theme name to emoji
function _ghostty_theme_emoji() {
  case "$1" in
    blue)   echo "🔵" ;;
    green)  echo "🟢" ;;
    purple) echo "🟣" ;;
    orange) echo "🟠" ;;
    red)    echo "🔴" ;;
    cyan)   echo "🩵" ;;
    *)      echo "⚪" ;;
  esac
}

# Detect theme name from a .ghostty-theme file (reads the comment header)
function _ghostty_theme_name() {
  local file="$1"
  local first_line
  first_line=$(head -1 "$file" 2>/dev/null)
  if [[ "$first_line" =~ ^#.*-\ (.+)\ theme$ ]]; then
    echo "${match[1]:l}"  # lowercase
  elif [[ "$first_line" =~ ^#.*-\ (.+)$ ]]; then
    # Try to extract color keyword from comment
    local comment="${first_line#\# }"
    for color in blue green purple orange red cyan; do
      if [[ "${comment:l}" == *"$color"* ]]; then
        echo "$color"
        return
      fi
    done
    echo "custom"
  else
    echo "custom"
  fi
}

#########################################
# Ghostty Project Launcher
# Usage: proj <project-path> [theme]
# Themes: blue, green, purple, orange, red, cyan
#
# Theme resolution order:
#   1. .ghostty-theme file in the project directory
#   2. Named theme passed as second argument
#   3. Default: blue
#
# Examples:
#   proj ~/projects/my-api          # uses .ghostty-theme if present, else blue
#   proj ~/projects/frontend purple # uses purple theme (ignores .ghostty-theme)
#   proj .                          # open current dir

function proj() {
  local project_path="${1:-.}"
  local theme_override="$2"
  local theme_dir="$HOME/Library/Application Support/com.mitchellh.ghostty/themes"

  # Resolve to absolute path
  if [[ "$project_path" == "." ]]; then
    project_path="$(pwd)"
  else
    project_path="$(cd "$project_path" 2>/dev/null && pwd)"
  fi

  if [[ -z "$project_path" || ! -d "$project_path" ]]; then
    echo "Error: Directory not found: $1"
    return 1
  fi

  local ghostty_bin
  ghostty_bin="$(_ghostty_bin)"
  if [[ -z "$ghostty_bin" ]]; then
    echo "Error: Ghostty not found"
    return 1
  fi

  local theme_file=""
  local theme_name=""

  # Theme resolution: explicit arg > .ghostty-theme > default
  if [[ -n "$theme_override" ]]; then
    theme_file="$theme_dir/$theme_override.conf"
    theme_name="$theme_override"
    if [[ ! -f "$theme_file" ]]; then
      echo "Available themes: blue, green, purple, orange, red, cyan"
      echo "Error: Theme not found: $theme_override"
      return 1
    fi
  elif [[ -f "$project_path/.ghostty-theme" ]]; then
    theme_file="$project_path/.ghostty-theme"
    theme_name="$(_ghostty_theme_name "$theme_file")"
  else
    theme_name="blue"
    theme_file="$theme_dir/blue.conf"
  fi

  local project_name=$(basename "$project_path")
  local emoji="$(_ghostty_theme_emoji "$theme_name")"
  local window_title="${emoji} ${project_name}"

  "$ghostty_bin" \
    --config-file="$theme_file" \
    --title="$window_title" \
    --working-directory="$project_path" &>/dev/null &

  disown
  echo "Launched: $window_title"
}

# List available Ghostty themes
function proj-themes() {
  echo "Available Ghostty project themes:"
  echo "  blue   🔵 Default/main projects"
  echo "  green  🟢 Backend/API projects"
  echo "  purple 🟣 Frontend/UI projects"
  echo "  orange 🟠 DevOps/Infrastructure"
  echo "  red    🔴 Production/Critical"
  echo "  cyan   🩵 Data/Analytics"
  echo ""
  echo "Or drop a .ghostty-theme file in any project directory."
  echo ""
  echo "Usage: proj <project-path> [theme]"
  echo "Example: proj ~/projects/my-api green"
  echo "Example: proj ~/projects/PortOS        # auto-detects .ghostty-theme"
}

#########################################
# Ghostty auto-theme on cd
# Walks up from cwd to find nearest .ghostty-theme and applies colors
# via OSC escape sequences. Reverts to defaults when leaving a themed dir.

GHOSTTY_THEME_ACTIVE=""

function _ghostty_apply_osc() {
  # Only run inside Ghostty
  [[ "$TERM_PROGRAM" == "ghostty" ]] || return 0

  local theme_file=""
  local search_dir="$PWD"

  # Walk up to find nearest .ghostty-theme
  while [[ "$search_dir" != "/" ]]; do
    if [[ -f "$search_dir/.ghostty-theme" ]]; then
      theme_file="$search_dir/.ghostty-theme"
      break
    fi
    search_dir="$(dirname "$search_dir")"
  done

  # Same theme already active — skip
  if [[ "$theme_file" == "$GHOSTTY_THEME_ACTIVE" ]]; then
    return 0
  fi

  if [[ -n "$theme_file" ]]; then
    GHOSTTY_THEME_ACTIVE="$theme_file"
    _ghostty_set_colors "$theme_file"
  elif [[ -n "$GHOSTTY_THEME_ACTIVE" ]]; then
    # Left a themed directory — reset to defaults
    GHOSTTY_THEME_ACTIVE=""
    _ghostty_reset_colors
  fi
}

function _ghostty_set_colors() {
  local file="$1"
  while IFS= read -r line; do
    # Skip comments and empty lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// /}" ]] && continue

    local key="${line%%=*}"
    local val="${line#*= }"
    key="${key// /}"
    val="${val// /}"

    case "$key" in
      foreground)
        [[ "$val" != \#* ]] && val="#$val"
        printf '\e]10;%s\a' "$val"
        ;;
      background)
        [[ "$val" != \#* ]] && val="#$val"
        printf '\e]11;%s\a' "$val"
        ;;
      cursor-color)
        [[ "$val" != \#* ]] && val="#$val"
        printf '\e]12;%s\a' "$val"
        ;;
      palette)
        # val format: "N=#RRGGBB" e.g. "0=#0f0f0f"
        local idx="${val%%=*}"
        local color="${val#*=}"
        [[ "$color" != \#* ]] && color="#$color"
        printf '\e]4;%s;%s\a' "$idx" "$color"
        ;;
    esac
  done < "$file"
}

function _ghostty_reset_colors() {
  # Reset foreground, background, cursor to terminal defaults
  printf '\e]110\a'   # reset foreground
  printf '\e]111\a'   # reset background
  printf '\e]112\a'   # reset cursor
  # Reset all 16 palette colors
  printf '\e]104\a'   # reset all palette entries
}

# Register the chpwd hook
autoload -U add-zsh-hook
add-zsh-hook chpwd _ghostty_apply_osc

# Apply on shell startup too (in case shell starts in a themed directory)
_ghostty_apply_osc
