import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_CONFIG = "collector.config.json";
const HISTORY_FILE = "history.json";
const READINGS_FILE = "readings.json";
const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_DIR = "snapshots";

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  const configIndex = process.argv.indexOf("--config");

  return {
    once: args.has("--once"),
    configPath:
      configIndex >= 0 && process.argv[configIndex + 1]
        ? process.argv[configIndex + 1]
        : DEFAULT_CONFIG,
  };
}

async function readJsonFile(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;

  await fs.writeFile(tempPath, json, "utf8");
  await fs.rename(tempPath, filePath);
}

function safeTimestamp(isoDate) {
  return isoDate.replace(/[:.]/g, "-");
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function flattenNumeric(value, prefix = "", output = {}, depth = 0) {
  if (depth > 8 || Object.keys(output).length > 250) {
    return output;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    output[prefix || "value"] = value;
    return output;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const looksNumeric = /^-?\d+(\.\d+)?$/.test(trimmed);
    const numberValue = Number(trimmed);

    if (looksNumeric && Number.isFinite(numberValue)) {
      output[prefix || "value"] = numberValue;
    }

    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const segment = isPlainObject(item) && item.id ? String(item.id) : String(index);
      const key = prefix ? `${prefix}.${segment}` : segment;
      flattenNumeric(item, key, output, depth + 1);
    });
    return output;
  }

  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, item]) => {
      const nextKey = prefix ? `${prefix}.${key}` : key;
      flattenNumeric(item, nextKey, output, depth + 1);
    });
  }

  return output;
}

function getNumericEntries(value) {
  if (!isPlainObject(value)) {
    return [];
  }

  return Object.entries(value).filter(([key, item]) => {
    if (key === "id" || key === "timestamp" || key === "time" || key === "date") {
      return false;
    }

    return Number.isFinite(Number(item));
  });
}

function buildHistoricalReadings(samples) {
  const readings = [];

  samples.forEach((sample) => {
    sample.sources?.forEach((source) => {
      if (Array.isArray(source.data)) {
        source.data.forEach((row, index) => {
          const stationId = isPlainObject(row) && row.id ? String(row.id) : `${source.id || "source"}_${index + 1}`;
          const readingTime = isPlainObject(row) ? row.timestamp || row.time || row.date || null : null;

          getNumericEntries(row).forEach(([metric, value]) => {
            readings.push({
              id: `${sample.id}:${source.id}:${stationId}:${metric}`,
              snapshotId: sample.id,
              fetchedAt: sample.fetchedAt,
              readingTime,
              sourceId: source.id,
              sourceName: source.name || source.id,
              stationId,
              metric,
              metricKey: `${stationId}.${metric}`,
              value: Number(value),
            });
          });
        });

        return;
      }

      Object.entries(source.numeric || {}).forEach(([metricKey, value]) => {
        const numberValue = Number(value);

        if (!Number.isFinite(numberValue)) {
          return;
        }

        const [stationId = source.id, ...metricParts] = metricKey.split(".");
        const metric = metricParts.join(".") || metricKey;

        readings.push({
          id: `${sample.id}:${source.id}:${metricKey}`,
          snapshotId: sample.id,
          fetchedAt: sample.fetchedAt,
          readingTime: null,
          sourceId: source.id,
          sourceName: source.name || source.id,
          stationId,
          metric,
          metricKey,
          value: numberValue,
        });
      });
    });
  });

  return readings;
}

