import React, { useState } from 'react'
import { uploadExcel, trainExcel, forecast, downloadLatest, applySettings, getSettings } from './api'

export default function App(){
  const [uploadInfo, setUploadInfo] = useState(null)
  const [filePath, setFilePath] = useState('')
  const [table, setTable] = useState([])
  const [settingsMeta, setSettingsMeta] = useState(null)
  const [busy, setBusy] = useState(false)

  const onUpload = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setBusy(true)
    const res = await uploadExcel(f)
    setBusy(false)
    setUploadInfo(res)
    setFilePath(res.filePath)
  }

  const onTrain = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setBusy(true)
    const res = await trainExcel(f)
    setBusy(false)
    alert(res.ok ? `Trained ${res.stations} station(s)` : res.error)
  }

  const onSettings = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setBusy(true)
    const res = await applySettings(f)
    setBusy(false)
    setSettingsMeta(res)
    if (!res.ok) alert(res.error)
  }

  const onGetSettings = async () => {
    setBusy(true)
    const res = await getSettings()
    setBusy(false)
    setSettingsMeta(res)
  }

  const onForecast = async () => {
    if (!filePath) { alert('First upload current inputs (Excel)'); return }
    setBusy(true)
    const res = await forecast(filePath)
    setBusy(false)
    if (!res.ok) { alert(res.error); return }
    setTable(res.table || [])
  }

  return (
    <div style={{ fontFamily:'Inter, system-ui, Arial', padding:20, maxWidth:1200, margin:'0 auto' }}>
      <h1 style={{ marginBottom:8 }}>AKVAMANAS</h1>
      <p style={{ marginTop:0, color:'#555' }}>User‑friendly Lithuanian river water level model (prototype).</p>

      <section style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginTop:16 }}>
        <div style={{ border:'1px solid #ddd', borderRadius:12, padding:16 }}>
          <h3>1) Upload current inputs (Excel)</h3>
          <input type="file" accept=".xlsx" onChange={onUpload} />
          {uploadInfo?.ok && (
            <p style={{ color:'#0a0' }}>
              Loaded rows: {uploadInfo.currentInputsCount} (settings rows: {uploadInfo.settingsCount})<br/>
              File: <code>{filePath}</code>
            </p>
          )}
        </div>

        <div style={{ border:'1px solid #ddd', borderRadius:12, padding:16 }}>
          <h3>2) Train model (historical Excel)</h3>
          <input type="file" accept=".xlsx" onChange={onTrain} />
          <p style={{ fontSize:12, color:'#666' }}>Can be done anytime to improve per‑station coefficients.</p>
        </div>

        <div style={{ border:'1px solid #ddd', borderRadius:12, padding:16 }}>
          <h3>3) Station settings</h3>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <input type="file" accept=".xlsx" onChange={onSettings} />
            <button onClick={onGetSettings}>Show current settings</button>
          </div>
          <pre style={{ background:'#f8f8f8', padding:8, borderRadius:8, maxHeight:160, overflow:'auto' }}>
{JSON.stringify(settingsMeta, null, 2)}
          </pre>
        </div>

        <div style={{ border:'1px solid #ddd', borderRadius:12, padding:16 }}>
          <h3>4) Forecast</h3>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <button onClick={onForecast} disabled={busy}>Calculate</button>
            <button onClick={downloadLatest}>Download Excel</button>
          </div>
          {busy && <p>Processing...</p>}
        </div>
      </section>

      <h3 style={{ marginTop:24 }}>Forecast table</h3>
      <div style={{ overflowX:'auto' }}>
        <table style={{ borderCollapse:'collapse', width:'100%' }}>
          <thead>
            <tr>
              <th style={th}>River</th>
              <th style={th}>Station</th>
              <th style={th}>Today</th>
              <th style={th}>Tomorrow</th>
              <th style={th}>Day after</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r,i)=>(
              <tr key={i}>
                <td style={td}>{r.river}</td>
                <td style={td}>{r.station}</td>
                <td style={td}>{r.wl_today_cm}</td>
                <td style={td}>{r.wl_tomorrow_cm}</td>
                <td style={td}>{r.wl_day_after_cm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize:12, color:'#666', marginTop:16 }}>
        Dates generated: {table[0]?.date_today || '—'} (D), next two days automatically.
      </p>
    </div>
  )
}

const th = { textAlign:'left', borderBottom:'1px solid #ddd', padding:'8px 6px' }
const td = { borderBottom:'1px solid #eee', padding:'8px 6px' }
