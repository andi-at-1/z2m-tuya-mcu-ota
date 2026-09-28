# tuya-mcu-ota – MCU firmware update for Tuya devices in Zigbee2MQTT

Many Tuya devices (e.g. 24 GHz presence sensors) contain **two** chips: the Zigbee module and,
behind it, a separate MCU that does the actual work. Zigbee2MQTT can only update the Zigbee
module (standard OTA). Tuya updates the MCU firmware through its own protocol in cluster
`0xEF00` – normally only the Tuya gateway can do that. This extension takes over that role in
Zigbee2MQTT.

## Tested

| Device | MCU | Update | Duration |
|---|---|---|---|
| `_TZE204_dtzziy1e` (MTG275-ZB-RL, 24 GHz presence sensor) | WCH CH571F | 1.0.3 → 1.0.5 | approx. 14 min |

Two devices updated successfully, both work normally afterwards. After the last block, one
confirmed within 1 s, the other took 68 s. **Everything else is untested.**

## Warning

- A wrong or corrupted firmware image can **brick** the device. There is usually no way back to
  the old version (the images are encrypted and the old firmware is not available).
- Only use images made for exactly your device (product ID **and** hardware variant).
- Do not power off the device or restart Zigbee2MQTT during the update.
- Use at your own risk.

## Requirements

- Zigbee2MQTT 2.x (tested with the Home Assistant add-on and an Ember adapter).
- The firmware image as a `.bin` file. The firmware itself is **not** included (it belongs to Tuya).

## Installation

1. Copy `tuya-mcu-ota.mjs` to `<z2m data>/external_extensions/` (Home Assistant add-on:
   `/config/zigbee2mqtt/external_extensions/`, e.g. via Samba or the File Editor) and restart
   Zigbee2MQTT.
   Alternatively, without a restart, via MQTT: topic `zigbee2mqtt/bridge/request/extension/save`,
   payload `{"name": "tuya-mcu-ota.mjs", "code": "<file content as JSON string>"}`.
   The log then shows `[mcu_ota] loaded, images dir …` – that is where the images go.
2. Put the image into `<z2m data>/mcu_ota/` (Home Assistant add-on: `/config/zigbee2mqtt/mcu_ota/`;
   the folder is created when the extension loads). The file name should contain the version,
   e.g. `dtzziy1e_v1.0.5_240617.bin` – otherwise pass `"version"` when starting.

## Usage

All commands are sent via MQTT (e.g. Home Assistant → Developer tools → Actions → `mqtt.publish`,
or MQTT Explorer). Progress is published on `zigbee2mqtt/mcu_ota/status` and in the Z2M log
(lines containing `[mcu_ota]`).

**1. Query the version** (required – no update starts without a known version):

```
Topic:   zigbee2mqtt/mcu_ota/request/info
Payload: {"device": "My_Sensor"}
```

The status then contains `device_version` (current MCU version), `pid_guess` (product ID derived
from the manufacturer name) and `images` (the `.bin` files found).

**2. Start the update:**

```
Topic:   zigbee2mqtt/mcu_ota/request/start
Payload: {"device": "My_Sensor", "file": "dtzziy1e_v1.0.5_240617.bin", "confirm": "FLASH"}
```

Optional fields: `"version": "1.0.5"` (if not in the file name), `"pid": "xxxxxxxx"`
(8 characters, default = last 8 characters of the manufacturer name, e.g. `_TZE204_dtzziy1e` →
`dtzziy1e`), `"force": true` (skip the version check – only if you know what you are doing).

The extension refuses to start if the image version is not newer than the device's version.

**3. Wait.** `state` goes from `running` (blocks are being transferred) to `finishing` (everything
sent, the device verifies and restarts – this can take more than a minute) and then to `done`
(success) or `failed`. Success means either the device's confirmation or the device reporting the
new version on its own afterwards.

**4. Re-interview the device.** After the update, the configuration options (sliders etc.) only
work again once the device has been re-interviewed: Z2M frontend → device → Interview, or via
MQTT: topic `zigbee2mqtt/bridge/request/device/interview`, payload `{"id": "My_Sensor"}`.

Abort: `zigbee2mqtt/mcu_ota/request/abort` with `{}`.

## Troubleshooting

- **`failed`, and the device repeats the error every 2 seconds:** briefly disconnect the device
  from power – it stops and keeps running the old firmware.
- **`stalled` at 100 %:** all blocks were sent, but the device has not reported back within
  5 minutes. Run `info` to query the version – if it shows the new one, the update worked.
- **`stalled` midway (no more block requests):** the device rejected the image or the radio link
  is too weak. Move it closer to the coordinator or a router and try again.
- **`block request with different pid`:** the image is for a different product.

## Technical background

The device requests the firmware in 48-byte blocks (command `0x13`). On these devices the size
field in the request is only **1 byte** long instead of the 4 bytes zigbee-herdsman expects. Z2M
therefore cannot decode the request and passes it on as `raw`. That is why attempts the regular
way abort after approx. 13 s with status 1. The extension decodes these raw frames itself.

Protocol (payload after the ZCL header, multi-byte values big-endian):

| Command | Direction | Content |
|---|---|---|
| `0x10` | GW → device | seq(2) – version request |
| `0x11` | device → GW | seq(2) version(1) – version = major(2 bit).minor(2 bit).patch(4 bit) |
| `0x12` | GW → device | seq(2) pid(8) version(1) size(4) checksum(4) – checksum = byte sum of the image |
| `0x13` | device → GW | seq(2) pid(8) version(1) offset(4) size(1) |
| `0x14` | GW → device | seq(2) status(1) pid(8) version(1) offset(4) data(n) |
| `0x15` | device → GW | seq(2) status(1) … – 0 = success |

## Files

- `tuya-mcu-ota.mjs` – the extension
- `offline-test.mjs` – test against a simulated device (`npm i zigbee-herdsman`, then
  `node offline-test.mjs tuya-mcu-ota.mjs <image.bin>`)
- `HERDSMAN.md` – what zigbee-herdsman / Zigbee2MQTT would need to change to support this natively