async function fetchApi(api, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(api.url, {
      headers: api.headers || {},
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const contentType = response.headers.get("content-type") || "";
    const bodyText = await response.text();
    let data = bodyText;

    if (contentType.includes("application/json") || bodyText.trim().startsWith("{") || bodyText.trim().startsWith("[")) {
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = { raw: bodyText };
      }
    }

    return {
      id: api.id,
      name: api.name || api.id,
      url: api.url,
      ok: response.ok,
      status: response.status,
      durationMs,
      fetchedAt: new Date().toISOString(),
      numeric: flattenNumeric(data),
      data,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      id: api.id,
      name: api.name || api.id,
      url: api.url,
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      fetchedAt: new Date().toISOString(),
      numeric: {},
      data: null,
      error: error.name === "AbortError" ? `Timed out after ${timeoutMs}ms` : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadConfig(configPath) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  const config = await readJsonFile(resolvedPath, null);

  if (!config) {
    throw new Error(`Missing config file: ${resolvedPath}`);
  }

  return {
    ...config,
    intervalMinutes: Number(config.intervalMinutes || 15),
    timeoutMs: Number(config.timeoutMs || 20000),
    maxSamples: Number(config.maxSamples || 1000),
    maxReadings: Number(config.maxReadings || 10000),
    outputDir: config.outputDir || "public/data",
    apis: Array.isArray(config.apis) ? config.apis : [],
  };
}

async function saveSnapshot(config, snapshot) {
  const outputDir = path.resolve(process.cwd(), config.outputDir);
  const snapshotDir = path.join(outputDir, SNAPSHOT_DIR);
  const historyPath = path.join(outputDir, HISTORY_FILE);
  const readingsPath = path.join(outputDir, READINGS_FILE);
  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  const snapshotPath = path.join(snapshotDir, `${snapshot.id}.json`);

  await fs.mkdir(snapshotDir, { recursive: true });
  await writeJsonAtomic(snapshotPath, snapshot);

  const existingHistory = await readJsonFile(historyPath, {
    schemaVersion: 1,
    updatedAt: null,
    intervalMinutes: config.intervalMinutes,
    samples: [],
  });
  const samples = Array.isArray(existingHistory.samples) ? existingHistory.samples : [];
  const nextSamples = [...samples, snapshot].slice(-config.maxSamples);
  const history = {
    schemaVersion: 1,
    updatedAt: snapshot.fetchedAt,
    intervalMinutes: config.intervalMinutes,
    samples: nextSamples,
  };
  const readings = {
    schemaVersion: 1,
    updatedAt: snapshot.fetchedAt,
    count: 0,
    readings: buildHistoricalReadings(nextSamples).slice(-config.maxReadings),
  };

  readings.count = readings.readings.length;

  const manifest = {
    schemaVersion: 1,
    updatedAt: snapshot.fetchedAt,
    latest: `${SNAPSHOT_DIR}/${snapshot.id}.json`,
    count: nextSamples.length,
    readingCount: readings.count,
    snapshots: nextSamples.map((sample) => ({
      id: sample.id,
      fetchedAt: sample.fetchedAt,
      sourceCount: sample.sources.length,
      okCount: sample.sources.filter((source) => source.ok).length,
    })),
  };

  await writeJsonAtomic(historyPath, history);
  await writeJsonAtomic(readingsPath, readings);
  await writeJsonAtomic(manifestPath, manifest);
}

async function collectOnce(config) {
  const activeApis = config.apis.filter((api) => api.enabled !== false && api.url);

  if (activeApis.length === 0) {
    console.log("No enabled APIs in collector.config.json. Nothing fetched.");
    return null;
  }

  const fetchedAt = new Date().toISOString();
  const id = safeTimestamp(fetchedAt);
  console.log(`Fetching ${activeApis.length} API(s) at ${fetchedAt}`);

  const sources = await Promise.all(activeApis.map((api) => fetchApi(api, config.timeoutMs)));
  const snapshot = {
    schemaVersion: 1,
    id,
    fetchedAt,
    label: new Date(fetchedAt).toLocaleString(),
    sources,
  };

  await saveSnapshot(config, snapshot);

  const okCount = sources.filter((source) => source.ok).length;
  console.log(`Saved ${id}. ${okCount}/${sources.length} API(s) returned OK.`);
  return snapshot;
}

async function main() {
  const args = parseArgs();
  const config = await loadConfig(args.configPath);

  if (args.once) {
    await collectOnce(config);
    return;
  }

  await collectOnce(config);

  const intervalMs = Math.max(1, config.intervalMinutes) * 60 * 1000;
  console.log(`Collector running every ${config.intervalMinutes} minute(s). Press Ctrl+C to stop.`);

  setInterval(() => {
    collectOnce(config).catch((error) => {
      console.error("Collection failed:", error);
    });
  }, intervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
