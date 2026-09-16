import { EventEmitter } from 'node:events';
let txSequence = 0;
function crcAccumulate(byte, crc) { let tmp = byte ^ (crc & 0xff); tmp ^= tmp << 4; return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff; }
function encodeV1(id, payload, crcExtra) {
    const frame = Buffer.alloc(6 + payload.length + 2);
    frame[0] = 0xfe;
    frame[1] = payload.length;
    frame[2] = txSequence++ & 0xff;
    frame[3] = 255;
    frame[4] = 190;
    frame[5] = id;
    payload.copy(frame, 6);
    let crc = 0xffff;
    for (let i = 1; i < 6 + payload.length; i++)
        crc = crcAccumulate(frame[i], crc);
    crc = crcAccumulate(crcExtra, crc);
    frame.writeUInt16LE(crc, 6 + payload.length);
    return frame;
}
export function gcsHeartbeat() {
    const payload = Buffer.alloc(9);
    payload[4] = 6;
    payload[5] = 8;
    payload[7] = 4;
    payload[8] = 3;
    return encodeV1(0, payload, 50);
}
export function requestAllStreams(rateHz = 4) {
    const payload = Buffer.alloc(6);
    payload.writeUInt16LE(rateHz, 0);
    payload[2] = 1;
    payload[3] = 1;
    payload[4] = 0;
    payload[5] = 1;
    return encodeV1(66, payload, 148);
}
export class MavlinkParser extends EventEmitter {
    data = Buffer.alloc(0);
    push(chunk) {
        this.data = Buffer.concat([this.data, chunk]);
        while (this.data.length >= 8) {
            const v2 = this.data[0] === 0xfd, v1 = this.data[0] === 0xfe;
            if (!v1 && !v2) {
                this.data = this.data.subarray(1);
                continue;
            }
            const payloadLength = this.data[1];
            const signed = v2 && (this.data[2] & 1) !== 0;
            const length = (v2 ? 10 : 6) + payloadLength + 2 + (signed ? 13 : 0);
            if (this.data.length < length)
                return;
            const id = v2 ? this.data[7] | (this.data[8] << 8) | (this.data[9] << 16) : this.data[5];
            const offset = v2 ? 10 : 6;
            this.emit('frame', { id, payload: this.data.subarray(offset, offset + payloadLength) });
            this.data = this.data.subarray(length);
        }
    }
}
export function decode(frame) {
    const p = frame.payload;
    if (frame.id === 0 && p.length >= 9)
        return { kind: 'heartbeat', customMode: p.readUInt32LE(0), baseMode: p[6], systemStatus: p[7] };
    if (frame.id === 1 && p.length >= 19)
        return { kind: 'system', sensorsPresent: p.readUInt32LE(0), sensorsEnabled: p.readUInt32LE(4), sensorsHealth: p.readUInt32LE(8), voltage: p.readUInt16LE(14) / 1000, current: p.readInt16LE(16) / 100, battery: p.readInt8(18) };
    if (frame.id === 24 && p.length >= 30)
        return { kind: 'gps', lat: p.readInt32LE(8) / 1e7, lon: p.readInt32LE(12) / 1e7, altitude: p.readInt32LE(16) / 1000, fix: p[28], satellites: p[29] };
    if (frame.id === 33 && p.length >= 28)
        return { kind: 'position', lat: p.readInt32LE(4) / 1e7, lon: p.readInt32LE(8) / 1e7, altitude: p.readInt32LE(12) / 1000, relativeAltitude: p.readInt32LE(16) / 1000, heading: p.readUInt16LE(26) / 100 };
    if (frame.id === 74 && p.length >= 20)
        return { kind: 'hud', groundSpeed: p.readFloatLE(4), heading: p.readInt16LE(8), throttle: p.readUInt16LE(10), altitude: p.readFloatLE(12), climb: p.readFloatLE(16) };
    if (frame.id === 253 && p.length >= 2) {
        const end = p.indexOf(0, 1);
        return { kind: 'statusText', severity: p[0], text: p.subarray(1, end < 0 ? Math.min(p.length, 51) : end).toString('utf8') };
    }
    return undefined;
}
