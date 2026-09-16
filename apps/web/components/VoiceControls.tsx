"use client";

import { useCallback, useEffect, useState } from "react";
import { listMicrophones, type VoiceDeviceState, type VoiceStatus } from "../lib/voice-session";
import { VoicePreflight } from "./VoicePreflight";

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
  /** Devices reported by the live session; fresher than a local enumeration. */
  deviceState?: VoiceDeviceState | null | undefined;
  /** Swap the capture device mid-round without restarting the interview. */
  onSwitchDevice?: ((deviceId?: string) => void) | undefined;
  /** Route interviewer audio elsewhere. Hidden where the browser cannot. */
  onSwitchSpeaker?: ((deviceId?: string) => void) | undefined;
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
  deviceState,
  onSwitchDevice,
  onSwitchSpeaker,
}: VoiceControlsProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [preflightOpen, setPreflightOpen] = useState(false);

  const live = status === "LISTENING" || status === "SPEAKING";
  // While live the session is the authority on what is plugged in and which
  // device is actually carrying audio, including after an automatic recovery.
  const shownDevices = live && deviceState?.microphones.length ? deviceState.microphones : devices;
  const selected = live ? deviceState?.activeMicrophoneId ?? "" : deviceId;
  const speakers = deviceState?.speakers ?? [];
  const canRouteOutput = live && Boolean(deviceState?.canChooseSpeaker) && Boolean(onSwitchSpeaker);

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

      {shownDevices.length > 1 && (
        <select
          value={selected}
          onChange={(e) => {
            const next = e.target.value;
            // Switching during the round rebuilds only the capture graph: the
            // interview, the clock and the connection are untouched.
            if (live) onSwitchDevice?.(next || undefined);
            else setDeviceId(next);
          }}
          disabled={status === "CONNECTING" || (live && !onSwitchDevice)}
          className="voice-select"
          aria-label="Microphone"
        >
          <option value="">Default microphone</option>
          {shownDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || "Microphone"}
            </option>
          ))}
        </select>
      )}

      {canRouteOutput && speakers.length > 1 && (
        <select
          value={deviceState?.activeSpeakerId ?? ""}
          onChange={(e) => onSwitchSpeaker?.(e.target.value || undefined)}
          className="voice-select"
          aria-label="Speaker"
        >
          <option value="">Default speaker</option>
          {speakers.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || "Speaker"}
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
          onClick={() => setPreflightOpen(true)}
          disabled={status === "CONNECTING"}
          className="primary-button"
        >
          <span className="button-icon mic-icon" aria-hidden="true">●</span>{LABEL[status]}
        </button>
      )}
      {preflightOpen && (
        <VoicePreflight
          onCancel={() => setPreflightOpen(false)}
          onContinue={(selected) => {
            setPreflightOpen(false);
            onStart((selected ?? deviceId) || undefined);
          }}
        />
      )}
    </div>
  );
}
