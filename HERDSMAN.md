# Tuya MCU OTA: full procedure, known problems, and what upstream would need

This extension works around gaps in the upstream stack. This document describes the complete
update procedure as the gateway has to run it, every problem we hit on the way, and what
zigbee-herdsman / zigbee-herdsman-converters / Zigbee2MQTT would need to support it natively.

Observations come from one device type only (`_TZE204_dtzziy1e`, MTG275-ZB-RL 24 GHz presence
sensor): MCU 1.0.3 → 1.0.5 on two devices (25.09.2026, Ember adapter, Z2M 2.14.1 / herdsman 10.9.5),
plus a partial test transfer on 07.10.2026 (Z2M 2.14.2 / herdsman 10.10.0 with the fix below,
SLZB-07 as coordinator, EmberZNet 8.2.2).

## Status upstream

| Problem | Where | Status |
|---|---|---|
| `mcuOtaBlockDataRequest.size` is 1 byte, frame arrives as `raw` | herdsman | issue [#1889](https://github.com/Koenkk/zigbee-herdsman/issues/1889), PR (see below) |
| multi-byte fields are big-endian, herdsman reads/writes little-endian | herdsman | open, not reported yet |
| PID split into `key_hi`/`key_lo` | herdsman | open (FIXME in source) |
| `crc` in `mcuOtaNotify` is a byte sum | herdsman | open |
| no gateway-side MCU OTA logic | zhc | open |
| MCU update not part of the OTA feature / frontend | Z2M | open |

## The procedure, step by step

Payload layouts are in the protocol reference at the end. All multi-byte values on the wire are
**big-endian**.

### 1. Read the current MCU version

Send `mcuVersionRequest` (0x10), the device answers with `mcuVersionResponse` (0x11).
Version byte = major(2 bit).minor(2 bit).patch(4 bit): `0x43` = 1.0.3, `0x45` = 1.0.5.

Z2M shows this as `MCU module: x.y.z` in the software build id after an interview.

### 2. Announce the update

Send `mcuOtaNotify` (0x12): pid (8 ASCII bytes, for this device the last 8 characters of the
manufacturer name, `dtzziy1e`), new version, image size, image byte sum.

Problems:
- **The checksum is the plain byte sum** of the image (UINT32), not a CRC, although herdsman
  calls the field `crc`. With a CRC32 the device rejects the image.
- **Same or older version is ignored silently.** Announcing 1.0.5 to a device on 1.0.5 gets
  no block request and no `mcuOtaResult` at all; the device keeps reporting its normal data
  points. The gateway has to time out (we use 60 s without a block request → "stalled") and
  should tell the user that the version is probably not newer.
- **Big-endian fields:** herdsman encodes `seq`, `imageSize` and `crc` little-endian. The
  extension passes the byte-swapped value so that the bytes on air are big-endian.

### 3. Serve the block requests

The device sends `mcuOtaBlockDataRequest` (0x13) with offset and size (48 bytes here); the
gateway answers each with `mcuOtaBlockDataResponse` (0x14): status 0, same pid and version,
the requested offset, `size` bytes of the image.

Problems:
- **The size field is 1 byte**, not 4 as herdsman defines it. The 16-byte payload cannot be
  parsed, herdsman delivers it as type `raw`, and nothing answers. Fixed by the PR.
- **Offset and seq are big-endian.** Even with the fix herdsman reports them byte-swapped
  (offset 48 arrives as 805306368, seq 0x0048 as 18432). The response must carry the offset
  bytes exactly as received. The extension copies the wire bytes through.
- **Every request arrives more than once** (2–3 times). Answering all of them confuses the
  device. Same offset within ~1.5 s = ignore.
- **Throughput depends on the route.** With the device one hop from the coordinator (test
  setup) the device asked for ~5 blocks/s after the first one; through the house network
  (25.09.) the full 52224-byte image (1088 blocks) took ~14 min.
- **Coordinator stability.** During a genOta update of other devices on 23.09. the coordinator
  (ZBT-2, EmberZNet 7.4.4) crashed three times (ASH/HOST_FATAL); Nabu Casa's later firmware
  fixes "Z2M crashes during device firmware updates". Not seen during the MCU updates
  themselves, but the traffic pattern is similar; update the coordinator first.

### 4. Completion

After the last block the device verifies the image and reboots the MCU.

Problems:
- **The result can be late or missing.** On one device `mcuOtaResult` (0x15) status 0 came
  within 1 s. On the other it never came; success was only visible because the device reported
  the new version via `mcuVersionResponse` 68 s later. So: wait up to ~5 min and treat either
  result status 0 **or** a version report equal to the image version as success.
- **The result is repeated** every few seconds; accept it once.

### 5. Re-interview

Without a re-interview after the update, the device's configuration options (sliders etc.) no
longer work in Z2M.

### 6. Device-specific follow-up (this sensor)

The reason for the update: on MCU 1.0.3 the sensor reports `target_distance` about once per
second and that cannot be switched off, which floods the network. 1.0.5 adds DP 116
`distance_report`; set it to OFF (`mtg275-distance-report.mjs` until zhc supports the DP).

### Failure and abort behaviour

- If the gateway stops answering block requests (abort, crash, unparsed `raw` frame), the device
  retries the current request every ~2 s for ~13 s, then sends `mcuOtaResult` status 1 and
  **repeats it every ~2 s until it is power-cycled**. The old firmware stays active; after the
  power cycle the device works normally on the old version (seen on 1.0.3 before the fix, and
  on 07.10. after a deliberate abort at 4 %).
- No command to cancel an update from the gateway side is known.

### Testing without a newer image

The device refuses the version it already has (step 2). To test the transfer path you can announce
a higher version than the image carries and abort after a few blocks; the device keeps its
firmware (see above). Do not let such a transfer complete: what the MCU does with an image whose
version does not match the announcement was not tested.

## What upstream would need

### zigbee-herdsman

1. `mcuOtaBlockDataRequest.size` → `DataType.UINT8` (PR for #1889).
2. Big-endian handling for `seq`, `offset`, `imageSize`, `crc` in 0x10–0x15, so that parsed
   values are the real ones (offset 48 is 48).
3. PID as a fixed 8-byte octet field instead of `key_hi`/`key_lo`.
4. Rename `crc` to something like `byteSum`, or document it.
5. `mcuOtaResult` (0x15) defines `key_hi/key_lo/version` after `status`; only `seq` and `status`
   were verified.

### zigbee-herdsman-converters

zhc only sends `mcuVersionRequest` today (`lib/tuya.ts`, `mcuVersionRequestOnConfigure`). The
gateway side of steps 1–5 is missing: version query, notify with byte sum, serving blocks with
de-duplication, completion handling with the 5-minute window and the version-report fallback,
re-interview. Devices would need a definition flag (e.g. `ota: {mcu: true}`) and the pid.

### Zigbee2MQTT

The OTA feature (`bridge/request/device/ota_update/*`, frontend OTA page) only knows `genOta`,
which updates the Zigbee module, not the MCU behind it. Native support would need a second update
type "MCU", an image source (local file or an index with pid + version; Tuya MCU images are not
in the Koenkk OTA index), progress and result through the existing OTA status, and the
re-interview at the end.

## Protocol reference

Payload after the ZCL header, multi-byte values big-endian:

| Cmd | Direction | Payload |
|---|---|---|
| `0x10` | GW → device | seq(2) |
| `0x11` | device → GW | seq(2) version(1) |
| `0x12` | GW → device | seq(2) pid(8) version(1) size(4) bytesum(4) |
| `0x13` | device → GW | seq(2) pid(8) version(1) offset(4) size(**1**) |
| `0x14` | GW → device | seq(2) status(1) pid(8) version(1) offset(4) data(n) |
| `0x15` | device → GW | seq(2) status(1) … (0 = success) |
