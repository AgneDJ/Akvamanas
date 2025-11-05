const BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

export async function uploadExcel(file){
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${BASE}/api/upload`, { method:'POST', body: fd });
  return res.json();
}
export async function trainExcel(file){
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${BASE}/api/train`, { method:'POST', body: fd });
  return res.json();
}
export async function applySettings(file){
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${BASE}/api/settings`, { method:'POST', body: fd });
  return res.json();
}
export async function getSettings(){
  const res = await fetch(`${BASE}/api/settings`);
  return res.json();
}
export async function forecast(filePath){
  const res = await fetch(`${BASE}/api/forecast`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ filePath })
  });
  return res.json();
}
export function downloadLatest(){ window.location.href = `${BASE}/api/download`; }
