# X11 Forwarding for VS Code Electron Worker

Forward the VS Code Electron UI from the Docker container to your Mac via XQuartz, enabling live visual debugging of Copilot Chat interactions.

## Prerequisites (one-time)

```bash
# Install XQuartz
brew install --cask xquartz

# Log out and back in (or reboot) for XQuartz to register as the X11 provider

# Enable TCP listening (XQuartz defaults to Unix sockets only)
defaults write org.xquartz.X11 nolisten_tcp -bool false

# Open XQuartz preferences → Security → ✅ "Allow connections from network clients"
# Then quit and reopen XQuartz
```

## Docker Compose Dev Mode

```bash
# Disable X11 access control (once per XQuartz session)
xhost +

# Launch with X11 forwarding
pnpm docker:dev:vscode-electron:x11
```

VS Code will appear on your Mac desktop when the worker processes a run. Submit a run via the CLI or portal to trigger it.

## Integration Tests

```bash
xhost +

# Delete stale image to pick up code changes

# Run with X11 forwarding
X11_FORWARD=true pnpm test:integration -- --run \
```

## How It Works

Setting `X11_FORWARD=true` (via the compose overlay or env var) changes the worker behavior:

| Aspect | Default (headless) | X11 forwarding |
|--------|-------------------|----------------|
| Display | Xvfb `:99` (virtual framebuffer) | `host.docker.internal:0` (XQuartz) |
| Xvfb | Started in container | Skipped |
| GPU | `--disable-gpu` | GPU enabled (XQuartz uses Mac GPU) |
| Window mode | Fullscreen | Windowed with native title bar |
| Video recording | ffmpeg x11grab → WebM | Not available |
| Window manager | openbox (in container) | quartz-wm (XQuartz) |

## Troubleshooting

### `Missing X server or $DISPLAY`

XQuartz isn't accepting connections. Verify:

1. XQuartz is running (`open -a XQuartz`)
2. TCP listening is enabled: `lsof -i TCP:6000` should show Xquartz
3. Access control is disabled: `pnpm x11:auth` (runs `xhost +`)

### `Authorization required, but no authorization protocol specified`

Run `xhost +` to disable X11 access control.

### Black rectangles / rendering artifacts

The `--disable-gpu` flag is automatically skipped in X11 mode. If you still see artifacts, they may be caused by fullscreen mode — which is also automatically skipped. Ensure you're running the latest code (rebuild the container).

### Window position

XQuartz's window manager (quartz-wm) controls window placement. Initial position cannot be overridden programmatically.

## Security Notes

- `pnpm x11:auth` runs `xhost +` which disables X11 access control entirely. This is acceptable for local development.
- Run `xhost -` when done to re-enable access control.
- The `nolisten_tcp` setting persists across XQuartz restarts (stored in macOS defaults).
