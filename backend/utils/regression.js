import XLSX from "xlsx";
import { create, all } from "mathjs";
import fs from "fs";

const math = create(all, {});

export async function loadModel(modelPath) {
  return JSON.parse(fs.readFileSync(modelPath, "utf8"));
}
export async function saveModel(modelPath, model) {
  fs.writeFileSync(modelPath, JSON.stringify(model, null, 2), "utf8");
}

function designRow(r) {
  return [
    1,
    num(r.water_level_cm),
    num(r.precipitation_mm),
    num(r.air_temp_c),
    num(r.wind_speed_mps),
    num(r.wind_dir_deg),
    num(r.rh_pct),
    num(r.roughness_n),
  ].map((v) => (v == null ? 0 : v));
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function trainModelFromHistoricalFiles(filePaths, model) {
  let all = [];
  for (const p of filePaths) {
    try {
      const wb = XLSX.readFile(p);
      const rows = XLSX.utils.sheet_to_json(wb.Sheets["historical"] || {}, {
        defval: null,
      });
      all = all.concat(rows);
    } catch {}
  }
  return trainFromRows(all, model);
}

function trainFromRows(hist, model) {
  const byStation = new Map();
  for (const r of hist) {
    const code = String(r.station_code || "").trim();
    if (!code) continue;
    if (!byStation.has(code)) byStation.set(code, []);
    byStation.get(code).push({
      date: r.datetime_utc || r.date || null,
      station_code: code,
      water_level_cm: num(r.water_level_cm),
      precipitation_mm: num(r.precipitation_mm),
      air_temp_c: num(r.air_temp_c),
      wind_speed_mps: null,
      wind_dir_deg: null,
      rh_pct: null,
      roughness_n: null,
    });
  }

  for (const [code, rows] of byStation.entries()) {
    const X = [];
    const y = [];
    rows.sort((a, b) => new Date(a.date) - new Date(b.date));
    for (let i = 0; i < rows.length - 1; i++) {
      const today = rows[i],
        tomorrow = rows[i + 1];
      if (
        String(today.station_code).trim() !==
        String(tomorrow.station_code).trim()
      )
        continue;
      const xi = designRow(today);
      const yi = num(tomorrow.water_level_cm);
      if (yi == null) continue;
      X.push(xi);
      y.push([yi]);
    }
    if (X.length < 5) continue;

    // Ridge: (X^T X + λI)^(-1) X^T y
    const XT = math.transpose(X); // p x n
    const XT_X = math.multiply(XT, X); // p x p (plain array or Matrix)
    const pDim = Array.isArray(XT_X) ? XT_X.length : XT_X.size()[0]; // handle arrays & mathjs Matrix
    const lambda = 0.001;

    // Ensure I has the same structure type as XT_X operations expect
    const I = math.identity(pDim).toArray(); // force to plain array for compatibility

    let inv;
    try {
      inv = math.inv(math.add(XT_X, math.multiply(lambda, I)));
    } catch {
      // Add tiny jitter if nearly singular
      const jitter = math.multiply(1e-6, I);
      inv = math.inv(
        math.add(math.add(XT_X, math.multiply(lambda, I)), jitter)
      );
    }

    const XT_y = math.multiply(XT, y); // p x 1
    const beta = math.multiply(inv, XT_y); // p x 1
    const coef = (Array.isArray(beta) ? beta : beta.toArray()).map((v) =>
      Array.isArray(v) ? v[0] : v
    );
    model.stations[code] = { coef };
  }

  model.trainedAt = new Date().toISOString();
  return model;
}

export async function forecastWaterLevels(currentInputs, settings, model) {
  const settingsMap = new Map();
  for (const s of settings)
    settingsMap.set(String(s.station_code || "").trim(), s);

  const rows = [];
  const table = [];

  const today = new Date();
  const dates = [0, 1, 2].map(
    (d) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + d)
  );

  const byStation = new Map();
  for (const r of currentInputs) {
    const code =
      String(r.station_code || "").trim() ||
      String(r.station_name || "").trim();
    if (!code) continue;
    byStation.set(code, r);
  }

  for (const [code, r] of byStation.entries()) {
    const s = settingsMap.get(String(r.station_code || "").trim()) || {};
    const coef =
      model.stations?.[String(r.station_code || "").trim()]?.coef || null;

    const x0 = designRow(r);
    const preds = !coef
      ? (() => {
          const wl = clamp(
            (r.water_level_cm ?? 0) + (s.datum_offset_cm ?? 0),
            s.min_level_cm,
            s.max_level_cm
          );
          return [wl, wl, wl];
        })()
      : (() => {
          const p1 = dot(coef, x0);
          const p2 = p1 * 0.98 + (r.air_temp_c ?? 0) * 0.1;
          const p3 = p2 * 0.98;
          return [p1, p2, p3].map((v) =>
            clamp(v + (s.datum_offset_cm ?? 0), s.min_level_cm, s.max_level_cm)
          );
        })();

    for (let i = 0; i < 3; i++) {
      rows.push({
        forecast_date: dates[i].toISOString().slice(0, 10),
        station_code: r.station_code || "",
        station_name: r.station_name || s.station_name || "",
        river_name: r.river_name || s.river_name || "",
        forecast_water_level_cm: Math.round((preds[i] ?? 0) * 10) / 10,
      });
    }

    table.push({
      river: r.river_name || s.river_name || "",
      station: r.station_name || s.station_name || "",
      date_today: dates[0].toISOString().slice(0, 10),
      wl_today_cm: Math.round((preds[0] ?? 0) * 10) / 10,
      wl_tomorrow_cm: Math.round((preds[1] ?? 0) * 10) / 10,
      wl_day_after_cm: Math.round((preds[2] ?? 0) * 10) / 10,
    });
  }

  rows.sort(
    (a, b) =>
      String(a.station_code).localeCompare(String(b.station_code)) ||
      a.forecast_date.localeCompare(b.forecast_date)
  );
  table.sort(
    (a, b) =>
      a.river.localeCompare(b.river) || a.station.localeCompare(b.station)
  );
  return { rows, table };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
function clamp(v, lo, hi) {
  let x = v;
  if (lo != null && x < lo) x = lo;
  if (hi != null && x > hi) x = hi;
  return x;
}
