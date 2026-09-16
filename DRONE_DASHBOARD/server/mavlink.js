import { EventEmitter } from 'node:events';
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
    if (frame.id === 1 && p.length >= 31)
        return { kind: 'system', voltage: p.readUInt16LE(14) / 1000, current: p.readInt16LE(16) / 100, battery: p.readInt8(30) };
    if (frame.id === 24 && p.length >= 30)
        return { kind: 'gps', lat: p.readInt32LE(8) / 1e7, lon: p.readInt32LE(12) / 1e7, altitude: p.readInt32LE(16) / 1000, fix: p[28], satellites: p[29] };
    if (frame.id === 33 && p.length >= 28)
        return { kind: 'position', lat: p.readInt32LE(4) / 1e7, lon: p.readInt32LE(8) / 1e7, altitude: p.readInt32LE(12) / 1000, relativeAltitude: p.readInt32LE(16) / 1000, heading: p.readUInt16LE(26) / 100 };
    if (frame.id === 74 && p.length >= 20)
        return { kind: 'hud', groundSpeed: p.readFloatLE(4), heading: p.readInt16LE(8), throttle: p.readUInt16LE(10), altitude: p.readFloatLE(12), climb: p.readFloatLE(16) };
    return undefined;
}
