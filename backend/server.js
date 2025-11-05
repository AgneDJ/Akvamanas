// backend/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import XLSX from "xlsx";

import {
  writeForecastWorkbook,
  timestampedOutPath,
  ensureDir,
} from "./utils/excel.js";

import {
  trainModelFromHistoricalFiles,
  loadModel,
  saveModel,
  forecastWaterLevels,
} from "./utils/regression.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --- Storage layout
const DATA_DIR = path.join(__dirname, "data");
const CURRENT_DIR = path.join(DATA_DIR, "current");
const HIST_DIR = path.join(DATA_DIR, "historical");
const META_DIR = path.join(DATA_DIR, "metadata");
const HYDRO_DIR = path.join(DATA_DIR, "hydro");
const MODEL_DIR = path.join(__dirname, "model");
const OUT_DIR = path.join(__dirname, "output");

[
  DATA_DIR,
  CURRENT_DIR,
  HIST_DIR,
  META_DIR,
  HYDRO_DIR,
  MODEL_DIR,
  OUT_DIR,
].forEach(ensureDir);

const upload = multer({ dest: path.join(DATA_DIR, "__tmp") });

// --- In-memory state / manifest
const STATE = {
  // inputs presence/paths
  manifest: {
    metadata: null, // stations_metadata.xlsx
    current: { water: null, precip: null, air: null },
    historical: [], // array of files
    hydro: { network: null, rating: null, basin: null },
  },

  // parsed/compiled data caches
  settings: [], // stations_meta rows
  currentInputs: [], // merged current rows
  hydroAux: { network: [], rating: new Map(), basins: new Map() },
  model: { stations: {}, trainedAt: null },

  lastForecastPath: null,
  lastForecastJson: null, // { daily, hourly, series }
};

// -------- Helpers: read sheets ----------
function readSheet(filePath, sheetName, defval = null) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval });
}

// Merge current inputs from water/precip/air + stations metadata (by station_code)
function buildCurrentInputs() {
  const { manifest } = STATE;
  const md = STATE.settings || [];

  // map station_code -> metadata snippet
  const mdByCode = new Map(
    md.map((r) => [String(r.station_code ?? r.station_code).trim(), r])
  );

  // Read each current file (hourly rows)
  const water = manifest.current.water
    ? readSheet(manifest.current.water, "water_levels")
    : [];
  const precip = manifest.current.precip
    ? readSheet(manifest.current.precip, "precip")
    : [];
  const air = manifest.current.air
    ? readSheet(manifest.current.air, "air_temp")
    : [];

  // latest (or matching hour) strategy — we’ll just attach same-hour by station_code if available;
  // otherwise use per-station latest found
  const latestByKey = (rows, keyCols) => {
    const map = new Map();
    for (const r of rows) {
      const key =
        keyCols.map((k) => String(r[k] ?? "")).join("|") ||
        String(r.station_code ?? "");
      const t = new Date(r.datetime_utc ?? r.forecast_datetime ?? 0).getTime();
      const prev = map.get(key);
      if (!prev || t >= prev._t) {
        map.set(key, { ...r, _t: t });
      }
    }
    return map;
  };

  const wLatest = latestByKey(water, ["station_code"]);
  const pLatest = latestByKey(precip, ["station_code"]);
  const aLatest = latestByKey(air, ["station_code"]);

  // Build currentInputs array
  const allCodes = new Set([
    ...Array.from(wLatest.keys()),
    ...Array.from(pLatest.keys()),
    ...Array.from(aLatest.keys()),
  ]);

  const out = [];
  for (const code of allCodes) {
    const w = wLatest.get(code) || {};
    const p = pLatest.get(code) || {};
    const a = aLatest.get(code) || {};
    const m = mdByCode.get(String(code)) || {};
    out.push({
      station_code: String(code),
      station_name: m.station_name || w.station_name || a.station_name || "",
      river_name: m.river_name || w.river_name || "",
      basin_name: m.basin_name || p.basin_name || "",
      water_level_cm: toNum(w.water_level_cm),
      precipitation_mm: toNum(p.precipitation_mm),
      air_temp_c: toNum(a.air_temp_c),
      wind_speed_mps: toNum(null),
      wind_dir_deg: toNum(null),
      rh_pct: toNum(null),
      roughness_n: toNum(m.roughness_n),
    });
  }
  return out;
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Build hydro auxiliaries: network, rating curves, basins
function buildHydroAux() {
  const { manifest } = STATE;
  const aux = { network: [], rating: new Map(), basins: new Map() };

  // network
  if (manifest.hydro.network) {
    aux.network = readSheet(manifest.hydro.network, "reaches");
  }

  // rating
  if (manifest.hydro.rating) {
    const rows = readSheet(manifest.hydro.rating, "rating");
    for (const r of rows) {
      const code = String(r.station_code ?? "").trim();
      if (!code) continue;
      aux.rating.set(code, {
        h0_cm: toNum(r.h0_cm),
        a: toNum(r.a),
        b: toNum(r.b),
      });
    }
  }

  // basins
  if (manifest.hydro.basin) {
    const rows = readSheet(manifest.hydro.basin, "basins");
    for (const r of rows) {
      const name = String(r.basin_name ?? "").trim();
      if (!name) continue;
      aux.basins.set(name, {
        runoff_coeff: toNum(r.runoff_coeff),
        baseflow_cms: toNum(r.baseflow_cms),
      });
    }
  }

  return aux;
}

// Assemble context used by /api/forecast
function assembleRunContext() {
  STATE.currentInputs = buildCurrentInputs();
  STATE.hydroAux = buildHydroAux();
  return {
    currentInputs: STATE.currentInputs,
    settings: STATE.settings,
    model: STATE.model,
    hydroAux: STATE.hydroAux,
  };
}

// -------- Routes: health & manifest ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/api/manifest", (req, res) => {
  res.json({ ...STATE.manifest, historical: STATE.manifest.historical });
});

