import { EventEmitter } from 'node:events'

export type MavFrame = { id:number; systemId:number; componentId:number; payload:Buffer; raw:Buffer }

let txSequence=0
function crcAccumulate(byte:number,crc:number){let tmp=byte^(crc&0xff);tmp=(tmp^(tmp<<4))&0xff;return ((crc>>8)^(tmp<<8)^(tmp<<3)^(tmp>>4))&0xffff}
function encodeV1(id:number,payload:Buffer,crcExtra:number){
  const frame=Buffer.alloc(6+payload.length+2)
  frame[0]=0xfe;frame[1]=payload.length;frame[2]=txSequence++&0xff;frame[3]=255;frame[4]=190;frame[5]=id;payload.copy(frame,6)
  let crc=0xffff;for(let i=1;i<6+payload.length;i++)crc=crcAccumulate(frame[i],crc);crc=crcAccumulate(crcExtra,crc)
  frame.writeUInt16LE(crc,6+payload.length);return frame
}

export function gcsHeartbeat(){
  const payload=Buffer.alloc(9);payload[4]=6;payload[5]=8;payload[7]=4;payload[8]=3
  return encodeV1(0,payload,50)
}

export function requestAllStreams(rateHz=4,systemId=1,componentId=1){
  const payload=Buffer.alloc(6);payload.writeUInt16LE(rateHz,0);payload[2]=systemId;payload[3]=componentId;payload[4]=0;payload[5]=1
  return encodeV1(66,payload,148)
}

// MAV_CMD_SET_MESSAGE_INTERVAL is preferred by current ArduPilot versions.
// Keep REQUEST_DATA_STREAM as a fallback for older firmware.
export function requestMessageInterval(messageId:number,rateHz=4,systemId=1,componentId=1){
  const payload=Buffer.alloc(33)
  payload.writeFloatLE(messageId,0)
  payload.writeFloatLE(rateHz>0?1_000_000/rateHz:-1,4)
  payload.writeUInt16LE(511,28)
  payload[30]=systemId;payload[31]=componentId;payload[32]=0
  return encodeV1(76,payload,152)
}

export function requestParameter(name:string,systemId=1,componentId=1){
  // PARAM_REQUEST_READ wire order is type-sorted by MAVLink: index, targets, id.
  const payload=Buffer.alloc(20);payload.writeInt16LE(-1,0);payload[2]=systemId;payload[3]=componentId
  Buffer.from(name.slice(0,16),'ascii').copy(payload,4)
  return encodeV1(20,payload,214)
}

export class MavlinkParser extends EventEmitter {
  private data=Buffer.alloc(0)
  reset(){this.data=Buffer.alloc(0)}
  push(chunk:Buffer){
    this.data=Buffer.concat([this.data,chunk])
    while(this.data.length>=8){
      const v2=this.data[0]===0xfd, v1=this.data[0]===0xfe
      if(!v1&&!v2){this.data=this.data.subarray(1);continue}
      const payloadLength=this.data[1]
      const signed=v2&&(this.data[2]&1)!==0
      const length=(v2?10:6)+payloadLength+2+(signed?13:0)
      if(this.data.length<length)return
      const id=v2?this.data[7]|(this.data[8]<<8)|(this.data[9]<<16):this.data[5]
      const systemId=v2?this.data[5]:this.data[3]
      const componentId=v2?this.data[6]:this.data[4]
      const offset=v2?10:6
      this.emit('frame',{id,systemId,componentId,payload:this.data.subarray(offset,offset+payloadLength),raw:this.data.subarray(0,length)} satisfies MavFrame)
      this.data=this.data.subarray(length)
    }
  }
}

export function decode(frame:MavFrame){
  const p=frame.payload
  if(frame.id===0&&p.length>=9)return {kind:'heartbeat',customMode:p.readUInt32LE(0),baseMode:p[6],systemStatus:p[7]} as const
  if(frame.id===1&&p.length>=19)return {kind:'system',sensorsPresent:p.readUInt32LE(0),sensorsEnabled:p.readUInt32LE(4),sensorsHealth:p.readUInt32LE(8),voltage:p.readUInt16LE(14)/1000,current:p.readInt16LE(16)/100,battery:p.readInt8(18)} as const
  if(frame.id===24&&p.length>=30)return {kind:'gps',lat:p.readInt32LE(8)/1e7,lon:p.readInt32LE(12)/1e7,altitude:p.readInt32LE(16)/1000,fix:p[28],satellites:p[29]} as const
  if(frame.id===33&&p.length>=28)return {kind:'position',lat:p.readInt32LE(4)/1e7,lon:p.readInt32LE(8)/1e7,altitude:p.readInt32LE(12)/1000,relativeAltitude:p.readInt32LE(16)/1000,heading:p.readUInt16LE(26)/100} as const
  if(frame.id===74&&p.length>=20)return {kind:'hud',groundSpeed:p.readFloatLE(4),heading:p.readInt16LE(8),throttle:p.readUInt16LE(10),altitude:p.readFloatLE(12),climb:p.readFloatLE(16)} as const
  if(frame.id===30&&p.length>=28)return {kind:'attitude',bootMs:p.readUInt32LE(0),roll:p.readFloatLE(4),pitch:p.readFloatLE(8),yaw:p.readFloatLE(12),rollSpeed:p.readFloatLE(16),pitchSpeed:p.readFloatLE(20),yawSpeed:p.readFloatLE(24)} as const
  if(frame.id===32&&p.length>=28)return {kind:'localPosition',bootMs:p.readUInt32LE(0),x:p.readFloatLE(4),y:p.readFloatLE(8),z:p.readFloatLE(12),vx:p.readFloatLE(16),vy:p.readFloatLE(20),vz:p.readFloatLE(24)} as const
  if(frame.id===22&&p.length>=25){const end=p.indexOf(0,8);return {kind:'parameter',value:p.readFloatLE(0),count:p.readUInt16LE(4),index:p.readUInt16LE(6),name:p.subarray(8,end<0?24:end).toString('ascii'),type:p[24]} as const}
  if(frame.id===253&&p.length>=2){const end=p.indexOf(0,1);return {kind:'statusText',severity:p[0],text:p.subarray(1,end<0?Math.min(p.length,51):end).toString('utf8')} as const}
  return undefined
}
