// frontend/src/App.jsx
import { useEffect, useState } from "react";
import {
  getManifest,
  getHealth,
  uploadFile,
  uploadFiles,
  train,
  forecast,
  downloadLatest,
} from "./api";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export default function App() {
  const [manifest, setManifest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [table, setTable] = useState([]);
  const [series, setSeries] = useState({});
  const [hourly, setHourly] = useState([]); // NEW: flat hourly rows
  const [status, setStatus] = useState("");

  const refreshManifest = async () => {
    const { data } = await getManifest();
    setManifest(data);
  };

  const ping = async () => {
    try {
      const { data } = await getHealth();
      setStatus(data?.ok ? "" : "Backend not responding");
    } catch {
      setStatus("Backend not responding");
    }
  };

  useEffect(() => {
    ping();
    refreshManifest();
  }, []);

  const handleUpload = async (url, file, field = "file") => {
    if (!file) return;
    setBusy(true);
    try {
      await uploadFile(url, file, field);
      await refreshManifest();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleUploadHistorical = async (files) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      await uploadFiles("/api/upload/historical", files, "files");
      await refreshManifest();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleTrain = async () => {
    setBusy(true);
    setStatus("Training...");
    try {
      const { data } = await train();
      setStatus(`Trained at: ${data.trainedAt} (stations: ${data.stations})`);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
      await refreshManifest();
    }
  };

  const handleForecast = async () => {
    setBusy(true);
    setStatus("Calculating forecast...");
    try {
      const { data } = await forecast();
      setTable(data.table || []);
      setSeries(data.series || {});
      setHourly(data.hourly || []); // NEW
      setStatus("Forecast complete");
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    try {
      const res = await downloadLatest();
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = "forecast.xlsx";
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const canForecast = !!(manifest?.metadata && manifest?.current?.water);

  return (
    <div
      style={{
        fontFamily: "Inter, system-ui, Arial",
        padding: 20,
        maxWidth: 1280,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
        <h1 style={{ margin: 0 }}>AKVAMANAS</h1>
        <code style={{ opacity: 0.7 }}>{status}</code>
      </header>

      <p style={{ marginTop: 6, opacity: 0.8 }}></p>

      {/* Upload panels */}
      <section
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          marginTop: 12,
        }}
      >
        <Card title="Station metadata">
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) =>
              handleUpload("/api/upload/metadata", e.target.files?.[0])
            }
            disabled={busy}
          />
          <Small>
            Expect <code>stations_metadata.xlsx</code> (sheet{" "}
            <code>stations_meta</code>)
          </Small>
          <Status ok={!!manifest?.metadata} />
        </Card>

        <Card title="Current water levels (hourly)">
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) =>
              handleUpload("/api/upload/current/water", e.target.files?.[0])
            }
            disabled={busy}
          />
          <Small>
            Sheet: <code>water_levels</code>
          </Small>
          <Status ok={!!manifest?.current?.water} />
        </Card>

        <Card title="Current precipitation (hourly, optional)">
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) =>
              handleUpload("/api/upload/current/precip", e.target.files?.[0])
            }
            disabled={busy}
          />
          <Small>
            Sheet: <code>precip</code>
          </Small>
          <Status ok={!!manifest?.current?.precip} />
        </Card>

        <Card title="Current air temperature (hourly, optional)">
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) =>
              handleUpload("/api/upload/current/air", e.target.files?.[0])
            }
            disabled={busy}
          />
          <Small>
            Sheet: <code>air_temp</code>
          </Small>
          <Status ok={!!manifest?.current?.air} />
        </Card>

        <Card title="Historical (multiple files, hourly)">
          <input
            type="file"
            accept=".xlsx"
            multiple
            onChange={(e) => handleUploadHistorical(e.target.files)}
            disabled={busy}
          />
          <Small>
            Per-station files; sheet <code>historical</code>
          </Small>
          <div style={{ marginTop: 6 }}>
            Total files: <b>{manifest?.historical?.length || 0}</b>
          </div>
        </Card>

        {/* Hydrology auxiliaries */}
        <Card title="River network (reaches)">
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) =>
              handleUpload("/api/upload/network", e.target.files?.[0])
            }
            disabled={busy}
          />
          <Small>
            Sheet: <code>reaches</code>
          </Small>
          <Small>
            Columns: from_code, to_code, length_km, slope_m_m, n_mann, width_m,
            depth_m
          </Small>
        </Card>

        <Card title="Rating curves">
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) =>
              handleUpload("/api/upload/rating", e.target.files?.[0])
            }
            disabled={busy}
          />
          <Small>
            Sheet: <code>rating</code>
          </Small>
          <Small>Columns: station_code, h0_cm, a, b</Small>
        </Card>

        <Card title="Basin parameters">
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) =>
              handleUpload("/api/upload/basin", e.target.files?.[0])
            }
            disabled={busy}
          />
          <Small>
            Sheet: <code>basins</code>
          </Small>
          <Small>Columns: basin_name, runoff_coeff, baseflow_cms</Small>
        </Card>
      </section>

      {/* Actions */}
      <div
        style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}
      >
        <button
          onClick={handleTrain}
          disabled={busy || (manifest?.historical?.length ?? 0) === 0}
        >
          Train model
        </button>
        <button onClick={handleForecast} disabled={busy || !canForecast}>
          Calculate forecast
        </button>
        <button onClick={handleDownload} disabled={busy}>
          Download Excel
        </button>
        <button
          onClick={refreshManifest}
          disabled={busy}
          title="Re-read backend manifest"
        >
          Refresh status
        </button>
      </div>

      {/* Daily table */}
      <h2 style={{ marginTop: 20 }}>Daily Results</h2>
      {table?.length ? (
        <ResultsTable table={table} />
      ) : (
        <div style={{ opacity: 0.75 }}>No results yet.</div>
      )}

      {/* Hourly charts */}
      <h2 style={{ marginTop: 24 }}>Hourly Forecast (next 72h)</h2>
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
        }}
      >
        {Object.entries(series).map(([code, points]) => (
          <StationChart key={code} code={code} points={points} />
        ))}
      </div>

      {/* Hourly table (flat) */}
      <h2 style={{ marginTop: 24 }}>Hourly Table (UTC)</h2>
      {hourly?.length ? (
        <HourlyTable rows={hourly} />
      ) : (
        <div style={{ opacity: 0.75 }}>No hourly rows yet.</div>
      )}
    </div>
  );
}