// -------- Uploads ----------
app.post("/api/upload/metadata", upload.single("file"), (req, res) => {
  const dst = path.join(META_DIR, "stations_metadata.xlsx");
  fs.renameSync(req.file.path, dst);
  STATE.manifest.metadata = dst;

  // load stations_meta
  STATE.settings = readSheet(dst, "stations_meta");

  res.json({ ok: true, path: dst, rows: STATE.settings.length });
});

app.post("/api/upload/current/water", upload.single("file"), (req, res) => {
  const dst = path.join(CURRENT_DIR, "current_water_levels.xlsx");
  fs.renameSync(req.file.path, dst);
  STATE.manifest.current.water = dst;
  res.json({ ok: true, path: dst });
});

app.post("/api/upload/current/precip", upload.single("file"), (req, res) => {
  const dst = path.join(CURRENT_DIR, "current_precipitation.xlsx");
  fs.renameSync(req.file.path, dst);
  STATE.manifest.current.precip = dst;
  res.json({ ok: true, path: dst });
});

app.post("/api/upload/current/air", upload.single("file"), (req, res) => {
  const dst = path.join(CURRENT_DIR, "current_air_temperature.xlsx");
  fs.renameSync(req.file.path, dst);
  STATE.manifest.current.air = dst;
  res.json({ ok: true, path: dst });
});

app.post("/api/upload/historical", upload.array("files"), (req, res) => {
  const saved = [];
  for (const f of req.files) {
    const dst = path.join(HIST_DIR, f.originalname || f.filename);
    fs.renameSync(f.path, dst);
    STATE.manifest.historical.push(dst);
    saved.push(dst);
  }
  res.json({ ok: true, saved });
});

// Hydrology auxiliaries
app.post("/api/upload/network", upload.single("file"), (req, res) => {
  const dst = path.join(HYDRO_DIR, "network_reaches.xlsx");
  fs.renameSync(req.file.path, dst);
  STATE.manifest.hydro.network = dst;
  res.json({ ok: true, path: dst });
});
app.post("/api/upload/rating", upload.single("file"), (req, res) => {
  const dst = path.join(HYDRO_DIR, "rating_curves.xlsx");
  fs.renameSync(req.file.path, dst);
  STATE.manifest.hydro.rating = dst;
  res.json({ ok: true, path: dst });
});
app.post("/api/upload/basin", upload.single("file"), (req, res) => {
  const dst = path.join(HYDRO_DIR, "basin_params.xlsx");
  fs.renameSync(req.file.path, dst);
  STATE.manifest.hydro.basin = dst;
  res.json({ ok: true, path: dst });
});

// -------- Train ----------
app.post("/api/train", async (req, res) => {
  try {
    const files = STATE.manifest.historical || [];
    if (!files.length) {
      return res
        .status(400)
        .json({ ok: false, error: "No historical files uploaded." });
    }
    // Load existing model if present
    const modelPath = path.join(MODEL_DIR, "model.json");
    if (fs.existsSync(modelPath)) {
      STATE.model = await loadModel(modelPath);
    }

    STATE.model = await trainModelFromHistoricalFiles(files, STATE.model);
    await saveModel(modelPath, STATE.model);

    res.json({
      ok: true,
      trainedAt: STATE.model.trainedAt,
      stations: Object.keys(STATE.model?.stations || {}).length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------- Forecast ----------
app.post("/api/forecast", async (req, res) => {
  try {
    const ctx = assembleRunContext();
    const { rows, table, series } = await forecastWaterLevels(
      ctx.currentInputs,
      ctx.settings,
      ctx.model,
      ctx.hydroAux
    );

    const outPath = timestampedOutPath(OUT_DIR, "forecast", "xlsx");
    writeForecastWorkbook(outPath, table, rows);

    STATE.lastForecastPath = outPath;
    STATE.lastForecastJson = { daily: table, hourly: rows, series };

    res.json({ ok: true, table, hourly: rows, series, excel_path: outPath });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// convenience: hourly-only JSON
app.get("/api/forecast/hourly", (req, res) => {
  res.json({ ok: true, hourly: STATE.lastForecastJson?.hourly || [] });
});

// -------- Download last Excel ----------
app.get("/api/download/latest", (req, res) => {
  const p = STATE.lastForecastPath;
  if (!p || !fs.existsSync(p)) {
    return res.status(404).json({ ok: false, error: "No forecast file yet." });
  }
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${path.basename(p)}`
  );
  res.sendFile(p);
});

// -------- Start ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`AKVAMANAS backend on http://localhost:${PORT}`);
});
