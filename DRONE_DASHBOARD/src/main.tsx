import React from 'react'
import ReactDOM from 'react-dom/client'
import mpegts from 'mpegts.js'
import './style.css'

type State={connected:boolean,lastUpdate:number,battery:number|null,voltage:number|null,current:number|null,lat:number|null,lon:number|null,altitude:number|null,relativeAltitude:number|null,groundSpeed:number|null,heading:number|null,climb:number|null,gpsFix:number|null,satellites:number|null,armed:boolean,customMode:number|null,landing:{raw:string,tag:string,inference:number|null,x:number|null,y:number|null,z:number|null,lastUpdate:number}|null}
const initial:State={connected:false,lastUpdate:0,battery:null,voltage:null,current:null,lat:null,lon:null,altitude:null,relativeAltitude:null,groundSpeed:null,heading:null,climb:null,gpsFix:null,satellites:null,armed:false,customMode:null,landing:null}
const fmt=(v:number|null,d=1)=>v==null?'—':v.toFixed(d)
const gpsNames:Record<number,string>={3:'3D Fix',4:'DGPS',5:'RTK Float',6:'RTK Fixed'}
const gpsName=(v:number|null)=>v==null?'No GPS':gpsNames[v]||`Fix ${v}`

function Video(){const ref=React.useRef<HTMLVideoElement>(null);const [status,setStatus]=React.useState('Connecting video…')
  React.useEffect(()=>{if(!ref.current||!mpegts.isSupported()){setStatus('Browser does not support MPEG-TS/MSE');return}
    const scheme=location.protocol==='https:'?'wss':'ws';const player=mpegts.createPlayer({type:'mpegts',isLive:true,url:`${scheme}://${location.host}/video`},{enableWorker:true,enableStashBuffer:false,stashInitialSize:64,liveBufferLatencyChasing:true});player.attachMediaElement(ref.current);player.load();Promise.resolve(player.play()).then(()=>setStatus('Live')).catch(()=>setStatus('Click video to play'));const video=ref.current;const play=()=>{Promise.resolve(player.play()).catch(()=>{})};video.addEventListener('click',play);return()=>{video.removeEventListener('click',play);player.destroy()}}
  ,[]);return <div className="video"><video ref={ref} muted autoPlay playsInline/><span className="videoState">● {status}</span></div>}
function Card({label,value,unit,accent}:{label:string,value:string,unit?:string,accent?:boolean}){return <div className={`card ${accent?'accent':''}`}><small>{label}</small><strong>{value}</strong>{unit&&<span>{unit}</span>}</div>}
function App(){const [s,setS]=React.useState(initial);const [lines,setLines]=React.useState<string[]>([])
  React.useEffect(()=>{const scheme=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(`${scheme}://${location.host}/telemetry`);ws.onmessage=e=>{const next=JSON.parse(e.data) as State;setS(next);if(next.landing?.raw)setLines(old=>old.at(-1)===next.landing!.raw?old:[...old.slice(-59),next.landing!.raw])};return()=>ws.close()},[])
  const landingFresh=!!s.landing&&Date.now()-s.landing.lastUpdate<1500
  return <main><header><div><p className="eyebrow">LUCKFOX · MAVLINK</p><h1>Drone Dashboard</h1></div><div className={`connection ${s.connected?'online':''}`}><i/>{s.connected?'MAVLink connected':'MAVLink offline'}</div></header>
    <section className="hero"><Video/><aside className="landing"><div className="sectionTitle"><span>Precision landing</span><b className={landingFresh&&s.landing?.tag==='FOUND'?'found':''}>{landingFresh?s.landing?.tag:'NO DATA'}</b></div><div className="target"><div><small>X</small><strong>{fmt(s.landing?.x??null,3)}</strong><span>m</span></div><div><small>Y</small><strong>{fmt(s.landing?.y??null,3)}</strong><span>m</span></div><div><small>Z</small><strong>{fmt(s.landing?.z??null,3)}</strong><span>m</span></div></div><div className="rate"><span>Inference rate</span><strong>{fmt(s.landing?.inference??null,1)} Hz</strong></div></aside></section>
    <section className="grid"><Card label="BATTERY" value={fmt(s.battery,0)} unit="%" accent/><Card label="VOLTAGE" value={fmt(s.voltage,2)} unit="V"/><Card label="CURRENT" value={fmt(s.current,1)} unit="A"/><Card label="REL. ALTITUDE" value={fmt(s.relativeAltitude,1)} unit="m"/><Card label="GROUND SPEED" value={fmt(s.groundSpeed,1)} unit="m/s"/><Card label="HEADING" value={fmt(s.heading,0)} unit="°"/><Card label="GPS" value={gpsName(s.gpsFix)} unit={`${s.satellites??'—'} sats`}/><Card label="VEHICLE" value={s.armed?'ARMED':'DISARMED'} accent={s.armed}/></section>
    <section className="location"><div><small>LATITUDE</small><strong>{fmt(s.lat,7)}</strong></div><div><small>LONGITUDE</small><strong>{fmt(s.lon,7)}</strong></div><div><small>MSL ALTITUDE</small><strong>{fmt(s.altitude,1)} m</strong></div></section>
    <section className="console"><div className="sectionTitle"><span>Luckfox landing console</span><b>UDP :14551</b></div><pre>{lines.length?lines.map((x,i)=><div key={i}><em>{new Date().toLocaleTimeString()}</em> {x}</div>):'Waiting for landing status…'}</pre></section>
  </main>}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
