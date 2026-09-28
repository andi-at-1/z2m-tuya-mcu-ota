// tuya-mcu-ota.mjs - Zigbee2MQTT external extension: OTA update of the *MCU* inside Tuya "TuyaMCU"
// devices (cluster 0xEF00 / manuSpecificTuya, commands 0x10-0x15).
//
// Zigbee2MQTT only implements the standard OTA cluster (genOta), which updates the Zigbee module.
// Many Tuya devices (e.g. 24 GHz presence sensors) have a second microcontroller behind the Zigbee
// module; its firmware is updated through Tuya's own protocol in cluster 0xEF00. This extension
// implements the gateway side of that protocol.
//
// Tested: _TZE204_dtzziy1e (MTG275-ZB-RL, 24 GHz presence sensor, MCU WCH CH571F),
//         MCU 1.0.3 -> 1.0.5, 52224 byte image, ~14 min. Anything else: untested, your risk.
//
// Images go into <zigbee2mqtt data dir>/mcu_ota/ (e.g. /config/zigbee2mqtt/mcu_ota/ in the
// Home Assistant add-on). The folder is created on start.
//
// MQTT API (topics relative to the Z2M base topic, all payloads JSON):
//   mcu_ota/request/info    {"device":"<name|ieee>"}          query MCU version, list images
//   mcu_ota/request/start   {"device":"<name|ieee>", "file":"<x.bin>", "confirm":"FLASH",
//                            "version":"1.0.5" (optional if the file name contains v1.0.5),
//                            "pid":"xxxxxxxx" (optional, default: last 8 chars of manufacturerName),
//                            "force":true (optional: skip version checks)}
//   mcu_ota/request/abort   {}                                stop serving blocks
//   mcu_ota/request/status  {}                                republish status
//   mcu_ota/request/upload  {"name":"<x.bin>", "data_b64":"..."} store an image (max 1 MiB)
// Status: mcu_ota/status (state idle|running|finishing|done|failed|aborted|stalled, percent, message ...)
//
// Wire format (payload after the ZCL header; multi-byte values big-endian):
//   0x10 version req   seq(2)
//   0x11 version rsp   seq(2) version(1)            version byte = major(2 bit).minor(2 bit).patch(4 bit)
//   0x12 notify        seq(2) pid(8) version(1) size(4) checksum(4)   checksum = byte sum of image
//   0x13 block req     seq(2) pid(8) version(1) offset(4) size(1)     <- size is ONE byte on real
//                      devices; zigbee-herdsman expects 4, so the frame arrives as type 'raw'
//   0x14 block rsp     seq(2) status(1) pid(8) version(1) offset(4) data(n)
//   0x15 result        seq(2) status(1) ...          status 0 = success

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const CLUSTER = 'manuSpecificTuya';
const MAX_CHUNK = 64;
const MAX_IMAGE = 1024 * 1024;
const STALL_MS = 60000;
const FINISH_MS = 5 * 60000; // after the last block the MCU may need >1 min to verify/reboot
const VERSION_MAX_AGE_MS = 15 * 60000;

function dataDir() {
    if (process.env.ZIGBEE2MQTT_DATA) return process.env.ZIGBEE2MQTT_DATA;
    // Z2M imports extensions from <data>/external_extensions/
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function verStr(v) {
    return `${(v >> 6) & 3}.${(v >> 4) & 3}.${v & 15}`;
}

function verByte(s) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(s).trim());
    if (!m) return null;
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a > 3 || b > 3 || c > 15) return null;
    return (a << 6) | (b << 4) | c;
}

// zigbee-herdsman writes UINT16/UINT32 little-endian. We pass "the LE reading of the wire bytes we
// want", which keeps the bytes on air under our control.
function u32le(buf4) {
    return Buffer.from(buf4).readUInt32LE(0);
}
function be32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0, 0);
    return b;
}

