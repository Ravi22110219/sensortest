import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  RefreshCw,
  Server,
  XCircle,
} from "lucide-react";

const HISTORY_URL = "/data/history.json";
const READINGS_URL = "/data/readings.json";
const REFRESH_MS = 60 * 1000;

function sourceKey(source) {
  return source?.id || source?.name || source?.url || "source";
}

function toMetricLabel(key) {
  return key
    .replace(/\./g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatValue(value) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return "-";
  }

  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: Math.abs(numberValue) >= 100 ? 0 : 2,
  }).format(numberValue);
}

function compactUrl(url) {
  if (!url) {
    return "-";
  }

  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function readingMetricKey(reading) {
  return reading.metricKey || `${reading.stationId || "station"}.${reading.metric || "value"}`;
}

function deriveReadingsFromSamples(samples = []) {
  const safeSamples = Array.isArray(samples) ? samples : [];

  return safeSamples.flatMap((sample) =>
    (sample.sources || []).flatMap((source) =>
      Object.entries(source.numeric || {})
        .filter(([, value]) => Number.isFinite(Number(value)))
        .map(([metricKey, value]) => {
          const [stationId = source.id, ...metricParts] = metricKey.split(".");
          const metric = metricParts.join(".") || metricKey;

          return {
            id: `${sample.id}:${source.id}:${metricKey}`,
            snapshotId: sample.id,
            fetchedAt: sample.fetchedAt,
            readingTime: null,
            sourceId: source.id,
            sourceName: source.name || source.id,
            stationId,
            metric,
            metricKey,
            value: Number(value),
          };
        }),
    ),
  );
}

function buildSourceOptions(readings = [], samples = []) {
  const safeReadings = Array.isArray(readings) ? readings : [];
  const safeSamples = Array.isArray(samples) ? samples : [];
  const map = new Map();

  safeReadings.forEach((reading) => {
    const key = reading.sourceId || reading.sourceName;

    if (key && !map.has(key)) {
      map.set(key, {
        key,
        label: reading.sourceName || key,
      });
    }
  });

  safeSamples.forEach((sample) => {
    sample.sources?.forEach((source) => {
      const key = sourceKey(source);

      if (!map.has(key)) {
        map.set(key, {
          key,
          label: source.name || key,
        });
      }
    });
  });

  return [...map.values()];
}

function buildMetricOptions(readings = [], selectedSource) {
  const safeReadings = Array.isArray(readings) ? readings : [];
  const counts = new Map();

  safeReadings.forEach((reading) => {
    if ((reading.sourceId || reading.sourceName) !== selectedSource) {
      return;
    }

    if (!Number.isFinite(Number(reading.value))) {
      return;
    }

    const key = readingMetricKey(reading);
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .map(([key, count]) => ({
      key,
      label: toMetricLabel(key),
      count,
    }));
}

function buildSeries(readings = [], selectedSource, selectedMetric) {
  const safeReadings = Array.isArray(readings) ? readings : [];

  return safeReadings
    .filter((reading) => (reading.sourceId || reading.sourceName) === selectedSource)
    .filter((reading) => readingMetricKey(reading) === selectedMetric)
    .filter((reading) => Number.isFinite(Number(reading.value)))
    .sort((first, second) => new Date(first.fetchedAt).getTime() - new Date(second.fetchedAt).getTime())
    .map((reading) => ({
      time: reading.fetchedAt,
      sensorTime: reading.readingTime,
      value: Number(reading.value),
    }));
}

function buildLatestMetricCards(readings = [], selectedSource) {
  const safeReadings = Array.isArray(readings) ? readings : [];
  const latestByMetric = new Map();

  safeReadings
    .filter((reading) => (reading.sourceId || reading.sourceName) === selectedSource)
    .forEach((reading) => {
      const key = readingMetricKey(reading);
      const previous = latestByMetric.get(key);
      const previousTime = previous ? new Date(previous.fetchedAt).getTime() : -Infinity;
      const nextTime = new Date(reading.fetchedAt).getTime();

      if (!previous || nextTime >= previousTime) {
        latestByMetric.set(key, reading);
      }
    });

  return [...latestByMetric.values()].sort((first, second) => readingMetricKey(first).localeCompare(readingMetricKey(second)));
}

function SummaryCard({ icon: Icon, label, value, detail, tone = "teal" }) {
  return (
    <article className={`summaryCard tone-${tone}`}>
      <div className="summaryIcon" aria-hidden="true">
        <Icon size={19} />
      </div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function StatusBadge({ ok }) {
  return (
    <span className={`statusBadge ${ok ? "isOk" : "isFail"}`}>
      {ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
      {ok ? "OK" : "Fail"}
    </span>
  );
}

function LineChart({ series }) {
  const width = 760;
  const height = 300;
  const padding = { top: 24, right: 26, bottom: 42, left: 58 };

  if (series.length === 0) {
    return (
      <div className="emptyChart">
        <AlertCircle size={22} />
        <span>No numeric samples for this metric yet.</span>
      </div>
    );
  }

  const values = series.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const yMin = min - spread * 0.12;
  const yMax = max + spread * 0.12;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xStep = series.length > 1 ? plotWidth / (series.length - 1) : 0;
  const xFor = (index) => padding.left + index * xStep;
  const yFor = (value) => padding.top + ((yMax - value) / (yMax - yMin)) * plotHeight;
  const linePath = series
    .map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(index)} ${yFor(point.value)}`)
    .join(" ");
  const areaPath = `${linePath} L ${xFor(series.length - 1)} ${height - padding.bottom} L ${padding.left} ${
    height - padding.bottom
  } Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = yMax - (yMax - yMin) * ratio;
    return {
      y: padding.top + plotHeight * ratio,
      value,
    };
  });
  const firstPoint = series[0];
  const lastPoint = series[series.length - 1];

  return (
    <svg className="chartSvg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Metric trend chart">
      <rect x="0" y="0" width={width} height={height} rx="8" className="chartBackplate" />
      {grid.map((line) => (
        <g key={line.y}>
          <line x1={padding.left} x2={width - padding.right} y1={line.y} y2={line.y} className="gridLine" />
          <text x={padding.left - 12} y={line.y + 4} textAnchor="end" className="axisText">
            {formatValue(line.value)}
          </text>
        </g>
      ))}
      <line
        x1={padding.left}
        x2={width - padding.right}
        y1={height - padding.bottom}
        y2={height - padding.bottom}
        className="axisLine"
      />
      <path d={areaPath} className="areaPath" />
      <path d={linePath} className="linePath" />
      {series.map((point, index) => (
        <circle key={`${point.time}-${index}`} cx={xFor(index)} cy={yFor(point.value)} r="4" className="dataPoint">
          <title>
            {formatDateTime(point.time)}: {formatValue(point.value)}
            {point.sensorTime ? `, sensor time ${point.sensorTime}` : ""}
          </title>
        </circle>
      ))}
      <text x={padding.left} y={height - 14} className="axisText">
        {formatTime(firstPoint.time)}
      </text>
      <text x={width - padding.right} y={height - 14} textAnchor="end" className="axisText">
        {formatTime(lastPoint.time)}
      </text>
      <text x={width - padding.right} y={padding.top + 2} textAnchor="end" className="lastValue">
        {formatValue(lastPoint.value)}
      </text>
    </svg>
  );
}

export default function App() {
  const [history, setHistory] = useState(null);
  const [readingsHistory, setReadingsHistory] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastLoadedAt, setLastLoadedAt] = useState(null);
  const [selectedSource, setSelectedSource] = useState("");
  const [selectedMetric, setSelectedMetric] = useState("");

  const loadHistory = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const cacheKey = Date.now();
      const [historyResponse, readingsResponse] = await Promise.all([
        fetch(`${HISTORY_URL}?t=${cacheKey}`, {
          cache: "no-store",
        }),
        fetch(`${READINGS_URL}?t=${cacheKey}`, {
          cache: "no-store",
        }),
      ]);

      if (!historyResponse.ok) {
        throw new Error(`Could not read ${HISTORY_URL}`);
      }

      const nextHistory = await historyResponse.json();
      const nextReadings = readingsResponse.ok ? await readingsResponse.json() : { readings: [] };

      setHistory(nextHistory);
      setReadingsHistory(nextReadings);
      setLastLoadedAt(new Date().toISOString());
      setError(null);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
    const interval = window.setInterval(() => loadHistory({ silent: true }), REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [loadHistory]);

  const samples = history?.samples || [];
  const fallbackReadings = useMemo(() => deriveReadingsFromSamples(samples), [samples]);
  const storedReadings = readingsHistory?.readings || [];
  const readings = storedReadings.length > 0 ? storedReadings : fallbackReadings;
  const latestSample = samples[samples.length - 1] || null;
  const sourceOptions = useMemo(() => buildSourceOptions(readings, samples), [readings, samples]);
  const metricOptions = useMemo(() => buildMetricOptions(readings, selectedSource), [readings, selectedSource]);
  const selectedSourceMeta = sourceOptions.find((source) => source.key === selectedSource);
  const selectedMetricMeta = metricOptions.find((metric) => metric.key === selectedMetric);
  const series = useMemo(
    () => buildSeries(readings, selectedSource, selectedMetric),
    [readings, selectedMetric, selectedSource],
  );
  const latestMetrics = useMemo(() => buildLatestMetricCards(readings, selectedSource), [readings, selectedSource]);
  const latestSources = latestSample?.sources || [];
  const okCount = latestSources.filter((source) => source.ok).length;

  useEffect(() => {
    if (sourceOptions.length === 0) {
      setSelectedSource("");
      return;
    }

    if (!sourceOptions.some((source) => source.key === selectedSource)) {
      setSelectedSource(sourceOptions[0].key);
    }
  }, [selectedSource, sourceOptions]);

  useEffect(() => {
    if (metricOptions.length === 0) {
      setSelectedMetric("");
      return;
    }

    if (!metricOptions.some((metric) => metric.key === selectedMetric)) {
      setSelectedMetric(metricOptions[0].key);
    }
  }, [metricOptions, selectedMetric]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            <Activity size={22} />
          </span>
          <div>
            <h1>Ritel / Witel</h1>
            <p>Rainfall and water level dashboard</p>
          </div>
        </div>
        <div className="topActions">
          {error ? <span className="errorText">{error}</span> : <span>Loaded {formatTime(lastLoadedAt)}</span>}
          <button
            className={`iconButton ${loading ? "isSpinning" : ""}`}
            type="button"
            onClick={() => loadHistory()}
            aria-label="Refresh data"
            data-tooltip="Refresh data"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="summaryGrid" aria-label="Dashboard summary">
          <SummaryCard icon={Database} label="Stored Samples" value={samples.length} detail="history.json" tone="teal" />
          <SummaryCard icon={Gauge} label="History Points" value={readings.length} detail="readings.json" tone="blue" />
          <SummaryCard
            icon={Clock3}
            label="Last Fetch"
            value={formatDateTime(latestSample?.fetchedAt)}
            detail={`${history?.intervalMinutes || 15} min interval`}
            tone="amber"
          />
          <SummaryCard
            icon={Server}
            label="Source Status"
            value={`${okCount}/${latestSources.length || 0}`}
            detail="latest response"
            tone={okCount === latestSources.length ? "green" : "coral"}
          />
        </section>

        <section className="contentGrid">
          <article className="panel chartPanel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">{selectedSourceMeta?.label || "No source"}</p>
                <h2>{selectedMetricMeta?.label || "No metric selected"}</h2>
              </div>
              <div className="controlRow">
                <label className="selectLabel">
                  <span>Source</span>
                  <select value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)}>
                    {sourceOptions.map((source) => (
                      <option key={source.key} value={source.key}>
                        {source.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="selectLabel">
                  <span>Metric</span>
                  <select value={selectedMetric} onChange={(event) => setSelectedMetric(event.target.value)}>
                    {metricOptions.map((metric) => (
                      <option key={metric.key} value={metric.key}>
                        {metric.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div className="chartFrame">
              <LineChart series={series} />
            </div>
          </article>

          <aside className="panel sourcePanel">
            <div className="panelHeader compact">
              <div>
                <p className="eyebrow">Latest</p>
                <h2>Sources</h2>
              </div>
            </div>
            <div className="sourceList">
              {latestSources.map((source) => (
                <button
                  className={`sourceRow ${sourceKey(source) === selectedSource ? "isSelected" : ""}`}
                  type="button"
                  key={sourceKey(source)}
                  onClick={() => setSelectedSource(sourceKey(source))}
                >
                  <span>
                    <strong>{source.name || sourceKey(source)}</strong>
                    <small>{compactUrl(source.url)}</small>
                  </span>
                  <StatusBadge ok={source.ok} />
                </button>
              ))}
              {latestSources.length === 0 ? <p className="muted">No sources available.</p> : null}
            </div>
          </aside>
        </section>

        <section className="metricGrid" aria-label="Latest metrics">
          {latestMetrics.slice(0, 8).map((reading) => {
            const key = readingMetricKey(reading);

            return (
              <button
                type="button"
                className={`metricCard ${key === selectedMetric ? "isActive" : ""}`}
                key={key}
                onClick={() => setSelectedMetric(key)}
              >
                <span>{toMetricLabel(key)}</span>
                <strong>{formatValue(reading.value)}</strong>
              </button>
            );
          })}
        </section>

        <section className="panel tablePanel">
          <div className="panelHeader compact">
            <div>
              <p className="eyebrow">History</p>
              <h2>Stored Readings</h2>
            </div>
          </div>
          <div className="tableScroll">
            <table className="recentTable">
              <thead>
                <tr>
                  <th>Fetch Time</th>
                  <th>Sensor Time</th>
                  <th>Source</th>
                  <th>Station</th>
                  <th>Metric</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {readings
                  .slice(-12)
                  .reverse()
                  .map((reading) => (
                    <tr key={reading.id}>
                      <td>{formatDateTime(reading.fetchedAt)}</td>
                      <td>{reading.readingTime || "-"}</td>
                      <td>{reading.sourceName || reading.sourceId || "-"}</td>
                      <td>{reading.stationId || "-"}</td>
                      <td>{toMetricLabel(reading.metric || readingMetricKey(reading))}</td>
                      <td>{formatValue(reading.value)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
