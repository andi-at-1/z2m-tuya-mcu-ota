// Offline test for tuya-mcu-ota.mjs: simulated TuyaMCU that behaves like the real _TZE204_dtzziy1e
// (block request with 1-byte size -> delivered as type 'raw'; result repeated). Uses real
// zigbee-herdsman frame encoding for everything the extension sends.
// Usage: node offline-test.mjs <extension.mjs> <image.bin>   (needs zigbee-herdsman resolvable from cwd)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const {Zcl} = require('zigbee-herdsman');

const [extPath, imgPath] = process.argv.slice(2);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'z2m-'));
process.env.ZIGBEE2MQTT_DATA = data;
const {default: Ext} = await import(pathToFileURL(path.resolve(extPath)).href);

const IEEE = '0x4c5bb3fffe835770';
const MFR = '_TZE204_dtzziy1e';
let tsn = 0;
const queue = [];
const published = [];
const listeners = {};
const checks = [];
const check = (name, ok) => { checks.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };

const mcu = {version: 0x43, pid: 'dtzziy1e', size: 0, sum: 0, ver: 0, off: 0, buf: [], result: null, requests: 0};
function deliver(cmdId, payload) {
    const raw = Buffer.concat([Buffer.from([0x09, (tsn++) & 0xff, cmdId]), payload]);
    if (cmdId === 0x13) {
        // real device: herdsman cannot parse -> 'raw', and each request arrives 3x
        for (let i = 0; i < 3; i++) queue.push({device: {ieeeAddr: IEEE}, endpoint: ep, cluster: 'manuSpecificTuya', type: 'raw', data: raw, meta: {rawData: raw}});
        return;
    }
    const frame = Zcl.Frame.fromBuffer(0xef00, Zcl.Header.fromBuffer(raw), raw, {});
    const type = 'command' + frame.command.name[0].toUpperCase() + frame.command.name.slice(1);
    queue.push({device: {ieeeAddr: IEEE}, endpoint: ep, cluster: 'manuSpecificTuya', type, data: frame.payload, meta: {rawData: raw}});
}
function request() {
    const len = Math.min(48, mcu.size - mcu.off);
    const p = Buffer.alloc(16);
    p.writeUInt16BE((mcu.requests + 0x60) & 0xffff, 0); Buffer.from(mcu.pid).copy(p, 2); p[10] = mcu.ver; p.writeUInt32BE(mcu.off, 11); p[15] = len;
    mcu.requests++;
    deliver(0x13, p);
}
function mcuReceive(wire) {
    const cmd = Zcl.Header.fromBuffer(wire).commandIdentifier;
    const p = wire.subarray(3);
    if (cmd === 0x10) { deliver(0x11, Buffer.from([0, 7, mcu.version])); return; }
    if (cmd === 0x12) {
        mcu.ver = p[10]; mcu.size = p.readUInt32BE(11); mcu.sum = p.readUInt32BE(15); mcu.off = 0; mcu.buf = [];
        mcu.notify = {pid: p.subarray(2, 10).toString('latin1'), ver: mcu.ver, size: mcu.size, sum: mcu.sum};
        if (mcu.notify.pid === mcu.pid) request();
        return;
    }
    if (cmd === 0x14) {
        const off = p.readUInt32BE(12);
        if (p[2] !== 0 || p.subarray(3, 11).toString('latin1') !== mcu.pid || off !== mcu.off) { mcu.bad = (mcu.bad || 0) + 1; return; }
        const d = p.subarray(16); mcu.buf.push(Buffer.from(d)); mcu.off += d.length;
        if (mcu.off < mcu.size) return request();
        const img = Buffer.concat(mcu.buf); let s = 0; for (const b of img) s = (s + b) >>> 0;
        mcu.image = img; mcu.result = s === mcu.sum ? 0 : 1;
        if (mcu.result === 0) mcu.version = mcu.ver;
        if (process.env.NO_RESULT) { if (mcu.result === 0) deliver(0x11, Buffer.from([0, 6, mcu.version])); return; } // result lost, only new version
        for (let i = 0; i < 3; i++) deliver(0x15, Buffer.from([0, 4, mcu.result, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    }
}
const ep = {
    async command(cluster, cmd, payload) {
        const f = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, (tsn++) & 0xff, cmd, cluster, payload, {});
        mcuReceive(f.toBuffer());
    },
};
const zh = {ieeeAddr: IEEE, manufacturerName: MFR, modelID: 'TS0601', getEndpoint: () => ep, endpoints: [ep]};
const zigbee = {resolveEntity: (id) => (id === IEEE || id === 'Test_Melder' ? {name: 'Test_Melder', zh} : undefined)};
const mqtt = {publish: async (t, p) => { published.push([t, JSON.parse(p)]); }};
const eventBus = {onMQTTMessage: (k, cb) => { listeners.mqtt = cb; }, onDeviceMessage: (k, cb) => { listeners.dev = cb; }, removeListeners: () => {}};
const settings = {get: () => ({mqtt: {base_topic: 'zigbee2mqtt'}})};
const logger = {info: () => {}, warning: (m) => console.log('  WARN', m), error: (m) => console.log('  ERR', m)};
const ext = new Ext(zigbee, mqtt, {}, () => {}, eventBus, null, null, null, settings, logger);
ext.start();

const last = () => published[published.length - 1][1];
async function send(action, obj) {
    await listeners.mqtt({topic: `zigbee2mqtt/mcu_ota/request/${action}`, message: JSON.stringify(obj)});
    for (let i = 0; i < 20000 && queue.length; i++) await listeners.dev(queue.shift());
    await new Promise((r) => setImmediate(r));
}

const img = fs.readFileSync(imgPath);
const name = path.basename(imgPath);
check('images dir created', fs.existsSync(path.join(data, 'mcu_ota')));
await send('upload', {name: '../evil.bin', data_b64: 'AA=='});
check('upload rejects path traversal', /invalid file name/.test(last().message) && !fs.existsSync(path.join(data, 'evil.bin')));
await send('upload', {name, data_b64: img.toString('base64')});
check('upload stores image', fs.readFileSync(path.join(data, 'mcu_ota', name)).equals(img));
await send('start', {device: 'Test_Melder', file: name});
check('start without confirm refused', /confirm/.test(last().message) && !mcu.notify);
await send('start', {device: 'Test_Melder', file: name, confirm: 'FLASH'});
check('start without known version refused', /version unknown/.test(last().message) && !mcu.notify);
await send('info', {device: 'Test_Melder'});
check('info: version + pid guess', last().device_version === '1.0.3' && last().pid_guess === 'dtzziy1e' && last().images.includes(name));
await send('start', {device: 'Test_Melder', file: name, confirm: 'FLASH', version: '1.0.3'});
check('same version refused', /not newer/.test(last().message) && !mcu.notify);
await send('start', {device: 'Test_Melder', file: name, confirm: 'FLASH'});
const st = last();
check('notify: pid/version/size/sum correct', mcu.notify && mcu.notify.pid === 'dtzziy1e' && mcu.notify.ver === 0x45 && mcu.notify.size === img.length);
check(process.env.NO_RESULT ? 'done via new version report (no result frame)' : 'transfer done, status 0',
    st.state === 'done' && (process.env.NO_RESULT ? st.device_version === '1.0.5' : st.result && st.result.status === 0));
check('image on MCU identical', mcu.image && mcu.image.equals(img));
check('duplicates served once (requests == blocks)', st.blocks === mcu.requests && !mcu.bad);
check('repeated result does not change state', last().state === 'done');
ext.stop();
fs.rmSync(data, {recursive: true, force: true});
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`${checks.length - failed}/${checks.length} passed, blocks ${st.blocks}`);
process.exit(failed ? 1 : 0);
