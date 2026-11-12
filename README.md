# CameraView

View the RTSP cameras on your local network in any modern browser — a live multi-camera grid,
with no plugins and no cloud.

**App:** https://aurasscz.github.io/CameraView/

## How it works

Browsers can't speak RTSP, so CameraView has two parts:

| Part | What it does |
| --- | --- |
| **Web app** (`web/`) | The camera grid UI. Hosted on GitHub Pages, or served by the gateway itself. Cameras are saved in your browser's local storage. |
| **Gateway** ([go2rtc](https://github.com/AlexxIT/go2rtc)) | Runs on a computer on your network. Pulls the RTSP streams from your cameras and hands them to the browser as WebRTC (low latency) or MSE over WebSocket (fallback). |

```
camera ──RTSP──▶ gateway (go2rtc, port 1984) ──WebRTC / MSE──▶ browser (CameraView)
```

Video never leaves your local network.

## Quick start

1. **Start the gateway** on a computer on the same network as your cameras:

   ```bash
   git clone https://github.com/aurasscz/CameraView
   cd CameraView
   ./gateway/start.sh                      # macOS / Linux (downloads go2rtc on first run)
   ```

   Windows:

   ```powershell
   powershell -ExecutionPolicy Bypass -File gateway\start.ps1
   ```

   Docker (Linux):

   ```bash
   docker compose up -d
   ```

2. **Open the app**
   - On the same computer: https://aurasscz.github.io/CameraView/ (uses `http://localhost:1984`), or http://localhost:1984/
   - From a phone, tablet or another computer: `http://<gateway-ip>:1984/` — the gateway serves the app too.

3. **Add cameras** with **+ Add camera**: paste an RTSP URL, or use *Build URL* and pick your camera type.
   Press **Test** to preview before saving. **Scan** finds ONVIF cameras automatically.

### Common RTSP URLs

| Camera | URL |
| --- | --- |
| Hikvision | `rtsp://user:pass@IP:554/Streaming/Channels/101` (sub stream: `102`) |
| Dahua / Amcrest / Lorex | `rtsp://user:pass@IP:554/cam/realmonitor?channel=1&subtype=0` |
| Reolink | `rtsp://user:pass@IP:554/h264Preview_01_main` |
| TP-Link Tapo / VIGI | `rtsp://user:pass@IP:554/stream1` (enable a camera account in the Tapo app first) |
| Axis | `rtsp://user:pass@IP:554/axis-media/media.amp` |
| Foscam | `rtsp://user:pass@IP:88/videoMain` |

If your password contains special characters (`@ : / #`), use *Build URL* — it encodes them for you.

## Features

- Responsive multi-camera grid (auto, 1–4 columns), focus view and fullscreen (double-click)
- WebRTC playback with automatic MSE fallback and auto-reconnect
- Snapshot to PNG, per-camera audio
- ONVIF network scan
- Brand presets for building RTSP URLs
- Import / export camera list as JSON
- Pauses streams when the tab is hidden (configurable)
- Installable as a PWA

## Notes and troubleshooting

- **"Gateway offline" on the GitHub Pages site:** the hosted app talks to `http://localhost:1984`, so the gateway
  must run on the *same* computer as the browser. For a gateway elsewhere on your network, open `http://<gateway-ip>:1984/`
  instead — browsers block plain-HTTP requests to LAN addresses from HTTPS pages.
- **Chrome asks to "access other apps and services on this device / local network":** choose *Allow*; this is how
  the hosted page reaches your local gateway.
- **Safari** may block the hosted HTTPS page from reaching `localhost`; open `http://localhost:1984/` instead.
- **No video but status is green:** most browsers can't play H.265/HEVC over WebRTC. Switch the camera to H.264,
  or use its sub stream. Chrome/Edge can play H.265 via MSE (*Settings → Playback mode → MSE only*).
- **Firewall:** allow TCP 1984 and TCP/UDP 8555 on the gateway computer for other devices to connect.
- **Security:** the gateway has no password by default and is meant for trusted home networks.
  To add one, set `username`/`password` under `api:` in `gateway/go2rtc.yaml` (then open the app from the gateway URL).
  Never expose port 1984 to the internet.
- Camera URLs (including passwords) are stored in your browser's local storage and are written to
  `gateway/go2rtc.yaml` by the gateway.

## Development

The web app is plain HTML/CSS/JavaScript with no build step. Serve `web/` with any static server, or just run the
gateway (it serves `web/` at http://localhost:1984/).

GitHub Pages serves the `main` branch (Settings → Pages → *Deploy from a branch*, `main`, `/ (root)`).
The root `index.html` redirects to `web/`, and `.nojekyll` turns off Jekyll processing.

## License

GPL-3.0 — see [LICENSE](LICENSE). go2rtc is a separate project under the MIT license.
