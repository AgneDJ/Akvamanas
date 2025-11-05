import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { loadInputsFromExcel, writeForecastToExcel, readStationsFromExcel } from './utils/excel.js';
import { trainModelFromHistorical, forecastWaterLevels, loadModel, saveModel } from './utils/regression.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const MODEL_DIR = path.join(__dirname, 'model');
for (const d of [UPLOAD_DIR, OUTPUT_DIR, MODEL_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

const MODEL_PATH = path.join(MODEL_DIR, 'model.json');
if (!fs.existsSync(MODEL_PATH)) fs.writeFileSync(MODEL_PATH, JSON.stringify({ trainedAt: null, stations: {} }, null, 2), 'utf8');

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const { currentInputs, settings } = await loadInputsFromExcel(filePath);
    return res.json({ ok: true, filePath, currentInputsCount: currentInputs.length, settingsCount: settings.length });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/train', upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const model = await loadModel(MODEL_PATH);
    const updated = await trainModelFromHistorical(filePath, model);
    await saveModel(MODEL_PATH, updated);
    return res.json({ ok: true, trainedAt: updated.trainedAt, stations: Object.keys(updated.stations).length });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/forecast', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath || !fs.existsSync(filePath)) throw new Error('Missing or invalid filePath');

    const model = await loadModel(MODEL_PATH);
    const { currentInputs, settings } = await loadInputsFromExcel(filePath);
    const { rows, table } = await forecastWaterLevels(currentInputs, settings, model);

    const outPath = path.join(OUTPUT_DIR, `forecast_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.xlsx`);
    await writeForecastToExcel(outPath, rows);

    return res.json({ ok: true, outPath, table });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('.xlsx'))
      .map(f => ({ f, t: fs.statSync(path.join(OUTPUT_DIR, f)).mtime.getTime() }))
      .sort((a,b) => b.t - a.t);
    if (files.length === 0) return res.status(404).send('No forecast file');
    const latest = path.join(OUTPUT_DIR, files[0].f);
    res.download(latest);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post('/api/settings', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Upload stations_template.xlsx with the new settings' });
    const settings = await readStationsFromExcel(req.file.path);
    const settingsPath = path.join(MODEL_DIR, 'stations_settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ updatedAt: new Date().toISOString(), settings }, null, 2), 'utf8');
    return res.json({ ok: true, updatedAt: new Date().toISOString(), count: settings.length });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  const settingsPath = path.join(MODEL_DIR, 'stations_settings.json');
  if (!fs.existsSync(settingsPath)) return res.json({ ok: true, settings: [] });
  const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return res.json({ ok: true, settings: raw.settings, updatedAt: raw.updatedAt });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`AKVAMANAS backend listening on http://localhost:${PORT}`));
