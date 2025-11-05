import XLSX from "xlsx";
import fs from "fs";

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseHour(h) {
  if (h == null || h === "") return null;
  const s = String(h).trim();
  if (s.match(/^\d{1,2}:\d{2}$/)) return s;
  const n = Number(s);
  if (Number.isFinite(n)) return String(n).padStart(2, "0") + ":00";
  return null;
}
function key(...parts) {
  return parts
    .map((x) =>
      String(x ?? "")
        .trim()
        .toLowerCase()
    )
    .join("|");
}

export function readStationsMeta(filePath) {
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["stations_meta"] || {}, {
    defval: null,
  });
  return rows.map((r) => ({
    station_code: String(r.station_code || "").trim(),
    station_id: r.station_id ?? null,
    station_name: r.station_name || "",
    river_name: r.river_name || "",
    basin_name: r.basin_name || "",
    x: num(r.x),
    y: num(r.y),
    station_level_cm: num(r.station_level_cm),
    datum_offset_cm: num(r.datum_offset_cm),
    min_level_cm: num(r.min_level_cm),
    max_level_cm: num(r.max_level_cm),
    roughness_n: num(r.roughness_n),
  }));
}

export function readCurrentPrecip(filePath) {
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["precip"] || {}, {
    defval: null,
  });
  return rows.map((r) => ({
    date: r.date ? new Date(r.date).toISOString().slice(0, 10) : null,
    hour_utc: parseHour(r.hour_utc),
    station_code: String(r.station_code || "").trim(),
    station_name: r.station_name || "",
    basin_name: r.basin_name || "",
    precipitation_mm: num(r.precipitation_mm),
  }));
}

export function readCurrentWater(filePath) {
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["water_levels"] || {}, {
    defval: null,
  });
  return rows.map((r) => ({
    date: r.date ? new Date(r.date).toISOString().slice(0, 10) : null,
    hour_utc: parseHour(r.hour_utc),
    station_code: String(r.station_code || "").trim(),
    station_name: r.station_name || "",
    river_name: r.river_name || "",
    water_level_cm: num(r.water_level_cm),
  }));
}

export function readCurrentAir(filePath) {
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["air_temp"] || {}, {
    defval: null,
  });
  return rows.map((r) => ({
    date: r.date ? new Date(r.date).toISOString().slice(0, 10) : null,
    hour_utc: parseHour(r.hour_utc),
    station_code: String(r.station_code || "").trim(),
    station_name: r.station_name || "",
    air_temp_c: num(r.air_temp_c),
  }));
}

export function readHistoricalFile(filePath) {
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["historical"] || {}, {
    defval: null,
  });
  return rows.map((r) => ({
    datetime_utc: r.datetime_utc
      ? new Date(r.datetime_utc).toISOString().slice(0, 16) + ":00Z"
      : null,
    station_code: String(r.station_code || "").trim(),
    water_level_cm: num(r.water_level_cm),
    precipitation_mm: num(r.precipitation_mm),
    air_temp_c: num(r.air_temp_c),
    discharge_m3s: num(r.discharge_m3s),
  }));
}

export function assembleForForecast(meta, water, precip, air) {
  const metaByCode = new Map();
  const metaByName = new Map();
  for (const m of meta) {
    if (m.station_code) metaByCode.set(m.station_code, m);
    metaByName.set(key(m.river_name, m.station_name), m);
  }

  // pick latest water by station (date + hour)
  const latestWater = new Map();
  for (const w of water) {
    const k = w.station_code || key(w.river_name, w.station_name);
    if (!k) continue;
    const stamp = `${w.date}T${w.hour_utc || "00:00"}Z`;
    if (!latestWater.has(k) || latestWater.get(k).stamp < stamp) {
      latestWater.set(k, { ...w, stamp });
    }
  }

  // latest precip (prefer station; fallback basin)
  const precipByStation = new Map();
  const precipByBasin = new Map();
  for (const p of precip) {
    const stamp = `${p.date}T${p.hour_utc || "00:00"}Z`;
    if (p.station_code) {
      const prev = precipByStation.get(p.station_code);
      if (!prev || prev.stamp < stamp)
        precipByStation.set(p.station_code, { ...p, stamp });
    } else if (p.basin_name) {
      const prev = precipByBasin.get(p.basin_name);
      if (!prev || prev.stamp < stamp)
        precipByBasin.set(p.basin_name, { ...p, stamp });
    }
  }

  // latest air by station
  const airByStation = new Map();
  for (const a of air) {
    const stamp = `${a.date}T${a.hour_utc || "00:00"}Z`;
    if (a.station_code) {
      const prev = airByStation.get(a.station_code);
      if (!prev || prev.stamp < stamp)
        airByStation.set(a.station_code, { ...a, stamp });
    }
  }

  const currentInputs = [];
  for (const [k, w] of latestWater.entries()) {
    const m =
      (w.station_code && metaByCode.get(w.station_code)) ||
      metaByName.get(key(w.river_name, w.station_name)) ||
      {};
    const basin = m?.basin_name || "";
    const p =
      (w.station_code && precipByStation.get(w.station_code)) ||
      (basin && precipByBasin.get(basin)) ||
      null;
    const a = (w.station_code && airByStation.get(w.station_code)) || null;

    currentInputs.push({
      date: w.date,
      station_code: w.station_code || "",
      station_name: w.station_name || m.station_name || "",
      river_name: w.river_name || m.river_name || "",
      basin_name: basin || null,
      water_level_cm: w.water_level_cm,
      precipitation_mm: p?.precipitation_mm ?? null,
      air_temp_c: a?.air_temp_c ?? null,
      wind_speed_mps: null,
      wind_dir_deg: null,
      rh_pct: null,
      roughness_n: m?.roughness_n ?? null,
    });
  }

  const settings = meta.map((m) => ({
    station_code: m.station_code || "",
    station_id: m.station_id ?? null,
    station_name: m.station_name || "",
    river_name: m.river_name || "",
    basin_name: m.basin_name || "",
    x: m.x,
    y: m.y,
    datum_offset_cm:
      m.datum_offset_cm != null
        ? m.datum_offset_cm
        : m.station_level_cm != null
        ? m.station_level_cm
        : null,
    min_level_cm: m.min_level_cm ?? null,
    max_level_cm: m.max_level_cm ?? null,
    roughness_n: m.roughness_n ?? null,
  }));

  return { currentInputs, settings };
}
