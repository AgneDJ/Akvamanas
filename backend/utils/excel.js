// backend/utils/excel.js
import XLSX from "xlsx";
import fs from "fs";
import path from "path";

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function writeForecastWorkbook(
  filePath,
  dailyTable = [],
  hourlyRows = []
) {
  const wb = XLSX.utils.book_new();

  // DAILY sheet (3-day summary)
  const dailyCols = [
    "river",
    "station",
    "date_today",
    "wl_today_cm",
    "wl_tomorrow_cm",
    "wl_day_after_cm",
  ];
  const dailySheet = XLSX.utils.json_to_sheet(
    dailyTable.map((r) => Object.fromEntries(dailyCols.map((k) => [k, r[k]]))),
    { skipHeader: false }
  );
  XLSX.utils.book_append_sheet(wb, dailySheet, "daily");

  // HOURLY sheet (UTC)
  const hourlyCols = [
    "forecast_datetime", // ISO UTC
    "forecast_date",
    "station_code",
    "station_name",
    "river_name",
    "forecast_water_level_cm",
  ];
  const hourlySheet = XLSX.utils.json_to_sheet(
    hourlyRows.map((r) => Object.fromEntries(hourlyCols.map((k) => [k, r[k]]))),
    { skipHeader: false }
  );
  XLSX.utils.book_append_sheet(wb, hourlySheet, "hourly_utc");

  XLSX.writeFile(wb, filePath, { bookType: "xlsx" });
}

export function timestampedOutPath(outDir, prefix = "forecast", ext = "xlsx") {
  ensureDir(outDir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(outDir, `${prefix}_${ts}.${ext}`);
}
