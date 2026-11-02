import {
  ButtonItem,
  DropdownItem,
  Field,
  PanelSection,
  PanelSectionRow,
  SliderField,
  TextField,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useEffect, useState } from "react";
import { FaTint } from "react-icons/fa";

type Reading = {
  state: string;
  value: number | null;
  trend: string;
  ts: number | null;
  checked: number | null;
  message: string;
  history: [number, number][];
};

type Settings = {
  enabled: boolean;
  username: string;
  password: string;
  password_set: boolean;
  region: string;
  unit: string;
  low: number;
  high: number;
  window_hours: number;
};

const getSettings = callable<[], Settings>("get_settings");
const saveSettings = callable<[Settings], Reading>("save_settings");
const getReading = callable<[], Reading>("get_reading");
const refreshNow = callable<[], Reading>("refresh_now");
const forgetCredentials = callable<[], Reading>("forget_credentials");
const setWindowHours = callable<[number], number>("set_window_hours");

const ARROWS: Record<string, string> = {
  DoubleUp: "↑↑",
  SingleUp: "↑",
  FortyFiveUp: "↗",
  Flat: "→",
  FortyFiveDown: "↘",
  SingleDown: "↓",
  DoubleDown: "↓↓",
};

const STALE_MS = 15 * 60 * 1000;
const GAP_MS = 11 * 60 * 1000;
const WINDOWS = [3, 6, 12, 24];
const URGENT_LOW = 55;

const REGIONS = [
  { data: "us", label: "United States" },
  { data: "ous", label: "Outside US" },
  { data: "jp", label: "Japan" },
];
const UNITS = [
  { data: "mgdl", label: "mg/dL" },
  { data: "mmol", label: "mmol/L" },
];

function formatValue(value: number, unit: string): string {
  return unit === "mmol" ? (value / 18.0182).toFixed(1) : String(Math.round(value));
}

