"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dialogs from "./Dialogs.module.css";
import { listMicrophones } from "../lib/voice-session";
import { useDialogFocus } from "../lib/use-dialog-focus";

export function VoicePreflight({
  onCancel,
  onContinue,
}: {
  onCancel: () => void;
  onContinue: (deviceId?: string) => void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [micReady, setMicReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const speakerRef = useRef<AudioContext | null>(null);
  const requestRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const dialogRef = useDialogFocus<HTMLDialogElement>(true, onCancel);

  const browserReady =
    typeof window !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof WebSocket !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined";

  const stopMeter = useCallback(() => {
    requestRef.current++;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    setLevel(0);
  }, []);

  useEffect(
    () => () => {
      stopMeter();
      void speakerRef.current?.close().catch(() => {});
    },
    [stopMeter],
  );

  const checkMicrophone = useCallback(
    async (selected = deviceId) => {
      stopMeter();
      const request = requestRef.current;
      setChecking(true);
      setMicReady(false);
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(selected ? { deviceId: { exact: selected } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (!alive.current || request !== requestRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const context = new AudioContext();
        contextRef.current = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        setMicReady(true);
        setDevices(await listMicrophones());
        if (!alive.current || request !== requestRef.current) return;

        const measure = () => {
          analyser.getByteTimeDomainData(samples);
          let peak = 0;
          for (const sample of samples)
            peak = Math.max(peak, Math.abs(sample - 128));
          setLevel(Math.min(1, peak / 48));
          frameRef.current = requestAnimationFrame(measure);
        };
        measure();
      } catch (err) {
        if (!alive.current || request !== requestRef.current) return;
        stopMeter();
        setMicReady(false);
        setChecking(false);
        const name = (err as DOMException).name;
        setError(
          name === "NotAllowedError"
            ? "Microphone permission was blocked. Allow it in your browser site settings, then retry."
            : "The selected microphone could not be opened. Choose another device and retry.",
        );
      } finally {
        if (alive.current && request === requestRef.current) setChecking(false);
      }
    },
    [deviceId, stopMeter],
  );

  const testSpeaker = useCallback(async () => {
    try {
      await speakerRef.current?.close().catch(() => {});
      if (!alive.current) return;
      const context = new AudioContext();
      speakerRef.current = context;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 523.25;
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(0.055, context.currentTime + 0.1);
      gain.gain.linearRampToValueAtTime(0, context.currentTime + 2);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 2);
      oscillator.onended = () => void context.close().catch(() => {});
    } catch {
      setError(
        "Speaker test could not play. Check browser audio permissions and output volume.",
      );
    }
  }, []);

  const continueToInterview = useCallback(() => {
    if (!micReady || !browserReady) return;
    stopMeter();
    onContinue(deviceId || undefined);
  }, [browserReady, deviceId, micReady, onContinue, stopMeter]);

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      className={dialogs.dialog}
      aria-labelledby="preflight-title"
    >
      <span className="dialog-kicker">Voice check</span>
      <h2 id="preflight-title">Check your microphone and speaker</h2>
      <p>
        Your interview starts only after voice connects and the opening brief
        finishes.
      </p>

      <div className="preflight-checks">
        <div className={`preflight-row${browserReady ? " ready" : " failed"}`}>
          <span>{browserReady ? "✓" : "!"}</span>
          <div>
            <strong>Browser audio</strong>
            <small>
              {browserReady
                ? "Realtime audio is supported."
                : "Use a current version of Chrome or Edge."}
            </small>
          </div>
        </div>

        <div className={`preflight-row${micReady ? " ready" : ""}`}>
          <span>{micReady ? "✓" : "2"}</span>
          <div className="preflight-device">
            <strong>Microphone</strong>
            {devices.length > 1 && (
              <select
                value={deviceId}
                onChange={(event) => {
                  setDeviceId(event.target.value);
                  void checkMicrophone(event.target.value);
                }}
                aria-label="Microphone for interview"
              >
                <option value="">Default microphone</option>
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || "Microphone"}
                  </option>
                ))}
              </select>
            )}
            <div
              className="mic-meter"
              role="meter"
              aria-label="Microphone input level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
            >
              <span style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void checkMicrophone()}
              disabled={!browserReady || checking}
            >
              {checking
                ? "Checking…"
                : micReady
                  ? "Retry microphone"
                  : "Allow microphone"}
            </button>
          </div>
        </div>

        <div className="preflight-row">
          <span>3</span>
          <div>
            <strong>Speaker</strong>
            <small>Play a short tone and confirm you can hear it.</small>
            <button
              className="secondary-button"
              type="button"
              onClick={testSpeaker}
            >
              Play test tone
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="preflight-error" role="alert">
          {error}
        </p>
      )}
      <p className="preflight-help">
        If a device disconnects during the interview, reconnect it and use Retry
        voice. Saved code, notes, and interview time remain on the server.
      </p>

      <div className="dialog-actions">
        <button
          data-autofocus
          className="secondary-button"
          type="button"
          onClick={() => {
            stopMeter();
            onCancel();
          }}
        >
          Cancel
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={continueToInterview}
          disabled={!browserReady || !micReady}
        >
          Start interview voice
        </button>
      </div>
    </dialog>
  );
}
