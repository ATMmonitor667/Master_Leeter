"use client";

import { useCallback, useEffect, useState } from "react";
import { listMicrophones, type VoiceStatus } from "../lib/voice-session";

/**
 * Voice controls (M3-2).
 *
 * Start, mute, and device selection. Deliberately small: the interviewer's
 * status indicator is a separate component, and nothing here reveals what the
 * interviewer is considering — showing "probe pending" would let the candidate
 * play the gate rather than the interview.
 *
 * Voice does not autostart. A microphone that opens itself on page load is
 * hostile, and the candidate should be able to read the workspace before
 * anything is listening.
 */

export interface VoiceControlsProps {
  status: VoiceStatus;
  muted: boolean;
  error: string | null;
  onStart: (deviceId?: string) => void;
  onStop: () => void;
  onToggleMute: () => void;
}

const LABEL: Record<VoiceStatus, string> = {
  IDLE: "Start voice",
  CONNECTING: "Connecting…",
  LISTENING: "Voice on",
  SPEAKING: "Voice on",
  FAILED: "Retry voice",
};

export function VoiceControls({
  status,
  muted,
  error,
  onStart,
  onStop,
  onToggleMute,
}: VoiceControlsProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");

  const live = status === "LISTENING" || status === "SPEAKING";

  const refreshDevices = useCallback(() => {
    // Labels are empty until permission has been granted once, so this is worth
    // re-running after start rather than only on mount.
    listMicrophones()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices, status]);

  return (
    <div className="voice-controls">
      {error && (
        <span className="voice-error" title={error}>
          {error}
        </span>
      )}

      {!live && devices.length > 1 && (
        <select
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          disabled={status === "CONNECTING"}
          className="voice-select"
          aria-label="Microphone"
        >
          <option value="">Default microphone</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || "Microphone"}
            </option>
          ))}
        </select>
      )}

      {live ? (
        <>
          <button
            onClick={onToggleMute}
            className="secondary-button"
            aria-pressed={muted}
          >
            <span className="button-icon" aria-hidden="true">{muted ? "◌" : "●"}</span>{muted ? "Unmute" : "Mute"}
          </button>
          <button onClick={onStop} className="ghost-button">
            End voice
          </button>
        </>
      ) : (
        <button
          onClick={() => onStart(deviceId || undefined)}
          disabled={status === "CONNECTING"}
          className="primary-button"
        >
          <span className="button-icon mic-icon" aria-hidden="true">●</span>{LABEL[status]}
        </button>
      )}
    </div>
  );
}