function ageText(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

function colorFor(value: number, low: number, high: number): string {
  if (value <= URGENT_LOW || value < low) return "#ff5252";
  if (value > high) return "#ffb300";
  return "#4caf50";
}

const STATE_MESSAGES: Record<string, string> = {
  idle: "Starting up...",
  disabled: "Turned off.",
  no_credentials: "Enter your Dexcom login below.",
};

function ReadingDisplay({
  reading,
  settings,
  now,
}: {
  reading: Reading | null;
  settings: Settings;
  now: number;
}) {
  if (!reading) return <div>Loading...</div>;

  const hasValue = reading.value !== null && reading.ts !== null;
  const age = hasValue ? Math.max(0, now - (reading.ts as number)) : 0;
  const stale = !hasValue || age > STALE_MS;

  let note = reading.message || STATE_MESSAGES[reading.state] || "";
  if (reading.state === "ok" && stale && hasValue) {
    note = "No recent data. Check the phone's connection to the sensor.";
  }

  return (
    <div style={{ textAlign: "center", width: "100%" }}>
      {hasValue ? (
        <>
          <div
            style={{
              fontSize: "52px",
              fontWeight: 700,
              lineHeight: 1.1,
              color: stale
                ? "#8a8f98"
                : colorFor(reading.value as number, settings.low, settings.high),
            }}
          >
            {formatValue(reading.value as number, settings.unit)}
            {!stale && (
              <span style={{ fontSize: "32px", marginLeft: "8px" }}>
                {ARROWS[reading.trend] ?? ""}
              </span>
            )}
          </div>
          <div style={{ fontSize: "13px", opacity: 0.75 }}>
            {settings.unit === "mmol" ? "mmol/L" : "mg/dL"} · {ageText(age)}
          </div>
        </>
      ) : (
        <div style={{ fontSize: "40px", fontWeight: 700, color: "#8a8f98" }}>--</div>
      )}
      {note && (
        <div style={{ fontSize: "12px", opacity: 0.8, marginTop: "6px" }}>{note}</div>
      )}
    </div>
  );
}

function TrendGraph({
  history,
  settings,
  now,
}: {
  history: [number, number][];
  settings: Settings;
  now: number;
}) {
  const W = 300;
  const H = 120;
  const L = 30;
  const R = 6;
  const T = 6;
  const B = 16;
  const hours = settings.window_hours;
  const start = now - hours * 3600000;
  const pts = (history || []).filter((p) => p[0] >= start);

  if (pts.length === 0) {
    return (
      <div style={{ textAlign: "center", fontSize: "12px", opacity: 0.7 }}>
        No graph data yet
      </div>
    );
  }

  const vals = pts.map((p) => p[1]);
  const yMin = Math.max(
    40,
    Math.floor((Math.min(Math.min(...vals), settings.low) - 10) / 10) * 10
  );
  const yMax = Math.min(
    400,
    Math.ceil((Math.max(Math.max(...vals), settings.high) + 20) / 10) * 10
  );
  const span = Math.max(1, now - start);
  const x = (t: number) => L + (Math.min(Math.max(t - start, 0), span) / span) * (W - L - R);
  const y = (v: number) =>
    T + (1 - (Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (H - T - B);

  // Break the line wherever readings are missing.
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  pts.forEach((p, i) => {
    if (i > 0 && p[0] - pts[i - 1][0] > GAP_MS) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  });
  segments.push(current);

  const radius = hours <= 6 ? 2.2 : hours <= 12 ? 1.6 : 1.1;
  const labelStyle = { fontSize: "9px", fill: "#9aa0a6" } as const;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <rect
        x={L}
        y={y(settings.high)}
        width={W - L - R}
        height={Math.max(0, y(settings.low) - y(settings.high))}
        fill="#4caf50"
        opacity={0.12}
      />
      {[settings.high, settings.low].map((v) => (
        <g key={v}>
          <line
            x1={L}
            x2={W - R}
            y1={y(v)}
            y2={y(v)}
            stroke="#4caf50"
            strokeOpacity={0.35}
            strokeDasharray="3 3"
          />
          <text x={L - 4} y={y(v) + 3} textAnchor="end" style={labelStyle}>
            {formatValue(v, settings.unit)}
          </text>
        </g>
      ))}
      {segments
        .filter((seg) => seg.length > 1)
        .map((seg, i) => (
          <polyline
            key={i}
            points={seg.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")}
            fill="none"
            stroke="#9aa0a6"
            strokeOpacity={0.5}
            strokeWidth={1.2}
          />
        ))}
      {pts.map((p) => (
        <circle
          key={p[0]}
          cx={x(p[0])}
          cy={y(p[1])}
          r={radius}
          fill={colorFor(p[1], settings.low, settings.high)}
        />
      ))}
      <text x={L} y={H - 3} textAnchor="start" style={labelStyle}>
        {`-${hours}h`}
      </text>
      <text x={W - R} y={H - 3} textAnchor="end" style={labelStyle}>
        now
      </text>
    </svg>
  );
}

// A row the controller can land on, so the D-pad can scroll back up to it.
function FocusStop({ children }: { children: any }) {
  return (
    <Field
      {...({
        focusable: true,
        onActivate: () => {},
        childrenLayout: "below",
        childrenContainerWidth: "max",
        bottomSeparator: "none",
      } as any)}
    >
      {children}
    </Field>
  );
}

function Content() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
    getReading().then(setReading).catch(() => {});
    const id = setInterval(() => {
      getReading().then(setReading).catch(() => {});
      setNow(Date.now());
    }, 15000);
    return () => clearInterval(id);
  }, []);

  if (!settings) {
    return (
      <PanelSection title="Glucose">
        <PanelSectionRow>Loading...</PanelSectionRow>
      </PanelSection>
    );
  }

  const update = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });

  const onSave = async () => {
    setBusy(true);
    try {
      setReading(await saveSettings(settings));
      setSettings(await getSettings());
      setNow(Date.now());
    } finally {
      setBusy(false);
    }
  };

  const onRefresh = async () => {
    setBusy(true);
    try {
      setReading(await refreshNow());
      setNow(Date.now());
    } finally {
      setBusy(false);
    }
  };

  const onForget = async () => {
    setBusy(true);
    try {
      setReading(await forgetCredentials());
      setSettings(await getSettings());
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelSection title="Glucose">
        <PanelSectionRow>
          <FocusStop>
            <ReadingDisplay reading={reading} settings={settings} now={now} />
          </FocusStop>
        </PanelSectionRow>
        <PanelSectionRow>
          <FocusStop>
            <TrendGraph history={reading?.history ?? []} settings={settings} now={now} />
          </FocusStop>
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Graph window"
            value={Math.max(0, WINDOWS.indexOf(settings.window_hours))}
            min={0}
            max={WINDOWS.length - 1}
            step={1}
            {...({
              notchCount: WINDOWS.length,
              notchLabels: WINDOWS.map((h, i) => ({ notchIndex: i, label: `${h}h`, value: i })),
              notchTicksVisible: true,
            } as any)}
            onChange={(i: number) => {
              const h = WINDOWS[i] ?? 3;
              update({ window_hours: h });
              setWindowHours(h).catch(() => {});
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={onRefresh}>
            Refresh
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Settings">
        <PanelSectionRow>
          <ToggleField
            label="Enabled"
            checked={settings.enabled}
            onChange={(v: boolean) => update({ enabled: v })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ paddingTop: "12px", width: "100%" }}>
            <TextField
              label="Dexcom username"
              value={settings.username}
              onChange={(e: any) => update({ username: e.target.value })}
            />
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label={settings.password_set ? "Password (saved)" : "Password"}
            bIsPassword
            value={settings.password}
            onChange={(e: any) => update({ password: e.target.value })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem
            label="Region"
            rgOptions={REGIONS}
            selectedOption={settings.region}
            onChange={(o: any) => update({ region: String(o?.data ?? o) })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem
            label="Units"
            rgOptions={UNITS}
            selectedOption={settings.unit}
            onChange={(o: any) => update({ unit: String(o?.data ?? o) })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Low threshold (mg/dL)"
            value={settings.low}
            min={60}
            max={100}
            step={5}
            showValue
            onChange={(v: number) => update({ low: v })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="High threshold (mg/dL)"
            value={settings.high}
            min={120}
            max={300}
            step={10}
            showValue
            onChange={(v: number) => update({ high: v })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={onSave}>
            Save
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={onForget}>
            Forget Credentials
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => ({
  name: "GlucoDeck",
  titleView: <div className={staticClasses.Title}>GlucoDeck</div>,
  content: <Content />,
  icon: <FaTint />,
  onDismount() {},
}));
