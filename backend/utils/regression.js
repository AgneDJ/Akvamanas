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

/* ---------------- Regression training (unchanged, but bug-fixed dims) ---------------- */
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
    const X = [],
      y = [];
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

    const XT = math.transpose(X),
      XT_X = math.multiply(XT, X);
    const pDim = Array.isArray(XT_X) ? XT_X.length : XT_X.size()[0];
    const lambda = 0.001;
    const I = math.identity(pDim).toArray();

    let inv;
    try {
      inv = math.inv(math.add(XT_X, math.multiply(lambda, I)));
    } catch {
      inv = math.inv(math.add(XT_X, math.multiply(lambda + 1e-6, I)));
    }

    const XT_y = math.multiply(XT, y);
    const beta = math.multiply(inv, XT_y);
    const coef = (Array.isArray(beta) ? beta : beta.toArray()).map((v) =>
      Array.isArray(v) ? v[0] : v
    );
    model.stations[code] = { coef };
  }

  model.trainedAt = new Date().toISOString();
  return model;
}

/* ---------------- Hydrologic core ----------------
   - Convert observed stage -> Q via rating curve (per station)
   - Add basin inflow (runoff_coeff * P + baseflow)
   - Route between stations using Muskingum-like linear routing
   - Convert routed Q -> stage via inverse rating curve
-------------------------------------------------- */

function stageToQ_cm(h_cm, rc) {
  const h = Math.max((h_cm ?? 0) - (rc?.h0_cm ?? 0), 0);
  return rc ? (rc.a ?? 0.03) * Math.pow(h, rc.b ?? 1.6) : 0;
}
function qToStage_cm(Q, rc) {
  if (!rc) return 0;
  const a = rc.a ?? 0.03,
    b = rc.b ?? 1.6,
    h0 = rc.h0_cm ?? 0;
  if (a <= 0 || b <= 0) return h0;
  return h0 + Math.pow(Math.max(Q, 0) / a, 1 / b);
}

// crude wave celerity based on Manning-wide channel approximation
function celerity_mps(Q, width, depth, slope, n) {
  const A = Math.max(width * depth, 1e-3);
  const R = (width * depth) / (width + 2 * depth);
  const v = (1 / n) * Math.pow(R, 2 / 3) * Math.sqrt(Math.max(slope, 1e-6)); // Manning velocity
  return Math.max(v + Math.sqrt(Math.max(9.81 * depth, 0)), 0.1); // gravity term crude
}

function muskingumStep(Qin_up, Qprev_seg, K, X, dt) {
  // Muskingum linear routing
  const C0 = (-K * X + 0.5 * dt) / (K - K * X + 0.5 * dt);
  const C1 = (K * X + 0.5 * dt) / (K - K * X + 0.5 * dt);
  const C2 = (K - K * X - 0.5 * dt) / (K - K * X + 0.5 * dt);
  const Qout = C0 * Qin_up + C1 * Qprev_seg.in + C2 * Qprev_seg.out;
  return Math.max(Qout, 0);
}

