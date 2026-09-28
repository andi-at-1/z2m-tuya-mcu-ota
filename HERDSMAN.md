# What zigbee-herdsman / Zigbee2MQTT would need for native Tuya MCU OTA

This extension works around gaps in the upstream stack. To make it unnecessary, the following
changes are needed. Checked against **zigbee-herdsman 10.9.5** and **zigbee-herdsman-converters
26.105.0** (Zigbee2MQTT 2.14.1). Observations come from one device type only
(`_TZE204_dtzziy1e`, MTG275-ZB-RL, MCU 1.0.3 → 1.0.5).

## 1. zigbee-herdsman: fix `mcuOtaBlockDataRequest` (0x13) – the blocker

File: `src/zspec/zcl/definition/cluster.ts`, cluster `manuSpecificTuya`, `commandsResponse`.

Current definition:

```ts
mcuOtaBlockDataRequest: {
    ID: 0x13,
    parameters: [
        {name: "seq",     type: DataType.UINT16},
        {name: "key_hi",  type: DataType.UINT32},
        {name: "key_lo",  type: DataType.UINT32},
        {name: "version", type: DataType.UINT8},
        {name: "offset",  type: DataType.UINT32},
        {name: "size",    type: DataType.UINT32},   // <-- device sends 1 byte
    ],
},
```

What the device actually sends is 16 bytes of payload:

```
seq(2) pid(8) version(1) offset(4) size(1)
```

`size` is **one byte** (the device requests 48-byte blocks). Because the frame is 3 bytes shorter
than the definition, herdsman cannot parse it and hands it to the application as type `raw`
instead of `commandMcuOtaBlockDataRequest`. Nothing reacts, the MCU times out after ~13 s,
reports `mcuOtaResult` status 1 and then repeats that result every ~2 s until it is power-cycled.

Required change: `size` → `DataType.UINT8`.

Open question for the maintainers: whether other Tuya MCUs send a 4-byte size. If that cannot be
ruled out, the parser should accept both lengths (e.g. read `size` as UINT8 when exactly one byte
is left, UINT32 when four are left) rather than switching unconditionally.

## 2. zigbee-herdsman: smaller cleanups in the same commands

- **Product ID as 8 raw bytes.** `mcuOtaNotify` (0x12), `mcuOtaBlockDataResponse` (0x14),
  `mcuOtaBlockDataRequest` (0x13) and `mcuOtaResult` (0x15) split the 8-byte product ID into
  `key_hi`/`key_lo` UINT32 (there is a FIXME about it in the source). This works on the wire,
  but a fixed-length octet field would make the PID (ASCII, e.g. `dtzziy1e`) readable and
  comparable directly.
- **`crc` in `mcuOtaNotify` is not a CRC.** The device expects the plain **byte sum** of the image
  (UINT32, big-endian). The field name should say so, otherwise implementers compute a CRC32 and
  the device rejects the image.
- **`mcuOtaResult` (0x15)** is defined with `key_hi/key_lo/version` after `status`. Only
  `seq` and `status` are relied on here; the rest was not verified.

## 3. zigbee-herdsman-converters: MCU OTA logic

zhc only uses `mcuVersionRequest` today (`lib/tuya.ts`, `mcuVersionRequestOnConfigure`).
There is no gateway-side MCU OTA. Needed (this is what `tuya-mcu-ota.mjs` implements):

1. `mcuVersionRequest` → `mcuVersionResponse`; version byte = major(2 bit).minor(2 bit).patch(4 bit)
   (0x45 = 1.0.5).
2. `mcuOtaNotify` with pid, new version, image size and byte sum.
3. Answer every `mcuOtaBlockDataRequest` with `mcuOtaBlockDataResponse` (status 0, same pid and
   version, requested offset, `size` bytes of the image).
   - **Deduplicate:** the device sends each request several times; answering all of them
     confuses it. Same offset within ~1.5 s = ignore.
4. **Completion handling:** after the last block the device may need more than a minute before it
   reports anything. On one device `mcuOtaResult` status 0 arrived within 1 s, on the other it
   never arrived – success was only visible because the device reported the new version 68 s
   later via `mcuVersionResponse`. So: wait up to ~5 min, and treat either `mcuOtaResult`
   status 0 **or** a version report equal to the image version as success.
5. **Re-interview after the update.** Without it, the device's configuration options (sliders
   etc.) no longer work in Z2M.

## 4. Zigbee2MQTT: OTA integration

The existing OTA feature (`bridge/request/device/ota_update/*`, frontend OTA page) only knows
the standard `genOta` cluster, which updates the Zigbee module – not the MCU behind it. Native
support would need:

- a second update type "MCU" per device (definition flag in zhc, e.g. `ota: {mcu: true}`),
- an image source (local file / index entry with pid + version, since Tuya MCU images are not
  in the Koenkk OTA index),
- progress and result reporting through the existing OTA status fields,
- a re-interview (point 3.5) once the update succeeded.

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
