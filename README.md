# Adventurer 5M Pro Panel

A Chrome extension for monitoring and controlling a Flashforge Adventurer 5M Pro over your local network. It shows the camera feed, print progress, and temperatures, and covers every control the printer's LAN API exposes. Everything runs in your browser and talks to the printer directly, with no cloud account and no server in between.

Version 2.2.0

## Features

**Views**
- Side panel: click the toolbar icon to open a compact one-column view next to any page.
- Full panel: a two-column dashboard in its own tab. Open it from the side panel with "Open full panel" (the side panel closes itself) or by right-clicking the toolbar icon.
- Floating camera: "Float" moves the camera into an always-on-top window with a small overlay showing progress, layer, time left, and temperatures.
- Camera window: "New window" opens the raw stream in a separate browser window that stays open even if the panel closes.

**Monitoring**
- Live camera feed (MJPEG)
- Printer status, file name and thumbnail, progress, layer, elapsed and remaining time, estimated finish time, estimated filament use, current speed
- Nozzle, bed, and chamber temperatures with target markers
- Air quality (TVOC) and door status
- Firmware, nozzle size, loaded filament, lifetime filament, IP and MAC address, error code

**Control**
- Pause, resume, and cancel the current print; clear the build plate after a print finishes
- Set or turn off the nozzle and bed temperatures, plus PLA, PETG, and ABS preheat presets and "Cool down"
- Chamber temperature, if the printer reports that it supports it
- While printing: print speed (50–150%), Z offset in 0.01 and 0.05 mm steps, part cooling fan, auxiliary fan
- LED light, internal filtration, external exhaust
- Upload .gcode or .3mf files (drag and drop), optionally print right away with or without bed leveling
- Reprint any of the 10 most recent files stored on the printer
- Calibration (bed leveling and vibration compensation), auto shutdown after a print with a configurable delay, and renaming the printer

## Requirements

- Chrome 116 or later (Edge works too)
- A Flashforge Adventurer 5M Pro on the same network as your computer
- The printer in **LAN only** mode
- The printer's IP address, serial number, and check code

## Installation

1. Unzip `ad5m-panel.zip`.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `ad5m-panel` folder.
5. Pin the extension to the toolbar for quick access.

To update, replace the folder with the new version and click the reload button on the extension's card.

## First-time setup

### Find the printer's details

1. On the printer's screen, tap the gear icon (Settings), then the Wi‑Fi icon.
2. Under **Network mode**, turn on **LAN only**. The check code (sometimes labeled printer ID) and the IP address appear there.
3. The serial number is on the machine info screen (the "i" icon in Settings). It usually starts with `SN`. If it isn't there, check the label on the back of the printer.

Turning on LAN only disables the FlashMaker app and cloud mode. Orca‑Flashforge keeps working in LAN mode.

Reserve the printer's IP address in your router (a DHCP reservation) so it doesn't change. If it does change, update it under **Connection**.

### Connect

1. Click the extension icon. The connection dialog opens on first use.
2. Enter the IP address, serial number, and check code, then click **Connect**.
3. Chrome asks for permission to access that IP address. Allow it. The extension only gets access to that one address, not to other sites.
4. Newer versions of Chrome may also ask for permission to access devices on your local network. Allow that too.

The extension tests the connection before saving. Your details are stored locally in the extension's storage on this computer. Use **Connection → Forget printer** to delete them and revoke the access permission.

## Usage notes

- The panel refreshes the printer status every 2 seconds and slows to every 10 seconds when it isn't visible.
- The camera stops when the panel is hidden to save bandwidth, unless the camera is floating.
- The camera feed reconnects every 4 minutes while it's showing, and also whenever it stops receiving frames for 15 seconds. Turn off the timed reconnect under **Machine → Camera**.
- Speed, Z offset, and fan controls are disabled unless a print is running or paused, because the printer only accepts those changes during a print.
- The floating window belongs to the page that opened it. If you float the camera from the side panel and then close the side panel, the floating window closes too. To keep it up for a long time, float it from the full panel.
- If your browser can't open a floating window from the current view, "Float" opens a separate camera window instead.