/* ---------- Small UI helpers ---------- */

function Card({ title, children }) {
  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 10,
        padding: 12,
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {children}
    </div>
  );
}

function Small({ children }) {
  return (
    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{children}</div>
  );
}

function Status({ ok }) {
  return (
    <div style={{ marginTop: 8, fontSize: 13 }}>
      Loaded:{" "}
      <b style={{ color: ok ? "#19734d" : "#a23c3c" }}>{ok ? "Yes" : "No"}</b>
    </div>
  );
}

function ResultsTable({ table }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        border="1"
        cellPadding="6"
        style={{
          borderCollapse: "collapse",
          width: "100%",
          background: "#fff",
        }}
      >
        <thead style={{ background: "#f5f5f7" }}>
          <tr>
            <th>River</th>
            <th>Station</th>
            <th>Date</th>
            <th>WL +1 Day (cm)</th>
            <th>WL +2 Day (cm)</th>
            <th>WL +3 Day (cm)</th>
          </tr>
        </thead>
        <tbody>
          {table.map((r, i) => (
            <tr key={i}>
              <td>{r.river}</td>
              <td>{r.station}</td>
              <td>{r.date_today}</td>
              <td>{r.wl_today_cm}</td>
              <td>{r.wl_tomorrow_cm}</td>
              <td>{r.wl_day_after_cm}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------ Chart: x = water level, y = hour (vertical layout) ------------ */

/* ------------ Chart: x = datetime (hour), y = water level (cm) ------------ */

function StationChart({ code, points }) {
  if (!points?.length) return null;
  const title = `${points[0]?.river_name || ""} – ${
    points[0]?.station_name || ""
  } (${code})`;

  return (
    <div
      style={{
        border: "1px solid #eee",
        borderRadius: 10,
        padding: 12,
        background: "#fff",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart
          data={points}
          margin={{ left: 20, right: 20, top: 10, bottom: 10 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          {/* X axis = datetime label */}
          <XAxis
            dataKey="hour"
            tickFormatter={(v) => v}
            label={{
              value: "Laikas (Vietinis)",
              position: "insideBottom",
              offset: -5,
            }}
          />
          {/* Y axis = water level (cm) */}
          <YAxis
            dataKey="wl_cm"
            label={{
              value: "Water level (cm)",
              angle: -90,
              position: "insideLeft",
            }}
          />
          <Tooltip
            formatter={(value, name) => {
              if (name === "wl_cm") return [`${value} cm`, "Water level"];
              return [value, name];
            }}
            labelFormatter={(_, payload) => {
              const p = payload?.[0]?.payload;
              return `${p?.t?.slice(0, 16).replace("T", " ")} UTC`;
            }}
          />
          <Line
            type="monotone"
            dataKey="wl_cm"
            stroke="#0074D9"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
        x: Laikas &nbsp;|&nbsp; y: Vandens lygis (cm)
      </div>
    </div>
  );
}

/* ---------------- Hourly flat table ---------------- */

function HourlyTable({ rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        border="1"
        cellPadding="6"
        style={{
          borderCollapse: "collapse",
          width: "100%",
          background: "#fff",
        }}
      >
        <thead style={{ background: "#f5f5f7" }}>
          <tr>
            <th>DateTime (Vietinis)</th>
            <th>Date</th>
            <th>River</th>
            <th>Station</th>
            <th>Code</th>
            <th>WL (cm)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.forecast_datetime}</td>
              <td>{r.forecast_date}</td>
              <td>{r.river_name}</td>
              <td>{r.station_name}</td>
              <td>{r.station_code}</td>
              <td>{r.forecast_water_level_cm}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
