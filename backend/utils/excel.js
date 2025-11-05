import XLSX from 'xlsx';
import fs from 'fs';

export async function loadInputsFromExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const current = XLSX.utils.sheet_to_json(wb.Sheets['current_inputs'] || {}, { defval: null });
  const settings = XLSX.utils.sheet_to_json(wb.Sheets['settings'] || {}, { defval: null });
  return {
    currentInputs: current.map(r => ({
      date: toDate(r.date),
      station_code: String(r.station_code || '').trim(),
      station_name: r.station_name || '',
      river_name: r.river_name || '',
      water_level_cm: num(r.water_level_cm),
      precipitation_mm: num(r.precipitation_mm),
      air_temp_c: num(r.air_temp_c),
      wind_speed_mps: num(r.wind_speed_mps),
      wind_dir_deg: num(r.wind_dir_deg),
      rh_pct: num(r.rh_pct),
      roughness_n: num(r.roughness_n)
    })),
    settings: settings.map(r => ({
      station_code: String(r.station_code || '').trim(),
      station_name: r.station_name || '',
      river_name: r.river_name || '',
      datum_offset_cm: num(r.datum_offset_cm),
      min_level_cm: num(r.min_level_cm),
      max_level_cm: num(r.max_level_cm),
      roughness_n: num(r.roughness_n)
    }))
  };
}

export async function readStationsFromExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const settings = XLSX.utils.sheet_to_json(wb.Sheets['settings'] || {}, { defval: null });
  return settings.map(r => ({
    station_code: String(r.station_code || '').trim(),
    station_name: r.station_name || '',
    river_name: r.river_name || '',
    datum_offset_cm: num(r.datum_offset_cm),
    min_level_cm: num(r.min_level_cm),
    max_level_cm: num(r.max_level_cm),
    roughness_n: num(r.roughness_n)
  }));
}

export async function writeForecastToExcel(outPath, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'forecast');
  XLSX.writeFile(wb, outPath);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toDate(v) {
  if (!v) return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0,10);
  }
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0,10);
}
