import XLSX from "xlsx";

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toDate(v) {
  if (!v) return null;
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
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

/**
 * Flexible reader:
 * - If file contains extended sheets: precipitation, water_levels, stations, station_levels
 *   → builds currentInputs from water_levels + precip join (by station or basin) and settings from stations (+levels).
 * - If file contains legacy sheets: current_inputs, settings
 *   → keeps backward compatibility.
 */
export async function loadInputsFromExcel(filePath) {
  const wb = XLSX.readFile(filePath);

  const hasExtended =
    !!wb.Sheets["precipitation"] ||
    !!wb.Sheets["water_levels"] ||
    !!wb.Sheets["stations"] ||
    !!wb.Sheets["station_levels"];

  if (hasExtended) {
    const prec = XLSX.utils.sheet_to_json(wb.Sheets["precipitation"] || {}, {
      defval: null,
    });
    const wl = XLSX.utils.sheet_to_json(wb.Sheets["water_levels"] || {}, {
      defval: null,
    });
    const stations = XLSX.utils.sheet_to_json(wb.Sheets["stations"] || {}, {
      defval: null,
    });
    const levels = XLSX.utils.sheet_to_json(wb.Sheets["station_levels"] || {}, {
      defval: null,
    });

    // Index stations
    const stByCode = new Map();
    const stByName = new Map();
    for (const s of stations) {
      const code = String(s.station_code || "").trim();
      if (code) stByCode.set(code, s);
      const nmKey = key(s.river_name, s.station_name);
      if (nmKey) stByName.set(nmKey, s);
    }

    // Precip lookup (prefer station; fallback basin)
    const precipByStation = new Map();
    const precipByBasin = new Map();
    for (const p of prec) {
      const code = String(p.station_code || "").trim();
      if (code) {
        precipByStation.set(code, num(p.precipitation_mm));
      } else if (p.basin_name) {
        precipByBasin.set(String(p.basin_name).trim(), num(p.precipitation_mm));
      }
    }

    // Compose current inputs from water levels + metadata + precip
    const currentInputs = [];
    for (const r of wl) {
      const code = String(r.station_code || "").trim();
      const nmKey = key(r.river_name, r.station_name);
      const st = code ? stByCode.get(code) || {} : stByName.get(nmKey) || {};
      const basin = st?.basin_name || "";
      const precip =
        code && precipByStation.has(code)
          ? precipByStation.get(code)
          : basin && precipByBasin.has(basin)
          ? precipByBasin.get(basin)
          : null;

      currentInputs.push({
        date: toDate(r.date),
        station_code: code,
        station_name: r.station_name || st.station_name || "",
        river_name: r.river_name || st.river_name || "",
        basin_name: basin || null,
        water_level_cm: num(r.water_level_cm),
        precipitation_mm: precip,
        air_temp_c: null,
        wind_speed_mps: null,
        wind_dir_deg: null,
        rh_pct: null,
        roughness_n: num(st.roughness_n),
      });
    }

    // Merge station_levels into settings (as datum_offset_cm default)
    const levelByName = new Map();
    for (const lv of levels) {
      levelByName.set(
        key(lv.river_name, lv.station_name),
        num(lv.station_level_cm)
      );
    }

    const settings = [];
    for (const s of stations) {
      const nmKey = key(s.river_name, s.station_name);
      const station_level_cm = levelByName.get(nmKey);
      settings.push({
        station_code: String(s.station_code || "").trim(),
        station_id: s.station_id ?? null,
        station_name: s.station_name || "",
        river_name: s.river_name || "",
        basin_name: s.basin_name || "",
        x: num(s.x),
        y: num(s.y),
        datum_offset_cm: num(s.datum_offset_cm ?? station_level_cm ?? null),
        min_level_cm: num(s.min_level_cm),
        max_level_cm: num(s.max_level_cm),
        roughness_n: num(s.roughness_n),
      });
    }

    return { currentInputs, settings };
  }

  // ---- Legacy structure fallback: current_inputs + settings ----
  const current = XLSX.utils.sheet_to_json(wb.Sheets["current_inputs"] || {}, {
    defval: null,
  });
  const settings = XLSX.utils.sheet_to_json(wb.Sheets["settings"] || {}, {
    defval: null,
  });

  return {
    currentInputs: current.map((r) => ({
      date: toDate(r.date),
      station_code: String(r.station_code || "").trim(),
      station_name: r.station_name || "",
      river_name: r.river_name || "",
      water_level_cm: num(r.water_level_cm),
      precipitation_mm: num(r.precipitation_mm),
      air_temp_c: num(r.air_temp_c),
      wind_speed_mps: num(r.wind_speed_mps),
      wind_dir_deg: num(r.wind_dir_deg),
      rh_pct: num(r.rh_pct),
      roughness_n: num(r.roughness_n),
    })),
    settings: settings.map((r) => ({
      station_code: String(r.station_code || "").trim(),
      station_name: r.station_name || "",
      river_name: r.river_name || "",
      datum_offset_cm: num(r.datum_offset_cm),
      min_level_cm: num(r.min_level_cm),
      max_level_cm: num(r.max_level_cm),
      roughness_n: num(r.roughness_n),
    })),
  };
}

export async function readStationsFromExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const stations = XLSX.utils.sheet_to_json(
    wb.Sheets["stations"] || wb.Sheets["settings"] || {},
    { defval: null }
  );
  return stations.map((s) => ({
    station_code: String(s.station_code || "").trim(),
    station_id: s.station_id ?? null,
    station_name: s.station_name || "",
    river_name: s.river_name || "",
    basin_name: s.basin_name || "",
    x: num(s.x),
    y: num(s.y),
    datum_offset_cm: num(s.datum_offset_cm),
    min_level_cm: num(s.min_level_cm),
    max_level_cm: num(s.max_level_cm),
    roughness_n: num(s.roughness_n),
  }));
}

export async function writeForecastToExcel(outPath, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "forecast");
  XLSX.writeFile(wb, outPath);
}