/* Run a 72h forecast with 1h step */
export async function forecastWaterLevels(
  currentInputs,
  settings,
  model,
  hydroAux
) {
  const settingsByCode = new Map(
    settings.map((s) => [String(s.station_code || "").trim(), s])
  );
  const nowByCode = new Map();

  for (const r of currentInputs) {
    const code = String(r.station_code || "").trim();
    if (!code) continue;
    nowByCode.set(code, r);
  }

  const dates = [];
  const base = new Date();
  base.setMinutes(0, 0, 0);
  for (let i = 0; i < 72; i++)
    dates.push(new Date(base.getTime() + i * 3600 * 1000));

  // Try hydrologic path if aux present
  if (
    hydroAux?.network?.length &&
    hydroAux?.rating?.size &&
    hydroAux?.basins?.size
  ) {
    const graph = buildGraph(hydroAux.network); // array of edges with params
    const order = topoOrDepthFirst(graph); // routing order upstream -> downstream

    // initialize Q at stations from current stage via rating
    const Qnow = new Map();
    for (const [code, r] of nowByCode) {
      const rc = hydroAux.rating.get(code);
      const Q = stageToQ_cm(r.water_level_cm, rc);
      Qnow.set(code, Q);
    }

    // basin precipitation -> lateral inflow per hour (very simple)
    const PmmByBasin = aggregateLatestPrecip(currentInputs);
    const lateralByCode = new Map();
    for (const [code, r] of nowByCode) {
      const basin = (r.basin_name || "").trim();
      const bp = hydroAux.basins.get(basin);
      const runoffCoeff = bp?.runoff_coeff ?? 0.2;
      const baseflow = bp?.baseflow_cms ?? 0;
      const Pmm = PmmByBasin.get(basin) ?? r.precipitation_mm ?? 0;
      // Unit catchment not known → treat as local lateral source at station (conceptual)
      const lateralQ = baseflow + Math.max(Pmm, 0) * runoffCoeff; // m³/s per mm coeff (calibration knob)
      lateralByCode.set(code, lateralQ);
    }

    // Prepare segment parameters (K,X) from celerity and length
    const segParams = new Map(); // key: `${from}->${to}` -> {K,X,width,depth,rc_to}
    for (const e of graph) {
      const width = e.width_m ?? 40;
      const depth = e.depth_m ?? 3;
      const n = e.n_mann ?? 0.035;
      const slope = Math.max(e.slope_m_m ?? 1e-4, 1e-6);
      const L = (e.length_km ?? 1) * 1000;
      const c = celerity_mps(
        Qnow.get(e.from_code) ?? 10,
        width,
        depth,
        slope,
        n
      );
      const K = Math.max(L / c, 3600); // travel time [s], min 1h
      const X = 0.2; // weighting (0..0.5), tuneable
      segParams.set(keyEdge(e.from_code, e.to_code), {
        K,
        X,
        width,
        depth,
        rc_to: hydroAux.rating.get(e.to_code),
      });
    }

    // time stepping
    const dt = 3600; // 1h
    const rows = [];
    const tableAcc = new Map(); // station -> [today, tomorrow, +2] (last values of those days)

    // storage for previous step per edge
    const prev = new Map(); // edgeKey -> {in, out}
    for (const e of graph)
      prev.set(keyEdge(e.from_code, e.to_code), {
        in: Qnow.get(e.from_code) || 0,
        out: Qnow.get(e.to_code) || 0,
      });

    let Qstate = new Map(Qnow);
    for (let t = 0; t < dates.length; t++) {
      const isEndOfDay = dates[t].getHours() === 23; // pick last hour for UI daily snapshot

      // route along order (upstream -> downstream)
      const QinAtNode = new Map(); // accum inflow per node for this step
      for (const e of order) {
        const edgeKey = keyEdge(e.from_code, e.to_code);
        const prm = segParams.get(edgeKey);
        const Qin_up = Qstate.get(e.from_code) ?? 0;

        const prevEdge = prev.get(edgeKey) || {
          in: Qin_up,
          out: Qstate.get(e.to_code) ?? 0,
        };
        const Qout = muskingumStep(Qin_up, prevEdge, prm.K, prm.X, dt);

        // store next prev
        prev.set(edgeKey, { in: Qin_up, out: Qout });

        // accumulate to downstream node
        QinAtNode.set(e.to_code, (QinAtNode.get(e.to_code) || 0) + Qout);
      }

      // add lateral and update node Q
      const nextQ = new Map(Qstate);
      for (const [code, r] of nowByCode) {
        const lateral = lateralByCode.get(code) || 0;
        const routedIn = QinAtNode.get(code) || 0;
        const selfCarry = Qstate.get(code) || 0; // keep some memory
        const Qnext = Math.max(0, 0.2 * selfCarry + routedIn + lateral); // crude mass balance
        nextQ.set(code, Qnext);

        const rc = hydroAux.rating.get(code);
        const stage_cm = qToStage_cm(Qnext, rc);
        const d0 = dates[0].toISOString().slice(0, 10);
        const d1 = new Date(dates[0].getTime() + 24 * 3600 * 1000)
          .toISOString()
          .slice(0, 10);
        const d2 = new Date(dates[0].getTime() + 48 * 3600 * 1000)
          .toISOString()
          .slice(0, 10);
        const dayStr = dates[t].toISOString().slice(0, 10);

        // collect rows (hourly) for Excel if needed
        rows.push({
          forecast_date: dayStr,
          station_code: code,
          station_name: r.station_name || "",
          river_name: r.river_name || "",
          forecast_water_level_cm: Math.round(stage_cm * 10) / 10,
        });

        // store snapshot at day boundaries for UI table
        if (isEndOfDay) {
          const idx = dayStr === d0 ? 0 : dayStr === d1 ? 1 : 2;
          if (idx >= 0 && idx <= 2) {
            if (!tableAcc.has(code)) tableAcc.set(code, [null, null, null]);
            const arr = tableAcc.get(code);
            arr[idx] = Math.round(stage_cm * 10) / 10;
          }
        }
      }
      Qstate = nextQ;
    }

    // Build UI table (river, station)
    const table = [];
    const sByCode = new Map(settings.map((s) => [s.station_code, s]));
    for (const [code, vals] of tableAcc) {
      const s = sByCode.get(code) || {};
      table.push({
        river: s.river_name || nowByCode.get(code)?.river_name || "",
        station: s.station_name || nowByCode.get(code)?.station_name || "",
        date_today: dates[0].toISOString().slice(0, 10),
        wl_today_cm: vals[0],
        wl_tomorrow_cm: vals[1],
        wl_day_after_cm: vals[2],
      });
    }
    table.sort(
      (a, b) =>
        a.river.localeCompare(b.river) || a.station.localeCompare(b.station)
    );
    rows.sort(
      (a, b) =>
        String(a.station_code).localeCompare(String(b.station_code)) ||
        a.forecast_date.localeCompare(b.forecast_date)
    );
    return { rows, table };
  }

  // Fallback: regression per-station
  const rows = [],
    table = [];
  const today = new Date();
  const days = [0, 1, 2].map(
    (d) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + d)
  );
  for (const [code, r] of nowByCode) {
    const s = settingsByCode.get(code) || {};
    const coef = model.stations?.[code]?.coef || null;
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
          const p1 = dot(coef, x0),
            p2 = p1 * 0.98 + (r.air_temp_c ?? 0) * 0.1,
            p3 = p2 * 0.98;
          return [p1, p2, p3].map((v) =>
            clamp(v + (s.datum_offset_cm ?? 0), s.min_level_cm, s.max_level_cm)
          );
        })();

    for (let i = 0; i < 3; i++) {
      rows.push({
        forecast_date: days[i].toISOString().slice(0, 10),
        station_code: code,
        station_name: r.station_name || s.station_name || "",
        river_name: r.river_name || s.river_name || "",
        forecast_water_level_cm: Math.round((preds[i] ?? 0) * 10) / 10,
      });
    }
    table.push({
      river: r.river_name || s.river_name || "",
      station: r.station_name || s.station_name || "",
      date_today: days[0].toISOString().slice(0, 10),
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

/* ---------- helpers ---------- */
function keyEdge(a, b) {
  return `${String(a).trim()}->${String(b).trim()}`;
}

function buildGraph(reaches) {
  // list of edges
  return reaches
    .map((r) => ({
      from_code: String(r.from_code || "").trim(),
      to_code: String(r.to_code || "").trim(),
      length_km: r.length_km,
      slope_m_m: r.slope_m_m,
      n_mann: r.n_mann,
      width_m: r.width_m,
      depth_m: r.depth_m,
    }))
    .filter((e) => e.from_code && e.to_code);
}

function topoOrDepthFirst(reaches) {
  // simple upstream->downstream ordering: push edges whose 'from' appears as no one's 'to' first
  const indeg = new Map(),
    outdeg = new Map();
  for (const e of reaches) {
    indeg.set(e.to_code, (indeg.get(e.to_code) || 0) + 1);
    outdeg.set(e.from_code, (outdeg.get(e.from_code) || 0) + 1);
  }
  const srcs = new Set(
    reaches.map((e) => e.from_code).filter((c) => !indeg.has(c))
  );
  const ordered = [];
  const used = new Set();
  function dfs(node) {
    for (const e of reaches) {
      if (used.has(e)) continue;
      if (e.from_code === node) {
        used.add(e);
        ordered.push(e);
        dfs(e.to_code);
      }
    }
  }
  for (const s of srcs) dfs(s);
  // add remaining (in case of cycles/islands)
  for (const e of reaches) {
    if (!used.has(e)) ordered.push(e);
  }
  return ordered;
}

function aggregateLatestPrecip(currentInputs) {
  const byBasin = new Map();
  for (const r of currentInputs) {
    if (!r.basin_name) continue;
    const val = r.precipitation_mm;
    if (val == null) continue;
    const prev = byBasin.get(r.basin_name);
    byBasin.set(r.basin_name, prev == null ? val : Math.max(prev, val));
  }
  return byBasin;
}
