import { useEffect, useRef, useState } from "react";

// Resolve WebSocket endpoint
// - In production on Vercel, host a dedicated WS relay and expose it as NEXT_PUBLIC_WS_URL (e.g., wss://your-relay.example.com/ws)
// - In local dev, fall back to same-origin Next.js API route /api/ws
const WS_ENDPOINT = typeof window !== "undefined"
  ? (process.env.NEXT_PUBLIC_WS_URL
      || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`)
  : "";

export default function Home() {
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [roleStatus, setRoleStatus] = useState({ desktop: false, web: false });
  const [micEnabled, setMicEnabled] = useState(false);
  const [log, setLog] = useState([]);
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  // Touch/gesture refs
  const lastTapTimeRef = useRef(0);
  const touchStartRef = useRef({ x: 0, y: 0, t: 0, isDown: false });
  const micSourceRef = useRef(null);
  const rafRef = useRef(null);
  const lastKnockTimeRef = useRef(0);
  const pendingKnockRef = useRef(false);
  const knockTimerRef = useRef(null);
  const singleTapTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      disconnectWS();
      stopMic();
    };
  }, []);

  function addLog(msg) {
    setLog((l) => [msg, ...l].slice(0, 100));
  }

  async function connectWS() {
    if (!token) {
      alert("Please enter a token");
      return;
    }
    try {
      // If we're using the same-origin API route, ping it first so its WS server initializes
      if (!process.env.NEXT_PUBLIC_WS_URL) {
        try { await fetch("/api/ws"); } catch {}
      }
      const url = `${WS_ENDPOINT}${WS_ENDPOINT.includes('?') ? '&' : '/?'}token=${encodeURIComponent(token)}&role=web`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        addLog("WebSocket connected");
      };
      ws.onclose = () => {
        setConnected(false);
        setRoleStatus({ desktop: false, web: false });
        addLog("WebSocket disconnected");
      };
      ws.onerror = (e) => {
        addLog("WebSocket error");
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "status") {
            setRoleStatus({ desktop: !!data.desktop, web: !!data.web });
          } else if (data.type === "signal") {
            addLog(`Received ${data.name}`);
          } else if (data.type === "connected") {
            addLog(`Server acknowledged connection as ${data.role}`);
          } else if (data.type === "error") {
            addLog(`Server error: ${data.message}`);
          }
        } catch {}
      };
    } catch (e) {
      addLog("Failed to connect");
    }
  }

  function disconnectWS() {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
  }

  function sendSignal(name) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", name }));
      addLog(`Sent ${name}`);
    } else {
      addLog("Cannot send, not connected");
    }
  }

  // Gesture helpers
  function onTouchStart(e) {
    const t = e.touches ? e.touches[0] : e;
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: performance.now(), isDown: true };
  }

  function onTouchEnd(e) {
    const start = touchStartRef.current;
    touchStartRef.current.isDown = false;
    const now = performance.now();

    let endX, endY;
    if (e.changedTouches && e.changedTouches[0]) {
      endX = e.changedTouches[0].clientX;
      endY = e.changedTouches[0].clientY;
    } else if (e.clientX != null) {
      endX = e.clientX; endY = e.clientY;
    } else {
      return;
    }

    const dx = endX - start.x;
    const dy = endY - start.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Detect horizontal swipe first
    const SWIPE_DIST = 60;
    const SWIPE_RATIO = 2; // horizontal dominance
    if (absDx > SWIPE_DIST && absDx > SWIPE_RATIO * absDy) {
      // Right swipe => Next, Left swipe => Previous
      if (dx > 0) sendSignal("signal-1"); else sendSignal("signal-2");
      // Cancel tap detection timer if any
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastTapTimeRef.current = 0;
      return;
    }

    // Tap / Double-tap
    const TAP_WINDOW = 300; // ms
    if (now - lastTapTimeRef.current < TAP_WINDOW) {
      // Double tap => Previous
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastTapTimeRef.current = 0;
      sendSignal("signal-2");
    } else {
      lastTapTimeRef.current = now;
      // Single tap delayed until we know it's not a double tap
      singleTapTimerRef.current = setTimeout(() => {
        sendSignal("signal-1");
        singleTapTimerRef.current = null;
      }, TAP_WINDOW);
    }
  }

  async function startMic() {
    if (micEnabled) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      micSourceRef.current = source;
      analyserRef.current = analyser;
      setMicEnabled(true);
      addLog("Microphone enabled");
      loopDetect();
    } catch (e) {
      addLog("Microphone access denied");
    }
  }

  function stopMic() {
    setMicEnabled(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    if (knockTimerRef.current) {
      clearTimeout(knockTimerRef.current);
      knockTimerRef.current = null;
    }
  }

  function loopDetect() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const detect = () => {
      analyser.getByteTimeDomainData(data);
      // Simple energy/peak detection on time-domain signal
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128; // normalize -1..1
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);

      const THRESH = 0.2; // adjust if needed
      const NOW = performance.now();

      if (rms > THRESH) {
        if (!pendingKnockRef.current) {
          pendingKnockRef.current = true; // first knock in a possible series
          if (knockTimerRef.current) clearTimeout(knockTimerRef.current);
          knockTimerRef.current = setTimeout(() => {
            // Single knock timeout reached -> treat as 1 knock
            pendingKnockRef.current = false;
            sendSignal("signal-1");
          }, 250); // short window to avoid counting the same hit twice
          lastKnockTimeRef.current = NOW;
        } else {
          // A second peak detected while pending -> double knock
          const delta = NOW - lastKnockTimeRef.current;
          if (delta <= 1000) {
            if (knockTimerRef.current) {
              clearTimeout(knockTimerRef.current);
              knockTimerRef.current = null;
            }
            pendingKnockRef.current = false;
            sendSignal("signal-2");
          }
          lastKnockTimeRef.current = NOW;
        }
      }

      rafRef.current = requestAnimationFrame(detect);
    };
    rafRef.current = requestAnimationFrame(detect);
  }

  return (
    <div className="min-h-screen p-6 flex flex-col items-center gap-6">
      <h1 className="text-2xl font-semibold">Web Knock Controller</h1>

      {/* Top controls */}
      <div className="w-full max-w-md space-y-3">
        <label className="block text-sm font-medium">Token</label>
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Enter token from desktop app"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="flex items-center gap-2">
          {!connected ? (
            <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={connectWS}>Connect</button>
          ) : (
            <button className="px-4 py-2 bg-gray-600 text-white rounded" onClick={disconnectWS}>Disconnect</button>
          )}
          {!micEnabled ? (
            <button className="px-4 py-2 bg-green-600 text-white rounded" onClick={startMic}>Enable Mic</button>
          ) : (
            <button className="px-4 py-2 bg-yellow-600 text-white rounded" onClick={stopMic}>Disable Mic</button>
          )}
        </div>
      </div>

      {/* Status line */}
      <div className="w-full max-w-md space-y-2">
        <div className="text-sm">Status: {connected ? "Connected" : "Disconnected"}</div>
        <div className="text-sm">Desktop joined: {roleStatus.desktop ? "Yes" : "No"}</div>
        <div className="text-sm">Website joined: {roleStatus.web ? "Yes" : "No"}</div>
      </div>

      {/* Touch pad shown only when connected */}
      {connected && (
        <div
          className="w-full max-w-3xl flex-1 min-h-[300px] border-2 border-dashed rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center select-none"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onMouseDown={onTouchStart}
          onMouseUp={onTouchEnd}
        >
          <div className="text-center text-sm opacity-70">
            <div>single tap / right swipe = Next</div>
            <div>double tap / left swipe = Previous</div>
          </div>
        </div>
      )}

      {/* Manual + Logs only when not connected (to keep UI minimal when connected) */}
      {!connected && (
        <>
          <div className="w-full max-w-md space-y-2">
            <div className="text-sm font-medium">Manual Test</div>
            <div className="flex gap-2">
              <button className="px-3 py-2 border rounded" onClick={() => sendSignal("signal-1")}>Send signal-1 (Next)</button>
              <button className="px-3 py-2 border rounded" onClick={() => sendSignal("signal-2")}>Send signal-2 (Previous)</button>
            </div>
          </div>

          <div className="w-full max-w-md">
            <div className="text-sm font-medium mb-2">Logs</div>
            <div className="h-48 overflow-auto border rounded p-2 text-xs bg-gray-50">
              {log.map((line, idx) => (
                <div key={idx}>{line}</div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
