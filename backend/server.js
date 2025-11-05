import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import {
  readStationsMeta,
  readCurrentPrecip,
  readCurrentWater,
  readCurrentAir,
  readHistoricalFile,
  assembleForForecast,
} from "./utils/excel.js";

import {
  trainModelFromHistoricalFiles,
  forecastWaterLevels,
  loadModel,
  saveModel,
} from "./utils/regression.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, "uploads"); // original name restored
const OUTPUT_DIR = path.join(__dirname, "output");
const MODEL_DIR = path.join(__dirname, "model");
for (const d of [UPLOAD_DIR, OUTPUT_DIR, MODEL_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

const MODEL_PATH = path.join(MODEL_DIR, "model.json");
if (!fs.existsSync(MODEL_PATH))
  fs.writeFileSync(
    MODEL_PATH,
    JSON.stringify({ trainedAt: null, stations: {} }, null, 2),
    "utf8"
  );
const MANIFEST_PATH = path.join(UPLOAD_DIR, "manifest.json");

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH))
    return {
      metadata: null,
      current: { precip: null, water: null, air: null },
      historical: [],
    };
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}
function saveManifest(m) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2), "utf8");
}

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/api/manifest", (req, res) => res.json(loadManifest()));

// Upload sections (separate endpoints)
app.post("/api/upload/metadata", upload.single("file"), async (req, res) => {
  const m = loadManifest();
  m.metadata = req.file.path;
  saveManifest(m);
  const rows = readStationsMeta(req.file.path);
  res.json({ ok: true, count: rows.length, path: req.file.path });
});

app.post(
  "/api/upload/current/precip",
  upload.single("file"),
  async (req, res) => {
    const m = loadManifest();
    m.current = m.current || {};
    m.current.precip = req.file.path;
    saveManifest(m);
    const rows = readCurrentPrecip(req.file.path);
    res.json({ ok: true, count: rows.length, path: req.file.path });
  }
);

app.post(
  "/api/upload/current/water",
  upload.single("file"),
  async (req, res) => {
    const m = loadManifest();
    m.current = m.current || {};
    m.current.water = req.file.path;
    saveManifest(m);
    const rows = readCurrentWater(req.file.path);
    res.json({ ok: true, count: rows.length, path: req.file.path });
  }
);

app.post("/api/upload/current/air", upload.single("file"), async (req, res) => {
  const m = loadManifest();
  m.current = m.current || {};
  m.current.air = req.file.path;
  saveManifest(m);
  const rows = readCurrentAir(req.file.path);
  res.json({ ok: true, count: rows.length, path: req.file.path });
});

app.post(
  "/api/upload/historical",
  upload.array("files", 100),
  async (req, res) => {
    const m = loadManifest();
    m.historical = m.historical || [];
    for (const f of req.files) m.historical.push(f.path);
    saveManifest(m);
    res.json({
      ok: true,
      files: req.files.map((f) => f.path),
      total: m.historical.length,
    });
  }
);

// Forecast uses the latest uploads in manifest
app.post("/api/forecast", async (req, res) => {
  try {
    const m = loadManifest();
    if (!m.metadata || !m.current?.water)
      throw new Error("Missing metadata or current water levels uploads");
    const meta = readStationsMeta(m.metadata);
    const water = readCurrentWater(m.current.water);
    const precip = m.current?.precip ? readCurrentPrecip(m.current.precip) : [];
    const air = m.current?.air ? readCurrentAir(m.current.air) : [];
    const { currentInputs, settings } = assembleForForecast(
      meta,
      water,
      precip,
      air
    );

    const model = await loadModel(MODEL_PATH);
    const { rows, table } = await forecastWaterLevels(
      currentInputs,
      settings,
      model
    );

    const outPath = path.join(
      OUTPUT_DIR,
      `forecast_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.xlsx`
    );
    const XLSX = (await import("xlsx")).default;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "forecast");
    XLSX.writeFile(wb, outPath);

    res.json({ ok: true, outPath, table });
  } catch (e) {
    console.error(e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Train from all historical files currently in manifest
app.post("/api/train", async (req, res) => {
  try {
    const m = loadManifest();
    const model = await loadModel(MODEL_PATH);
    const updated = await trainModelFromHistoricalFiles(
      m.historical || [],
      model
    );
    await saveModel(MODEL_PATH, updated);
    res.json({
      ok: true,
      trainedAt: updated.trainedAt,
      stations: Object.keys(updated.stations).length,
    });
  } catch (e) {
    console.error(e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Download latest forecast
app.get("/api/download", async (req, res) => {
  try {
    const files = fs
      .readdirSync(OUTPUT_DIR)
      .filter((f) => f.endsWith(".xlsx"))
      .map((f) => ({
        f,
        t: fs.statSync(path.join(OUTPUT_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.t - a.t);
    if (files.length === 0) return res.status(404).send("No forecast file");
    const latest = path.join(OUTPUT_DIR, files[0].f);
    res.download(latest);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`AKVAMANAS backend listening on http://localhost:${PORT}`)
);