export default class TuyaMcuOta {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension, settings, logger) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.eventBus = eventBus;
        this.settings = settings;
        this.logger = logger;
        this.dir = path.join(dataDir(), 'mcu_ota');
        this.seq = 1;
        this.versions = new Map(); // ieee -> {v, at}
        this.job = null;
        this.st = {state: 'idle', message: 'loaded', images_dir: this.dir};
        this.lastPublish = 0;
    }

    start() {
        try {
            fs.mkdirSync(this.dir, {recursive: true});
        } catch (e) {
            this.logger.warning(`[mcu_ota] cannot create ${this.dir}: ${e.message}`);
        }
        this.eventBus.onMQTTMessage(this, (d) => this.onMqtt(d).catch((e) => this.fail(`request failed: ${e.message}`)));
        this.eventBus.onDeviceMessage(this, (d) => this.onDevice(d).catch((e) => this.fail(`device handler: ${e.message}`)));
        this.timer = setInterval(() => this.watchdog(), 5000);
        this.logger.info(`[mcu_ota] loaded, images dir ${this.dir}`);
        this.publish(true);
    }

    stop() {
        clearInterval(this.timer);
        this.eventBus.removeListeners(this);
    }

    publish(force = false) {
        const now = Date.now();
        if (!force && now - this.lastPublish < 2000) return;
        this.lastPublish = now;
        this.mqtt.publish('mcu_ota/status', JSON.stringify(this.st), {}).catch(() => {});
    }

    info(msg) {
        this.st.message = msg;
        this.logger.info(`[mcu_ota] ${msg}`);
        this.publish(true);
    }

    fail(msg) {
        this.st.message = msg;
        this.logger.error(`[mcu_ota] ${msg}`);
        this.publish(true);
    }

    nextSeq() {
        this.seq = (this.seq + 1) & 0xffff;
        return this.seq;
    }

    resolve(id) {
        if (!id) throw new Error('"device" missing');
        const dev = this.zigbee.resolveEntity(id);
        if (!dev || !dev.zh || !dev.zh.ieeeAddr) throw new Error(`device "${id}" not found`);
        const ep = dev.zh.getEndpoint(1) || dev.zh.endpoints[0];
        if (!ep) throw new Error(`device "${id}" has no endpoint`);
        return {zh: dev.zh, ep, ieee: dev.zh.ieeeAddr, name: dev.name || dev.zh.ieeeAddr};
    }

    listImages() {
        try {
            return fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.bin'));
        } catch {
            return [];
        }
    }

    imagePath(name) {
        if (!/^[\w.\-]+$/.test(String(name || '')) || name.startsWith('.')) throw new Error(`invalid file name "${name}"`);
        return path.join(this.dir, name);
    }

    async requestVersion(d) {
        await d.ep.command(CLUSTER, 'mcuVersionRequest', {seq: this.nextSeq()}, {disableDefaultResponse: true, disableResponse: true});
    }

    async onMqtt({topic, message}) {
        const pfx = `${this.settings.get().mqtt.base_topic}/mcu_ota/request/`;
        if (!topic.startsWith(pfx)) return;
        const action = topic.slice(pfx.length);
        let msg = {};
        try {
            msg = message ? JSON.parse(message) : {};
        } catch {
            return this.fail('payload is not JSON');
        }

        if (action === 'status') return this.publish(true);

        if (action === 'abort') {
            if (this.job) this.job.aborted = true;
            this.st.state = 'aborted';
            return this.info('aborted, no more blocks will be served (power-cycle the device if it keeps reporting the result)');
        }

        if (action === 'upload') {
            const file = this.imagePath(msg.name);
            if (!file.toLowerCase().endsWith('.bin')) throw new Error('name must end with .bin');
            const buf = Buffer.from(String(msg.data_b64 || ''), 'base64');
            if (buf.length === 0 || buf.length > MAX_IMAGE) throw new Error(`image size ${buf.length} out of range`);
            fs.writeFileSync(file, buf);
            this.st.images = this.listImages();
            return this.info(`stored ${msg.name} (${buf.length} B)`);
        }

        if (action === 'info') {
            const d = this.resolve(msg.device);
            const mfr = d.zh.manufacturerName || '';
            Object.assign(this.st, {
                device: d.name, ieee: d.ieee, model: d.zh.modelID, manufacturer: mfr,
                pid_guess: mfr.length >= 8 ? mfr.slice(-8) : null, device_version: null, images: this.listImages(),
            });
            await this.requestVersion(d);
            return this.info(`version request sent to ${d.name}, answer appears as device_version`);
        }

        if (action === 'start') {
            if (msg.confirm !== 'FLASH') throw new Error('start refused: payload must contain "confirm":"FLASH"');
            if (this.job && !this.job.aborted && (this.st.state === 'running' || this.st.state === 'finishing')) throw new Error('start refused: a transfer is already running');
            const d = this.resolve(msg.device);
            const file = this.imagePath(msg.file);
            if (!fs.existsSync(file)) throw new Error(`image ${file} not found`);
            const image = fs.readFileSync(file);
            if (image.length === 0 || image.length > MAX_IMAGE) throw new Error(`image size ${image.length} out of range`);

            const verText = msg.version || (/v(\d+\.\d+\.\d+)/i.exec(msg.file) || [])[1];
            const version = verByte(verText);
            if (version === null) throw new Error('image version unknown: pass "version":"x.y.z" (x,y <= 3, z <= 15)');

            const mfr = d.zh.manufacturerName || '';
            const pid = String(msg.pid || mfr.slice(-8));
            if (Buffer.from(pid, 'latin1').length !== 8) throw new Error(`pid "${pid}" must be exactly 8 characters`);

            if (!msg.force) {
                const known = this.versions.get(d.ieee);
                if (!known || Date.now() - known.at > VERSION_MAX_AGE_MS) {
                    throw new Error('start refused: current MCU version unknown - run "info" first and wait for device_version (or use "force":true)');
                }
                if (version <= known.v) {
                    throw new Error(`start refused: image ${verStr(version)} is not newer than device ${verStr(known.v)} (use "force":true to override)`);
                }
            }

            let sum = 0;
            for (const b of image) sum = (sum + b) >>> 0;
            const key = Buffer.from(pid, 'latin1');
            this.job = {ieee: d.ieee, image, key, version, lastServed: null, lastRequestAt: Date.now(), aborted: false};
            this.st = {
                state: 'running', device: d.name, ieee: d.ieee, file: msg.file, pid, image_version: verStr(version),
                image_size: image.length, image_sum32: '0x' + sum.toString(16).padStart(8, '0'),
                device_version: this.versions.has(d.ieee) ? verStr(this.versions.get(d.ieee).v) : null,
                offset: 0, percent: 0, blocks: 0, result: null, images_dir: this.dir, message: '',
            };
            await d.ep.command(CLUSTER, 'mcuOtaNotify', {
                seq: this.nextSeq(),
                key_hi: u32le(key.subarray(0, 4)),
                key_lo: u32le(key.subarray(4, 8)),
                version,
                imageSize: u32le(be32(image.length)),
                crc: u32le(be32(sum)),
            }, {disableDefaultResponse: true, disableResponse: true});
            return this.info(`notify sent to ${d.name}: ${msg.file} v${verStr(version)} ${image.length} B pid ${pid}, waiting for block requests`);
        }

        throw new Error(`unknown action "${action}"`);
    }

    // Returns {cmd, p} for a Tuya MCU frame: cmd = command id, p = payload after the ZCL header.
    frame(data) {
        let b = data.type === 'raw' ? data.data : null;
        if (b && !Buffer.isBuffer(b) && Array.isArray(b.data)) b = Buffer.from(b.data);
        if (!Buffer.isBuffer(b)) b = data.meta && data.meta.rawData;
        if (Buffer.isBuffer(b) && b.length >= 3) {
            const hdr = (b[0] & 0x04) ? 5 : 3;
            return {cmd: b[hdr - 1], p: b.subarray(hdr)};
        }
        const map = {commandMcuVersionResponse: 0x11, commandMcuOtaBlockDataRequest: 0x13, commandMcuOtaResult: 0x15};
        if (!(data.type in map)) return null;
        // Fallback without raw bytes: rebuild the relevant part from parsed (LE) fields.
        const x = data.data || {};
        const parts = [];
        const w16 = (v) => { const t = Buffer.alloc(2); t.writeUInt16LE((v || 0) & 0xffff); parts.push(t); };
        const w32 = (v) => { const t = Buffer.alloc(4); t.writeUInt32LE((v || 0) >>> 0); parts.push(t); };
        const w8 = (v) => parts.push(Buffer.from([(v || 0) & 0xff]));
        w16(x.seq);
        if (data.type === 'commandMcuOtaResult') w8(x.status);
        if (data.type !== 'commandMcuVersionResponse') { w32(x.key_hi); w32(x.key_lo); }
        w8(x.version);
        if (data.type === 'commandMcuOtaBlockDataRequest') { w32(x.offset); w32(x.size); }
        return {cmd: map[data.type], p: Buffer.concat(parts)};
    }

    async onDevice(data) {
        if (!data.device || data.cluster !== CLUSTER) return;
        if (data.type !== 'raw' && !/^commandMcu/.test(data.type)) return;
        const f = this.frame(data);
        if (!f) return;
        const ieee = data.device.ieeeAddr;
        const hex = f.p.toString('hex');

        if (f.cmd === 0x11) {
            if (f.p.length < 3) return;
            const v = f.p[2];
            this.versions.set(ieee, {v, at: Date.now()});
            if (this.st.ieee === ieee) {
                this.st.device_version = verStr(v);
                const job = this.job;
                if (job && job.ieee === ieee && job.complete && v === job.version && this.st.state !== 'done') {
                    // The result frame can get lost; the device reporting the new version is proof enough.
                    this.st.state = 'done';
                    return this.info(`update finished: ${this.st.device} now reports MCU version ${verStr(v)} - re-interview the device so its settings work again`);
                }
                this.info(`MCU version of ${this.st.device}: ${verStr(v)} (0x${v.toString(16)})`);
            }
            return;
        }

        const job = this.job;
        if (!job || job.ieee !== ieee) return;

        if (f.cmd === 0x15) {
            // devices repeat the result every few seconds; accept it once, also after a stall
            if (this.st.state !== 'running' && this.st.state !== 'finishing' && this.st.state !== 'stalled') return;
            const status = f.p[2];
            this.st.result = {status, raw: hex};
            this.st.state = status === 0 ? 'done' : 'failed';
            this.info(status === 0
                ? `update finished successfully (${this.st.blocks} blocks) - re-interview the device so its settings work again`
                : `device reported failure, status ${status} (raw ${hex}); power-cycle the device if it keeps repeating this`);
            return;
        }

        if (f.cmd !== 0x13) return;
        if ((this.st.state !== 'running' && this.st.state !== 'finishing') || job.aborted) return;
        const p = f.p;
        if (p.length < 15) return this.fail(`block request too short: ${hex}`);
        const keyWire = p.subarray(2, 10);
        const version = p[10];
        const offWire = p.subarray(11, 15);
        const offset = offWire.readUInt32BE(0);
        let size = 48;
        if (p.length >= 19) {
            const sz = p.readUInt32BE(15);
            if (sz >= 1 && sz <= MAX_CHUNK) size = sz;
        } else if (p.length >= 16 && p[15] >= 1 && p[15] <= MAX_CHUNK) {
            size = p[15];
        }
        if (!keyWire.equals(job.key)) return this.fail(`block request with different pid "${keyWire.toString('latin1')}": ${hex}`);
        if (offset > job.image.length) return this.fail(`block request offset ${offset} beyond image (${job.image.length}): ${hex}`);

        // Devices send each request several times; serve an offset at most once per 1.5 s.
        const now = Date.now();
        if (job.lastServed && job.lastServed.offset === offset && now - job.lastServed.at < 1500) return;
        job.lastServed = {offset, at: now};

        const chunk = job.image.subarray(offset, Math.min(offset + size, job.image.length));
        await data.endpoint.command(CLUSTER, 'mcuOtaBlockDataResponse', {
            seq: p.readUInt16LE(0),
            status: 0,
            key_hi: u32le(keyWire.subarray(0, 4)),
            key_lo: u32le(keyWire.subarray(4, 8)),
            version,
            offset: u32le(offWire),
            imageData: Array.from(chunk),
        }, {disableDefaultResponse: true, disableResponse: true});
        job.lastRequestAt = now;
        this.st.blocks += 1;
        this.st.offset = offset + chunk.length;
        this.st.percent = Math.round((this.st.offset / job.image.length) * 1000) / 10;
        this.st.message = `served offset ${offset} len ${chunk.length}`;
        if (this.st.offset >= job.image.length) {
            job.complete = true;
            this.st.state = 'finishing';
            this.st.message = 'all blocks sent, waiting for the device to verify and restart (can take a few minutes)';
            return this.publish(true);
        }
        if (this.st.blocks <= 2) this.logger.info(`[mcu_ota] block request ${hex} -> ${chunk.length} B`);
        this.publish();
    }

    watchdog() {
        if (!this.job || (this.st.state !== 'running' && this.st.state !== 'finishing')) return;
        const idle = Date.now() - this.job.lastRequestAt;
        if (this.st.state === 'finishing') {
            if (idle > FINISH_MS) {
                this.st.state = 'stalled';
                this.fail(`all blocks sent, but no result or new version from the device after ${Math.round(idle / 1000)} s - run "info" to check the version`);
            }
            return;
        }
        if (idle > STALL_MS) {
            this.st.state = 'stalled';
            this.fail(`no block request for ${Math.round(idle / 1000)} s at ${this.st.percent} % - device rejected or lost the update`);
        }
    }
}
