// Minimal API client for AKVAMANAS frontend
// If you need to point to a different backend, set VITE_BACKEND_URL in .env
// Example: VITE_BACKEND_URL="http://localhost:4000"

import axios from "axios";

const BASE_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

export const API = axios.create({
  baseURL: BASE_URL,
  // Important for file downloads (Excel)
  responseType: "json",
  headers: { "X-Requested-With": "XMLHttpRequest" },
});

// --- Health / manifest ---
export const getHealth = () => API.get("/api/health");
export const getManifest = () => API.get("/api/manifest");

// --- Upload helpers ---
export const uploadFile = async (url, file, field = "file") => {
  const fd = new FormData();
  fd.append(field, file);
  const { data } = await API.post(url, fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
};

export const uploadFiles = async (url, files, field = "files") => {
  const fd = new FormData();
  [...files].forEach((f) => fd.append(field, f));
  const { data } = await API.post(url, fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
};

// --- Train / forecast / download ---
export const train = () => API.post("/api/train");
export const forecast = () => API.post("/api/forecast");

// Note: this returns a Blob; caller should trigger a download
export const downloadLatest = async () =>
  axios.get(`${BASE_URL}/api/download`, { responseType: "blob" });
