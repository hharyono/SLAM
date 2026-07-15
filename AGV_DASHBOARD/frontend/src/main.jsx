import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function MapView({ map, robot }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!map || !ref.current) return;
    const canvas = ref.current, ctx = canvas.getContext('2d');
    const scale = Math.min(canvas.width / map.width, canvas.height / map.height);
    const ox = (canvas.width - map.width * scale) / 2, oy = (canvas.height - map.height * scale) / 2;
    const raw = Uint8Array.from(atob(map.pixels), c => c.charCodeAt(0));
    const image = new ImageData(map.width, map.height);
    for (let i = 0; i < raw.length; i++) image.data.set([raw[i], raw[i], raw[i], 255], i * 4);
    const offscreen = document.createElement('canvas'); offscreen.width = map.width; offscreen.height = map.height;
    offscreen.getContext('2d').putImageData(image, 0, 0);
    ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(offscreen, ox, oy, map.width * scale, map.height * scale);
    if (!robot?.pose) return;
    const cos = Math.cos(map.origin.yaw), sin = Math.sin(map.origin.yaw);
    const dx = robot.pose.x - map.origin.x, dy = robot.pose.y - map.origin.y;
    const mx = (cos * dx + sin * dy) / map.resolution;
    const my = (-sin * dx + cos * dy) / map.resolution;
    const x = ox + mx * scale, y = oy + (map.height - my) * scale;
    ctx.save(); ctx.translate(x, y); ctx.rotate(-(robot.pose.yaw - map.origin.yaw));
    ctx.fillStyle = robot.pose.valid ? '#22c55e' : '#ef4444';
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-10, -9); ctx.lineTo(-6, 0); ctx.lineTo(-10, 9); ctx.closePath(); ctx.fill();
    ctx.restore();
  }, [map, robot]);
  return <canvas ref={ref} width="900" height="650" />;
}

function App() {
  const [map, setMap] = useState(); const [robots, setRobots] = useState({}); const [notice, setNotice] = useState('');
  useEffect(() => { fetch('/api/map').then(r => r.json()).then(setMap); }, []);
  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    ws.onmessage = event => { const msg = JSON.parse(event.data);
      if (msg.type === 'snapshot') setRobots(Object.fromEntries(msg.data.map(r => [r.robot_id, r])));
      if (msg.type === 'robot_status') setRobots(old => ({ ...old, [msg.data.robot_id]: msg.data }));
      if (msg.type === 'command_ack') setNotice(`${msg.data.command} diterima robot`);
    }; return () => ws.close();
  }, []);
  const robot = Object.values(robots)[0];
  const mission = async action => { setNotice(`Mengirim ${action}...`);
    const response = await fetch(`/api/robots/${robot.robot_id}/mission/${action}`, { method: 'POST' });
    if (!response.ok) setNotice((await response.json()).error); };
  return <main><header><div><p className="eyebrow">LUCKFOX · AGV CONTROL</p><h1>Ruang Utama</h1></div>
    <span className={`connection ${robot?.online ? 'online' : ''}`}>{robot?.online ? 'ONLINE' : 'OFFLINE'}</span></header>
    <section className="layout"><div className="map"><MapView map={map} robot={robot}/></div><aside>
      <div className="card"><span>Robot</span><strong>{robot?.robot_id || 'Menunggu...'}</strong></div>
      <div className="metrics"><div><span>X</span><b>{robot?.pose?.x?.toFixed(2) ?? '—'} m</b></div><div><span>Y</span><b>{robot?.pose?.y?.toFixed(2) ?? '—'} m</b></div><div><span>Yaw</span><b>{robot?.pose ? (robot.pose.yaw * 180 / Math.PI).toFixed(1) : '—'}°</b></div><div><span>Score</span><b>{robot?.pose?.score?.toFixed(3) ?? '—'}</b></div></div>
      <div className="card"><span>Localization</span><strong>{robot?.pose?.mode?.toUpperCase() || 'UNKNOWN'}</strong><small>{robot?.pose?.valid ? 'Pose valid' : 'Pose belum valid'}</small></div>
      <div className="card"><span>Power</span><strong>{robot?.power?.percent >= 0 ? `${robot.power.percent.toFixed(0)}%` : 'N/A'}</strong><small>{robot?.power?.voltage > 0 ? `${robot.power.voltage.toFixed(1)} V` : 'Sensor belum terhubung'}</small></div>
      <button disabled={!robot?.online} onClick={() => mission('start')}>START MISSION</button><button className="stop" disabled={!robot?.online} onClick={() => mission('stop')}>STOP MISSION</button>
      <p className="notice">{notice}</p></aside></section></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
