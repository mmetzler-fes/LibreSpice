import { Download, Play, Square, Volume2 } from "lucide-react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { useSourceFileStore } from "@store/sourceFileStore.js";
import { isWavName, isWaveLine, parseWaveDirective, signalFileKey } from "@core/audio/signalFile.js";
import { saveFile, togglePlayback, usePlayback } from "@simulation/audioPlayback.js";

/**
 * Play and save buttons for the files a `.wave` directive writes.
 *
 * Greyed out until a run has produced the file — the directive describes an
 * output, and before the simulation there is nothing to listen to.
 */
export function WaveLineActions({ line, size = "small" }: { line: string; size?: "small" | "normal" }) {
  const parsed = parseWaveDirective(line);
  const name = "error" in parsed ? "" : parsed.file;
  const status = useSimulationStore((s) => s.status);
  const output = useSourceFileStore((s) => (name ? s.outputs[signalFileKey(name)] : undefined));
  const playing = usePlayback((s) => s.playing);
  if (!name) return null;

  const ready = status === "done" && !!output;
  const playId = `output:${signalFileKey(name)}`;
  const isPlaying = playing === playId;
  const small = size === "small";
  const icon = small ? 9 : 12;
  const btn: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3,
    height: small ? 14 : 20, minWidth: small ? 18 : 22, marginLeft: 4, padding: small ? 0 : "0 5px",
    verticalAlign: "middle", fontSize: 11,
    border: "1px solid currentColor", borderRadius: 3, background: "transparent",
    color: ready ? "#2563eb" : "#94a3b8", cursor: ready ? "pointer" : "default",
    opacity: ready ? 1 : 0.6,
  };
  // The on-sheet box is draggable and opens the editor on double-click.
  const guard = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
  };

  return (
    <span style={{ marginLeft: small ? 6 : 2, whiteSpace: "nowrap" }}>
      {isWavName(name) && (
        <button
          type="button" {...guard} disabled={!ready} style={btn}
          title={ready ? (isPlaying ? "Wiedergabe stoppen" : `${name} anhören`) : `${name}: erst simulieren`}
          onClick={() => output && void togglePlayback(playId, output.samples, output.sampleRate)}
        >
          {isPlaying ? <Square size={icon} /> : <Play size={icon} />}
        </button>
      )}
      <button
        type="button" {...guard} disabled={!ready} style={btn}
        title={ready ? `${name} speichern` : `${name}: erst simulieren`}
        onClick={() => output && void saveFile(output.name, output.bytes, output.mime)}
      >
        <Download size={icon} />
      </button>
    </span>
  );
}

/** Every `.wave` output of the circuit with its buttons; nothing when there is none. */
export function WaveOutputBar({ color = "#64748b" }: { color?: string }) {
  const directives = useCircuitStore((s) => s.spiceDirectives);
  const lines = directives.split(/\r?\n/).filter(isWaveLine);
  if (lines.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 11, color, minWidth: 0, overflow: "hidden" }}>
      {lines.map((l, i) => {
        const p = parseWaveDirective(l);
        return (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={l.trim()}>
            <Volume2 size={13} />
            {"error" in p ? <span style={{ color: "#dc2626" }}>.wave: {p.error}</span> : p.file}
            <WaveLineActions line={l} size="normal" />
          </span>
        );
      })}
    </span>
  );
}