## Limitations

- **No manual movement.** Jogging axes, homing, and manual extrusion aren't available through the 5M Pro's LAN API.
- **Calibration timing.** The API describes calibration as a pre-print step, so the printer may apply it at the start of the next job rather than right away. It's ignored while a print is running.
- **No printer discovery.** Extensions can't send the UDP broadcasts needed to find printers automatically, so you enter the IP address yourself.
- **Single printer.** The extension stores one printer at a time.
- **Firmware differences.** The LAN API isn't officially documented by Flashforge. Field names and behavior can change between firmware versions.

## Troubleshooting

**"No response from …:8898"**
Check that the printer is on, connected to the same network, and in LAN only mode. Confirm the IP on the printer's network screen. VPNs and guest Wi‑Fi networks often block access to local devices.

**"Wrong serial number or check code"**
Re-enter both. The check code can change if LAN only mode is turned off and on again.

**The camera doesn't load**
Click "New window". If the stream doesn't open there either, the camera may be off on the printer, or another device may already be using it. Restarting the printer usually helps.

**Uploads fail**
Upload is the part most sensitive to firmware differences. Note the error message shown under the upload area. As a workaround, send the file from Orca‑Flashforge and then reprint it from the recent files list.

**The extension stopped working after an IP change**
Open **Connection**, enter the new IP, and click **Connect**. Chrome will ask for access to the new address.

## Privacy and security

- The extension only talks to the IP address you enter. It sends no data anywhere else.
- The serial number and check code are stored unencrypted in Chrome's local extension storage. Anyone with access to your browser profile could read them.
- The printer's LAN API uses plain HTTP. Anyone on your local network who has the check code can control the printer, so use it on a network you trust.

## How it works

The printer exposes an HTTP API on port 8898. Every request is a `POST` with the serial number and check code in the JSON body.

| Endpoint | Used for |
| --- | --- |
| `/detail` | Status, temperatures, progress, and machine info (polled) |
| `/product` | Which features the printer can control |
| `/control` | Commands: `jobCtl_cmd`, `lightControl_cmd`, `circulateCtl_cmd`, `printerCtl_cmd`, `temperatureCtl_cmd`, `streamCtrl_cmd`, `stateCtrl_cmd`, `calibration_cmd`, `delayClose_cmd`, `reName_cmd` |
| `/gcodeList` | Recent files |
| `/gcodeThumb` | File thumbnails |
| `/printGcode` | Start a stored file |
| `/uploadGcode` | Upload a file (multipart, credentials in headers) |

The camera is an MJPEG stream on port 8080. The extension first loads it as an image. If that fails, it reads the stream with `fetch` and draws each frame onto a canvas.

The floating camera uses the Document Picture-in-Picture API to move the camera element into an always-on-top window.

### Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 configuration, permissions, side panel |
| `background.js` | Side panel behavior, right-click menu, opening the full panel |
| `dashboard.html` | Interface for both the side panel (`?view=side`) and the full panel |
| `dashboard.css` | Styles, including light and dark themes |
| `dashboard.js` | API client, polling, camera, controls, uploads |
| `icons/` | Toolbar and store icons |

### Permissions

| Permission | Why |
| --- | --- |
| `storage` | Saves the connection details |
| `sidePanel` | Shows the side panel view |
| `contextMenus` | Adds "Open full panel" to the toolbar icon's right-click menu |
| Optional `http://<printer-ip>/*` | Requested at connect time, only for your printer's address |

## Credits

The API details are based on the community documentation of the Flashforge LAN protocol in the [flashforge-api-docs](https://github.com/Parallel-7/flashforge-api-docs) project.

This project isn't affiliated with or endorsed by Flashforge.
